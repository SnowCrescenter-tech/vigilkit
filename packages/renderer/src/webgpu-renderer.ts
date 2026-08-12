import type { RendererSurface } from 'vigilkit';

/**
 * Fullscreen triangle from `@builtin(vertex_index)`: 3 vertices covering the
 * clip volume (triangle-strip topology). UVs are computed from the vertex
 * position; the fragment stage flips V because `texture_external` has an
 * inverted V origin relative to WebGL2, matching the WebGL2 renderer's
 * orientation (first row of the video on top).
 */
const SHADER_CODE = `
struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VsOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: VsOut;
  out.position = vec4<f32>(positions[index], 0.0, 1.0);
  out.uv = positions[index] * 0.5 + 0.5;
  return out;
}

@group(0) @binding(0) var tex: texture_external;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, vec2<f32>(in.uv.x, 1.0 - in.uv.y));
}
`;

interface PipelineResources {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly sampler: GPUSampler;
}

export interface WebGPURendererOptions {
  /** Canvas format source; defaults to `navigator.gpu.getPreferredCanvasFormat()`. */
  getPreferredFormat?: () => GPUTextureFormat;
  /** Called with the loss info when `device.lost` settles; drawing stops. */
  onLost?: (info: GPUDeviceLostInfo) => void;
}

/**
 * Zero-copy VideoFrame renderer: frames are imported as `texture_external`
 * (no CPU readback) and sampled in a fullscreen pass. The bind group must be
 * rebuilt per frame because external textures are single-use.
 */
export class WebGPURenderer implements RendererSurface {
  readonly renderMode = 'webgpu' as const;

  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly onLost: ((info: GPUDeviceLostInfo) => void) | undefined;
  private readonly format: GPUTextureFormat;
  private pipelineResources: PipelineResources | null = null;
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    options: WebGPURendererOptions = {},
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.onLost = options.onLost;
    this.format = (options.getPreferredFormat ?? (() => navigator.gpu.getPreferredCanvasFormat()))();
    context.configure({ device, format: this.format, alphaMode: 'opaque' });
    device.lost.then(
      (info) => {
        this.destroyed = true;
        this.onLost?.(info);
      },
      () => {
        this.destroyed = true;
      },
    );
  }

  draw(frame: VideoFrame): void {
    if (this.destroyed) {
      frame.close();
      return;
    }
    try {
      const { pipeline, bindGroupLayout, sampler } = this.ensurePipeline();
      const texture = this.device.importExternalTexture({ source: frame });
      const bindGroup = this.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: texture },
          { binding: 1, resource: sampler },
        ],
      });
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } finally {
      frame.close();
    }
  }

  resize(): void {
    if (this.destroyed) return;
    const dpr = globalThis.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Pipeline, bind group layout and sampler are device-owned and GC-able;
    // @webgpu/types exposes destroy() only on buffer/device/querySet/texture,
    // so dropping the references is the disposal contract here.
    this.pipelineResources = null;
  }

  private ensurePipeline(): PipelineResources {
    if (this.pipelineResources === null) {
      this.pipelineResources = this.createPipeline();
    }
    return this.pipelineResources;
  }

  private createPipeline(): PipelineResources {
    const shaderModule = this.device.createShaderModule({ code: SHADER_CODE });
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          // GPUShaderStage.FRAGMENT (0x2) 鈥?literal so the module runs in
          // environments where the WebGPU runtime global is absent.
          visibility: 0x2,
          texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
        },
        { binding: 1, visibility: 0x2, sampler: { type: 'filtering' } },
      ],
    });
    const pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-strip' },
    });
    const sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    return { pipeline, bindGroupLayout, sampler };
  }
}

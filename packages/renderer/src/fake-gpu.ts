import { vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * Test double for the WebGPU surface the renderer touches. Records every call
 * as a vitest mock so tests can assert renderer behavior without a real GPU.
 * The `lost` promise carries manual resolve/reject handles so tests can
 * simulate device loss deterministically.
 */
export interface FakeGPUContext {
  readonly configure: Mock;
  readonly getCurrentTexture: Mock;
}

export interface FakeGPUDevice {
  readonly lost: Promise<GPUDeviceLostInfo>;
  readonly importExternalTexture: Mock;
  readonly createShaderModule: Mock;
  readonly createBindGroupLayout: Mock;
  readonly createPipelineLayout: Mock;
  readonly createRenderPipeline: Mock;
  readonly createBindGroup: Mock;
  readonly createSampler: Mock;
  readonly createCommandEncoder: Mock;
  readonly queue: { readonly submit: Mock };
  readonly destroy: Mock;
}

export interface FakeGpu {
  readonly navigatorGpu: {
    readonly getPreferredCanvasFormat: Mock;
    readonly requestAdapter: Mock;
  };
  readonly adapter: { readonly requestDevice: Mock };
  readonly device: FakeGPUDevice;
  readonly context: FakeGPUContext;
  readonly pass: {
    readonly setPipeline: Mock;
    readonly setBindGroup: Mock;
    readonly draw: Mock;
    readonly end: Mock;
  };
  readonly encoder: { readonly beginRenderPass: Mock; readonly finish: Mock };
  /** Every bind group the renderer built, in order. */
  readonly bindGroups: Array<{
    layout: unknown;
    entries: Array<{ binding: number; resource: unknown }>;
  }>;
  /** binding-0 resource of every bind group (the imported texture), in order. */
  readonly bindGroupResources: Array<unknown>;
  /** Every `{ source }` descriptor passed to importExternalTexture, in order. */
  readonly importedTextures: Array<{ source: unknown }>;
  /** Every object importExternalTexture returned, in order. */
  readonly importedTextureObjects: Array<unknown>;
  /** Every WGSL source passed to createShaderModule, in order. */
  readonly shaderModuleCodes: Array<string>;
  resolveLost(info: GPUDeviceLostInfo): void;
  rejectLost(reason: unknown): void;
}

export function createFakeGpu(): FakeGpu {
  let resolveLost!: (info: GPUDeviceLostInfo) => void;
  let rejectLost!: (reason: unknown) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve, reject) => {
    resolveLost = resolve;
    rejectLost = reject;
  });

  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const encoder = {
    beginRenderPass: vi.fn(() => pass),
    finish: vi.fn(() => ({})),
  };
  const bindGroups: FakeGpu['bindGroups'] = [];
  const bindGroupResources: Array<unknown> = [];
  const importedTextures: Array<{ source: unknown }> = [];
  const importedTextureObjects: Array<unknown> = [];
  const shaderModuleCodes: Array<string> = [];

  const device: FakeGPUDevice = {
    lost,
    importExternalTexture: vi.fn((desc: { source: unknown }) => {
      importedTextures.push(desc);
      const texture = {};
      importedTextureObjects.push(texture);
      return texture;
    }),
    createShaderModule: vi.fn((desc: { code: string }) => {
      shaderModuleCodes.push(desc.code);
      return {};
    }),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createBindGroup: vi.fn(
      (desc: {
        layout: unknown;
        entries: Array<{ binding: number; resource: unknown }>;
      }) => {
        bindGroups.push(desc);
        for (const entry of desc.entries) {
          if (entry.binding === 0) bindGroupResources.push(entry.resource);
        }
        return {};
      },
    ),
    createSampler: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => encoder),
    queue: { submit: vi.fn() },
    destroy: vi.fn(),
  };
  const context: FakeGPUContext = {
    configure: vi.fn(),
    getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
  };
  const adapter = { requestDevice: vi.fn(async () => device) };
  const navigatorGpu = {
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm' as GPUTextureFormat),
    requestAdapter: vi.fn(async () => adapter),
  };

  return {
    navigatorGpu,
    adapter,
    device,
    context,
    pass,
    encoder,
    bindGroups,
    bindGroupResources,
    importedTextures,
    importedTextureObjects,
    shaderModuleCodes,
    resolveLost,
    rejectLost,
  };
}

import { describe, expect, it, vi } from 'vitest';
import { WebGPURenderer } from './webgpu-renderer';
import { createFakeGpu, type FakeGpu } from './fake-gpu';
import { createFakeCanvas, FakeVideoFrame, toFrame, type FakeCanvas } from './fake-gl';

const FORMAT: GPUTextureFormat = 'bgra8unorm';

function makeRenderer(
  onLost?: (info: GPUDeviceLostInfo) => void,
): { fake: FakeGpu; renderer: WebGPURenderer; canvas: FakeCanvas } {
  const fake = createFakeGpu();
  const canvas = createFakeCanvas(null);
  const renderer = new WebGPURenderer(
    canvas,
    fake.device as unknown as GPUDevice,
    fake.context as unknown as GPUCanvasContext,
    { getPreferredFormat: () => FORMAT, onLost },
  );
  return { fake, renderer, canvas };
}

describe('WebGPURenderer', () => {
  it('reports webgpu mode and configures the canvas with device and preferred format', () => {
    const { fake, renderer } = makeRenderer();

    expect(renderer.renderMode).toBe('webgpu');
    expect(fake.context.configure).toHaveBeenCalledWith({
      device: fake.device,
      format: FORMAT,
      alphaMode: 'opaque',
    });
  });

  it('does not create GPU resources until the first draw', () => {
    const { fake } = makeRenderer();

    expect(fake.device.createShaderModule).not.toHaveBeenCalled();
    expect(fake.device.createRenderPipeline).not.toHaveBeenCalled();
  });

  it('draws a fullscreen triangle from the imported external texture and closes the frame', () => {
    const { fake, renderer } = makeRenderer();
    const frame = new FakeVideoFrame();

    renderer.draw(toFrame(frame));

    expect(fake.device.importExternalTexture).toHaveBeenCalledWith({ source: frame });
    expect(fake.device.createShaderModule).toHaveBeenCalledTimes(1);
    expect(fake.device.createRenderPipeline).toHaveBeenCalledTimes(1);
    expect(fake.device.createCommandEncoder).toHaveBeenCalledTimes(1);
    expect(fake.pass.draw).toHaveBeenCalledWith(3);
    expect(fake.device.queue.submit).toHaveBeenCalledTimes(1);
    expect(frame.closed).toBe(true);
  });

  it('compiles a WGSL module with a texture_external sampled in the fragment stage', () => {
    const { fake, renderer } = makeRenderer();

    renderer.draw(toFrame(new FakeVideoFrame()));

    expect(fake.shaderModuleCodes).toHaveLength(1);
    const code = fake.shaderModuleCodes[0];
    expect(code).toContain('texture_external');
    expect(code).toContain('textureSample');
  });

  it('rebuilds the bind group per frame because external textures are single-use', () => {
    const { fake, renderer } = makeRenderer();
    const frame1 = new FakeVideoFrame();
    const frame2 = new FakeVideoFrame();

    renderer.draw(toFrame(frame1));
    renderer.draw(toFrame(frame2));

    expect(fake.importedTextures).toHaveLength(2);
    expect(fake.bindGroups).toHaveLength(2);
    expect(fake.bindGroupResources[0]).toBe(fake.importedTextureObjects[0]);
    expect(fake.bindGroupResources[1]).toBe(fake.importedTextureObjects[1]);
    expect(fake.importedTextureObjects[0]).not.toBe(fake.importedTextureObjects[1]);
  });

  it('destroys idempotently and stops drawing afterwards', () => {
    const { fake, renderer } = makeRenderer();

    renderer.destroy();
    expect(() => renderer.destroy()).not.toThrow();
    const frame = new FakeVideoFrame();
    renderer.draw(toFrame(frame));

    expect(frame.closed).toBe(true);
    expect(fake.device.importExternalTexture).not.toHaveBeenCalled();
    expect(fake.device.queue.submit).not.toHaveBeenCalled();
  });

  it('resizes the canvas backing store to client size times devicePixelRatio', () => {
    const { renderer, canvas } = makeRenderer();
    vi.stubGlobal('devicePixelRatio', 2);

    renderer.resize();
    vi.unstubAllGlobals();

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
  });

  it('stops submitting and closes frames once the device is lost', async () => {
    const onLost = vi.fn();
    const { fake, renderer } = makeRenderer(onLost);

    fake.resolveLost({ reason: 'destroyed', message: 'gone' } as GPUDeviceLostInfo);
    await Promise.resolve();
    await Promise.resolve();

    expect(onLost).toHaveBeenCalledWith({
      reason: 'destroyed',
      message: 'gone',
    });
    const frame = new FakeVideoFrame();
    renderer.draw(toFrame(frame));
    expect(frame.closed).toBe(true);
    expect(fake.device.queue.submit).not.toHaveBeenCalled();
  });

  it('stops submitting when the device lost promise rejects', async () => {
    const { fake, renderer } = makeRenderer();

    fake.rejectLost('adapter destroyed');
    await Promise.resolve();
    await Promise.resolve();

    const frame = new FakeVideoFrame();
    renderer.draw(toFrame(frame));
    expect(frame.closed).toBe(true);
    expect(fake.device.queue.submit).not.toHaveBeenCalled();
  });
});

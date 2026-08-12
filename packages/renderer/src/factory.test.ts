import { describe, expect, it, vi } from 'vitest';
import { createRenderer, createRendererAsync } from './factory';
import { RendererError } from './errors';
import { FakeVideoFrame, createFakeCanvas, createFakeGL, toFrame } from './fake-gl';
import { createFakeGpu } from './fake-gpu';

describe('createRenderer', () => {
  it('returns a webgl2 renderer when the canvas supports webgl2', () => {
    const gl = createFakeGL();
    const canvas = createFakeCanvas(gl);

    const renderer = createRenderer(canvas);

    expect(renderer.renderMode).toBe('webgl2');
    expect(canvas._getContextMock).toHaveBeenCalledWith('webgl2');
  });

  it('falls back to a canvas2d renderer when webgl2 is unavailable', () => {
    const ctx2d = { drawImage: vi.fn() };
    const canvas = createFakeCanvas(null, ctx2d);
    const renderer = createRenderer(canvas);
    const frame = new FakeVideoFrame();

    renderer.draw(toFrame(frame));

    expect(renderer.renderMode).toBe('canvas2d');
    expect(ctx2d.drawImage).toHaveBeenCalledWith(frame, 0, 0, 0, 0);
    expect(frame.closed).toBe(true);
  });

  it('throws RendererError when neither webgl2 nor canvas2d is available', () => {
    const canvas = createFakeCanvas(null, null);

    expect(() => createRenderer(canvas)).toThrow(RendererError);
    expect(() => createRenderer(canvas)).toThrow('no renderer available');
  });
});

describe('createRendererAsync', () => {
  it('falls back to webgl2 when no WebGPU entry point exists', async () => {
    const gl = createFakeGL();
    const canvas = createFakeCanvas(gl);

    const renderer = await createRendererAsync(canvas);

    expect(renderer.renderMode).toBe('webgl2');
    expect(canvas._getContextMock).not.toHaveBeenCalledWith('webgpu');
  });

  it('uses webgpu in auto mode when gpu is present and the canvas accepts a webgpu context', async () => {
    const fake = createFakeGpu();
    const canvas = createFakeCanvas(null, null, fake.context);

    const renderer = await createRendererAsync(canvas, {
      gpu: fake.navigatorGpu as unknown as GPU,
    });

    expect(renderer.renderMode).toBe('webgpu');
    expect(fake.navigatorGpu.requestAdapter).toHaveBeenCalled();
    expect(fake.adapter.requestDevice).toHaveBeenCalled();
    expect(canvas._getContextMock).toHaveBeenCalledWith('webgpu');
    expect(fake.context.configure).toHaveBeenCalledWith({
      device: fake.device,
      format: 'bgra8unorm',
      alphaMode: 'opaque',
    });
  });

  it('auto falls back to webgl2 when the canvas lacks a webgpu context', async () => {
    const fake = createFakeGpu();
    const canvas = createFakeCanvas(createFakeGL());

    const renderer = await createRendererAsync(canvas, {
      gpu: fake.navigatorGpu as unknown as GPU,
    });

    expect(renderer.renderMode).toBe('webgl2');
  });

  it('forces webgl2 when preferred, without touching WebGPU', async () => {
    const fake = createFakeGpu();
    const canvas = createFakeCanvas(createFakeGL(), null, fake.context);

    const renderer = await createRendererAsync(canvas, {
      prefer: 'webgl2',
      gpu: fake.navigatorGpu as unknown as GPU,
    });

    expect(renderer.renderMode).toBe('webgl2');
    expect(fake.navigatorGpu.requestAdapter).not.toHaveBeenCalled();
  });

  it('creates a canvas2d renderer when preferred', async () => {
    const ctx2d = { drawImage: vi.fn() };
    const canvas = createFakeCanvas(null, ctx2d);

    const renderer = await createRendererAsync(canvas, { prefer: 'canvas2d' });

    expect(renderer.renderMode).toBe('canvas2d');
  });

  it('throws when webgpu is explicitly requested but unavailable', async () => {
    const canvas = createFakeCanvas(createFakeGL());

    await expect(createRendererAsync(canvas, { prefer: 'webgpu' })).rejects.toThrow(
      RendererError,
    );
    await expect(createRendererAsync(canvas, { prefer: 'webgpu' })).rejects.toThrow(
      'webgpu unavailable',
    );
  });

  it('throws when webgpu is preferred but the canvas rejects a webgpu context', async () => {
    const fake = createFakeGpu();
    const canvas = createFakeCanvas(null);

    await expect(
      createRendererAsync(canvas, { prefer: 'webgpu', gpu: fake.navigatorGpu as unknown as GPU }),
    ).rejects.toThrow(RendererError);
  });

  it('throws when nothing is available in auto mode', async () => {
    const canvas = createFakeCanvas(null, null);

    await expect(createRendererAsync(canvas)).rejects.toThrow('no renderer available');
  });
});

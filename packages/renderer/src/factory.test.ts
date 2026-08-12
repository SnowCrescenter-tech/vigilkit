import { describe, expect, it, vi } from 'vitest';
import { createRenderer } from './factory';
import { RendererError } from './errors';
import { FakeVideoFrame, createFakeCanvas, createFakeGL, toFrame } from './fake-gl';

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

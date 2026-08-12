import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Canvas2DRenderer } from './canvas2d-renderer';
import { RendererError } from './errors';
import { FakeVideoFrame, createFakeCanvas, toFrame } from './fake-gl';

function create2dContext(): { drawImage: ReturnType<typeof vi.fn> } {
  return { drawImage: vi.fn() };
}

describe('Canvas2DRenderer', () => {
  beforeEach(() => {
    vi.stubGlobal('devicePixelRatio', 1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes renderMode canvas2d when constructed with a 2d context', () => {
    const canvas = createFakeCanvas(null, create2dContext());

    const renderer = new Canvas2DRenderer(canvas);

    expect(renderer.renderMode).toBe('canvas2d');
  });

  it('throws RendererError when a 2d context is unavailable', () => {
    const canvas = createFakeCanvas(null, null);

    expect(() => new Canvas2DRenderer(canvas)).toThrow(RendererError);
    expect(() => new Canvas2DRenderer(canvas)).toThrow('canvas2d unavailable');
  });

  it('draws the frame stretched to the canvas and closes it', () => {
    const ctx2d = create2dContext();
    const canvas = createFakeCanvas(null, ctx2d);
    canvas.width = 320;
    canvas.height = 180;
    const renderer = new Canvas2DRenderer(canvas);
    const frame = new FakeVideoFrame();

    renderer.draw(toFrame(frame));

    expect(ctx2d.drawImage).toHaveBeenCalledWith(frame, 0, 0, 320, 180);
    expect(frame.closed).toBe(true);
  });

  it('closes the frame even when drawImage throws', () => {
    const ctx2d = create2dContext();
    const canvas = createFakeCanvas(null, ctx2d);
    const renderer = new Canvas2DRenderer(canvas);
    const frame = new FakeVideoFrame();
    ctx2d.drawImage.mockImplementation(() => {
      throw new Error('draw failed');
    });

    expect(() => renderer.draw(toFrame(frame))).toThrow('draw failed');
    expect(frame.closed).toBe(true);
  });

  it('sizes the backing store from client size x devicePixelRatio', () => {
    const canvas = createFakeCanvas(null, create2dContext());
    const renderer = new Canvas2DRenderer(canvas);
    vi.stubGlobal('devicePixelRatio', 2);

    renderer.resize();

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
  });

  it('makes draws after destroy no-ops that still close the frame', () => {
    const ctx2d = create2dContext();
    const canvas = createFakeCanvas(null, ctx2d);
    const renderer = new Canvas2DRenderer(canvas);

    renderer.destroy();

    const frame = new FakeVideoFrame();
    renderer.draw(toFrame(frame));
    expect(ctx2d.drawImage).not.toHaveBeenCalled();
    expect(frame.closed).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebGL2Renderer } from './webgl2-renderer';
import { RendererError } from './errors';
import { FakeVideoFrame, createFakeCanvas, createFakeGL, toFrame } from './fake-gl';

describe('WebGL2Renderer', () => {
  beforeEach(() => {
    vi.stubGlobal('devicePixelRatio', 1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes renderMode webgl2 when constructed with a webgl2 context', () => {
    const gl = createFakeGL();
    const canvas = createFakeCanvas(gl);

    const renderer = new WebGL2Renderer(canvas);

    expect(renderer.renderMode).toBe('webgl2');
  });

  it('throws RendererError when webgl2 context is unavailable', () => {
    const canvas = createFakeCanvas(null);

    expect(() => new WebGL2Renderer(canvas)).toThrow(RendererError);
    expect(() => new WebGL2Renderer(canvas)).toThrow('webgl2 unavailable');
  });

  it('uploads the frame to the texture and draws a 6-vertex triangle strip, closing the frame', () => {
    const gl = createFakeGL();
    const canvas = createFakeCanvas(gl);
    const renderer = new WebGL2Renderer(canvas);
    const frame = new FakeVideoFrame();

    renderer.draw(toFrame(frame));

    expect(gl.texImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame,
    );
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLES, 0, 6);
    expect(frame.closed).toBe(true);
  });

  it('closes the frame even when texImage2D throws', () => {
    const gl = createFakeGL();
    const canvas = createFakeCanvas(gl);
    const renderer = new WebGL2Renderer(canvas);
    const frame = new FakeVideoFrame();
    gl.texImage2D.mockImplementation(() => {
      throw new Error('upload failed');
    });

    expect(() => renderer.draw(toFrame(frame))).toThrow('upload failed');
    expect(frame.closed).toBe(true);
    expect(gl.drawArrays).not.toHaveBeenCalled();
  });

  it('sizes the backing store from client size x devicePixelRatio and updates the viewport', () => {
    const gl = createFakeGL();
    const canvas = createFakeCanvas(gl);
    const renderer = new WebGL2Renderer(canvas);
    vi.stubGlobal('devicePixelRatio', 2);

    renderer.resize();

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 1280, 720);
  });

  it('deletes GL resources on destroy and makes subsequent draws no-ops that still close the frame', () => {
    const gl = createFakeGL();
    const canvas = createFakeCanvas(gl);
    const renderer = new WebGL2Renderer(canvas);
    renderer.draw(toFrame(new FakeVideoFrame()));

    renderer.destroy();

    expect(gl.deleteTexture).toHaveBeenCalled();
    expect(gl.deleteProgram).toHaveBeenCalled();
    expect(gl.deleteBuffer).toHaveBeenCalled();

    const frame = new FakeVideoFrame();
    renderer.draw(toFrame(frame));
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(frame.closed).toBe(true);
  });

  it('compiles and links shaders successfully on first draw', () => {
    const gl = createFakeGL();
    const canvas = createFakeCanvas(gl);
    const renderer = new WebGL2Renderer(canvas);

    renderer.draw(toFrame(new FakeVideoFrame()));

    expect(gl.createShader).toHaveBeenCalledTimes(2);
    expect(gl.shaderSource).toHaveBeenCalledTimes(2);
    expect(gl.compileShader).toHaveBeenCalledTimes(2);
    expect(gl.getShaderParameter).toHaveBeenCalledTimes(2);
    expect(gl.attachShader).toHaveBeenCalledTimes(2);
    expect(gl.linkProgram).toHaveBeenCalledTimes(1);
    expect(gl.getProgramParameter).toHaveBeenCalledTimes(1);
    expect(gl.useProgram).toHaveBeenCalled();
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLES, 0, 6);
  });

  it('stops drawing while the context is lost, then rebuilds GL state after restore', () => {
    const gl = createFakeGL();
    const canvas = createFakeCanvas(gl);
    const renderer = new WebGL2Renderer(canvas);
    renderer.draw(toFrame(new FakeVideoFrame()));
    const drawsBeforeLoss = gl.drawArrays.mock.calls.length;

    canvas._trigger('webglcontextlost');

    const duringLoss = new FakeVideoFrame();
    renderer.draw(toFrame(duringLoss));
    expect(gl.drawArrays.mock.calls.length).toBe(drawsBeforeLoss);
    expect(duringLoss.closed).toBe(true);

    canvas._trigger('webglcontextrestored');

    const afterRestore = new FakeVideoFrame();
    renderer.draw(toFrame(afterRestore));
    expect(gl.createShader).toHaveBeenCalledTimes(4); // rebuilt from scratch
    expect(gl.drawArrays).toHaveBeenCalledTimes(drawsBeforeLoss + 1);
    expect(afterRestore.closed).toBe(true);
  });
});

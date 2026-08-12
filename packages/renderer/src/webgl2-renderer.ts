import type { RendererSurface } from 'vigilkit';
import { RendererError } from './errors';

// Fullscreen quad: 2 triangles, 6 vertices. vUv.y is flipped so that the
// video's first row (top) maps to the top of the canvas — WebGL texture
// row 0 corresponds to vUv.y = 0 (bottom), which would render upside down.
const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() {
  outColor = texture(uTex, vUv);
}`;

const QUAD_VERTICES = new Float32Array([
  -1, -1,
  1, -1,
  -1, 1,
  1, -1,
  1, 1,
  -1, 1,
]);

export class WebGL2Renderer implements RendererSurface {
  readonly renderMode = 'webgl2' as const;

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private needsInit = true;
  private destroyed = false;
  private readonly onContextLost: () => void;
  private readonly onContextRestored: () => void;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2');
    if (gl === null) throw new RendererError('webgl2 unavailable');
    this.canvas = canvas;
    this.gl = gl;
    // Context loss invalidates every GL object. On loss, stop drawing; on
    // restore, lazily rebuild all resources on the next draw (v0.1 choice:
    // rebuild, not throw).
    this.onContextLost = (): void => {
      this.destroyed = true;
    };
    this.onContextRestored = (): void => {
      this.destroyed = false;
      this.needsInit = true;
    };
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  draw(frame: VideoFrame): void {
    if (this.destroyed) {
      frame.close();
      return;
    }
    try {
      if (this.needsInit) this.init();
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    } finally {
      frame.close();
    }
  }

  resize(): void {
    if (this.destroyed) return;
    const dpr = globalThis.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    const gl = this.gl;
    if (this.texture !== null) gl.deleteTexture(this.texture);
    if (this.program !== null) gl.deleteProgram(this.program);
    if (this.vao !== null) gl.deleteVertexArray(this.vao);
    if (this.buffer !== null) gl.deleteBuffer(this.buffer);
    this.texture = null;
    this.program = null;
    this.vao = null;
    this.buffer = null;
  }

  private init(): void {
    const gl = this.gl;
    const program = gl.createProgram();
    if (program === null) throw new RendererError('program creation failed');
    const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new RendererError('program link failed');
    }

    const buffer = gl.createBuffer();
    if (buffer === null) throw new RendererError('buffer creation failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);

    const vao = gl.createVertexArray();
    if (vao === null) throw new RendererError('vao creation failed');
    gl.bindVertexArray(vao);
    const attrib = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(attrib);
    gl.vertexAttribPointer(attrib, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const texture = gl.createTexture();
    if (texture === null) throw new RendererError('texture creation failed');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.useProgram(program);
    this.program = program;
    this.buffer = buffer;
    this.vao = vao;
    this.texture = texture;
    this.needsInit = false;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (shader === null) throw new RendererError('shader creation failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new RendererError('shader compilation failed');
    }
    return shader;
  }
}

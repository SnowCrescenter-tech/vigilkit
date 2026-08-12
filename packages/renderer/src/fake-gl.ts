import { vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * Test double for WebGL2RenderingContext. Records every call as a vitest mock
 * so tests can assert renderer behavior without a real GPU. Enum constants
 * carry real WebGL2 values so recorded calls are inspectable.
 */
export interface FakeGLOptions {
  /** getShaderParameter returns false (shader compile fails). */
  failShaderCompile?: boolean;
  /** getProgramParameter returns false (program link fails). */
  failProgramLink?: boolean;
  /** createProgram returns null. */
  failCreateProgram?: boolean;
  /** createBuffer returns null. */
  failCreateBuffer?: boolean;
  /** createTexture returns null. */
  failCreateTexture?: boolean;
}
export interface FakeGL {
  // enum constants (real WebGL2 values)
  readonly TEXTURE_2D: number;
  readonly RGBA: number;
  readonly UNSIGNED_BYTE: number;
  readonly VERTEX_SHADER: number;
  readonly FRAGMENT_SHADER: number;
  readonly COMPILE_STATUS: number;
  readonly LINK_STATUS: number;
  readonly ARRAY_BUFFER: number;
  readonly STATIC_DRAW: number;
  readonly FLOAT: number;
  readonly TRIANGLES: number;
  readonly CLAMP_TO_EDGE: number;
  readonly LINEAR: number;
  readonly TEXTURE_WRAP_S: number;
  readonly TEXTURE_WRAP_T: number;
  readonly TEXTURE_MIN_FILTER: number;
  readonly TEXTURE_MAG_FILTER: number;
  // recorded calls
  readonly createShader: Mock;
  readonly shaderSource: Mock;
  readonly compileShader: Mock;
  readonly getShaderParameter: Mock;
  readonly createProgram: Mock;
  readonly attachShader: Mock;
  readonly linkProgram: Mock;
  readonly getProgramParameter: Mock;
  readonly getAttribLocation: Mock;
  readonly getUniformLocation: Mock;
  readonly createBuffer: Mock;
  readonly bindBuffer: Mock;
  readonly bufferData: Mock;
  readonly enableVertexAttribArray: Mock;
  readonly vertexAttribPointer: Mock;
  readonly useProgram: Mock;
  readonly createTexture: Mock;
  readonly bindTexture: Mock;
  readonly texParameteri: Mock;
  readonly texImage2D: Mock;
  readonly viewport: Mock;
  readonly drawArrays: Mock;
  readonly bindVertexArray: Mock;
  readonly createVertexArray: Mock;
  readonly deleteVertexArray: Mock;
  readonly deleteShader: Mock;
  readonly deleteTexture: Mock;
  readonly deleteProgram: Mock;
  readonly deleteBuffer: Mock;
}

export function createFakeGL(options: FakeGLOptions = {}): FakeGL {
  return {
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => !options.failShaderCompile),
    createProgram: vi.fn(() => (options.failCreateProgram ? null : {})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => !options.failProgramLink),
    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn(() => ({})),
    createBuffer: vi.fn(() => (options.failCreateBuffer ? null : {})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    useProgram: vi.fn(),
    createTexture: vi.fn(() => (options.failCreateTexture ? null : {})),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    viewport: vi.fn(),
    drawArrays: vi.fn(),
    bindVertexArray: vi.fn(),
    createVertexArray: vi.fn(() => ({})),
    deleteVertexArray: vi.fn(),
    deleteShader: vi.fn(),
    deleteTexture: vi.fn(),
    deleteProgram: vi.fn(),
    deleteBuffer: vi.fn(),
  };
}

export class FakeVideoFrame {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

/** Single seam: the renderer only consumes a closed flag + close(), so the
 * fake satisfies VideoFrame for test purposes. */
export function toFrame(frame: FakeVideoFrame): VideoFrame {
  return frame as unknown as VideoFrame;
}

export interface FakeCanvas extends HTMLCanvasElement {
  readonly _getContextMock: Mock;
  readonly _addEventListenerMock: Mock;
  _trigger(type: string): void;
}

/**
 * Fake HTMLCanvasElement. `gl` decides what getContext('webgl2') returns;
 * `ctx2d` what getContext('2d') returns; `webgpu` what getContext('webgpu')
 * returns. Records listeners so tests can fire webglcontextlost /
 * webglcontextrestored.
 */
export function createFakeCanvas(
  gl: FakeGL | null,
  ctx2d: unknown = null,
  webgpu: unknown = null,
): FakeCanvas {
  const getContextMock = vi.fn((type: string) => {
    if (type === 'webgl2') return gl;
    if (type === '2d') return ctx2d;
    if (type === 'webgpu') return webgpu;
    return null;
  });
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const addEventListenerMock = vi.fn((type: string, handler: (e: unknown) => void) => {
    const bucket = listeners.get(type) ?? [];
    bucket.push(handler);
    listeners.set(type, bucket);
  });
  const canvas = {
    getContext: getContextMock,
    addEventListener: addEventListenerMock,
    removeEventListener: vi.fn(),
    clientWidth: 640,
    clientHeight: 360,
    width: 0,
    height: 0,
    _getContextMock: getContextMock,
    _addEventListenerMock: addEventListenerMock,
    _trigger(type: string): void {
      for (const handler of listeners.get(type) ?? []) handler({ type });
    },
  } as unknown as FakeCanvas;
  return canvas;
}

import type { RendererSurface } from 'vigilkit';
import { Canvas2DRenderer } from './canvas2d-renderer';
import { WebGL2Renderer } from './webgl2-renderer';
import { WebGPURenderer } from './webgpu-renderer';
import { RendererError } from './errors';

/**
 * Picks the best renderer for the canvas. WebGL2 construction IS the feature
 * detection: a successful `getContext('webgl2')` chooses the GPU path, and
 * any failure falls back to Canvas2D. Throws only when both are unavailable.
 */
export function createRenderer(canvas: HTMLCanvasElement): RendererSurface {
  try {
    return new WebGL2Renderer(canvas);
  } catch {
    // fall through to Canvas2D
  }
  try {
    return new Canvas2DRenderer(canvas);
  } catch {
    throw new RendererError('no renderer available');
  }
}

export interface RendererOptions {
  /**
   * 'auto' (default) tries WebGPU first, then WebGL2, then Canvas2D.
   * 'webgpu' requires WebGPU and throws instead of falling back; 'webgl2'
   * and 'canvas2d' construct their renderer directly without fallback.
   */
  prefer?: 'webgpu' | 'webgl2' | 'canvas2d' | 'auto';
  /** WebGPU entry point; defaults to `navigator.gpu`. Injectable for tests. */
  gpu?: GPU;
}

/**
 * Async renderer factory. WebGPU availability is inherently async
 * (requestAdapter/requestDevice), unlike the synchronous WebGL2/Canvas2D
 * feature detection used by {@link createRenderer}.
 */
export async function createRendererAsync(
  canvas: HTMLCanvasElement,
  options: RendererOptions = {},
): Promise<RendererSurface> {
  const prefer = options.prefer ?? 'auto';
  if (prefer === 'webgpu' || prefer === 'auto') {
    const webgpu = await tryCreateWebGPU(canvas, options.gpu ?? defaultGpu());
    if (webgpu !== null) return webgpu;
    if (prefer === 'webgpu') throw new RendererError('webgpu unavailable');
  }
  if (prefer === 'webgl2' || prefer === 'auto') {
    try {
      return new WebGL2Renderer(canvas);
    } catch {
      // fall through
    }
  }
  if (prefer === 'canvas2d' || prefer === 'auto') {
    try {
      return new Canvas2DRenderer(canvas);
    } catch {
      // fall through
    }
  }
  throw new RendererError('no renderer available');
}

function defaultGpu(): GPU | undefined {
  return typeof navigator !== 'undefined' ? navigator.gpu : undefined;
}

async function tryCreateWebGPU(
  canvas: HTMLCanvasElement,
  gpu: GPU | undefined,
): Promise<WebGPURenderer | null> {
  if (gpu === undefined) return null;
  try {
    const context = canvas.getContext('webgpu');
    if (context === null) return null;
    const adapter = await gpu.requestAdapter();
    if (adapter === null) return null;
    const device = await adapter.requestDevice();
    return new WebGPURenderer(canvas, device, context, {
      getPreferredFormat: () => gpu.getPreferredCanvasFormat(),
    });
  } catch {
    return null;
  }
}

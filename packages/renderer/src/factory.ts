import type { RendererSurface } from 'vigilkit';
import { Canvas2DRenderer } from './canvas2d-renderer';
import { WebGL2Renderer } from './webgl2-renderer';
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

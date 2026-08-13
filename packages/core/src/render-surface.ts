import type { MediaErrorInfo } from '@vigilkit/plugin-sdk';
import type { RendererSurface } from './types.js';
import { mediaError } from './errors.js';

/**
 * Hands a frame to the renderer surface or closes it when no surface is
 * attached. A throwing renderer must not escape the caller's loop: it is
 * surfaced as a RENDERER media error through `onError`. The frame is the
 * renderer's responsibility once `draw()` is handed it (its own finally
 * closes it). Shared by the scheduler's decoder-output path and the engine's
 * direct-frame (e.g. WHEP) path.
 */
export function drawOrClose(
  renderer: RendererSurface | null,
  frame: VideoFrame,
  onError: (info: MediaErrorInfo) => void,
): void {
  if (renderer === null) {
    frame.close();
    return;
  }
  try {
    renderer.draw(frame);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'renderer draw failed';
    onError(mediaError('RENDERER', message));
  }
}

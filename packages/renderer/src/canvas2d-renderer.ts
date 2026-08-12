import type { RendererSurface } from 'vigilkit';
import { RendererError } from './errors';

export class Canvas2DRenderer implements RendererSurface {
  readonly renderMode = 'canvas2d' as const;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new RendererError('canvas2d unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  draw(frame: VideoFrame): void {
    if (this.destroyed) {
      frame.close();
      return;
    }
    try {
      this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    } finally {
      frame.close();
    }
  }

  resize(): void {
    if (this.destroyed) return;
    const dpr = globalThis.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

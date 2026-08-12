import type { EncodedVideoChunkData } from '@vigilkit/plugin-sdk';
import { JitterBuffer } from './jitter-buffer.js';
import { AvSyncClock } from './av-sync.js';
import { DECODER_HIGH_WATER } from './decoder.js';
import type { VideoCodecDecoder } from './decoder.js';
import type { RendererSurface } from './types.js';

export interface SchedulerStats {
  framesDecoded: number;
  framesDropped: number;
  fps: number;
}

export interface SchedulerOptions {
  latencyBudgetMs?: number;
  now?: () => number;
  onFrame?: (frame: VideoFrame, ptsUs: number) => void;
}

/**
 * Wires the jitter buffer -> decoder -> renderer pipeline. `tick()` is driven
 * by the engine's pump. Drop-late policy: chunks whose PTS is older than
 * `latencyBudgetMs` is discarded. Backpressure: nothing is pulled from the
 * jitter buffer while the decoder is at the high-water mark.
 */
export class Scheduler {
  private readonly decoder: VideoCodecDecoder;
  private readonly jitter = new JitterBuffer<EncodedVideoChunkData>();
  private readonly clock: AvSyncClock;
  private readonly renderer: RendererSurface | null;
  private readonly latencyBudgetMs: number;
  private readonly onFrame: ((frame: VideoFrame, ptsUs: number) => void) | undefined;
  private readonly now: () => number;
  private clockReset = false;
  private framesDecoded = 0;
  private framesDropped = 0;
  private readonly decodeTimes: number[] = [];

  constructor(
    decoder: VideoCodecDecoder,
    renderer: RendererSurface | null,
    options: SchedulerOptions = {},
  ) {
    this.decoder = decoder;
    this.renderer = renderer;
    this.latencyBudgetMs = options.latencyBudgetMs ?? 1000;
    this.onFrame = options.onFrame;
    this.now = options.now ?? (() => performance.now());
    this.clock = new AvSyncClock(this.now);
    decoder.onOutput((frame, ptsUs) => this.handleOutput(frame, ptsUs));
  }

  enqueue(chunk: EncodedVideoChunkData): void {
    if (!this.clockReset) {
      this.clock.reset(chunk.timestamp, this.now());
      this.clockReset = true;
    }
    this.jitter.push(chunk);
  }

  tick(): void {
    const nowMs = this.now();
    for (;;) {
      const head = this.jitter.peek();
      if (head === undefined) {
        break;
      }
      const delayMs = this.clock.latenessMs(head.timestamp, nowMs);
      if (delayMs >= -this.latencyBudgetMs) {
        break;
      }
      this.jitter.next();
      this.framesDropped++;
    }
    if (this.decoder.queueSize >= DECODER_HIGH_WATER) {
      return;
    }
    const head = this.jitter.peek();
    if (head === undefined) {
      return;
    }
    this.jitter.next();
    this.decoder.decode(head);
  }

  getStats(): SchedulerStats {
    return {
      framesDecoded: this.framesDecoded,
      framesDropped: this.framesDropped,
      fps: this.decodeTimes.length,
    };
  }

  private handleOutput(frame: VideoFrame, ptsUs: number): void {
    this.framesDecoded++;
    this.recordDecode();
    this.onFrame?.(frame, ptsUs);
    if (this.renderer !== null) {
      this.renderer.draw(frame);
    } else {
      frame.close();
    }
  }

  private recordDecode(): void {
    const nowMs = this.now();
    this.decodeTimes.push(nowMs);
    const cutoff = nowMs - 1000;
    while (this.decodeTimes.length > 0) {
      const oldest = this.decodeTimes[0];
      if (oldest !== undefined && oldest >= cutoff) {
        break;
      }
      this.decodeTimes.shift();
    }
  }
}

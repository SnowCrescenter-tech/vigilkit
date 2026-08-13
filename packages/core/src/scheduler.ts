import type { EncodedVideoChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { JitterBuffer } from './jitter-buffer.js';
import { AvSyncClock } from './av-sync.js';
import { DECODER_HIGH_WATER } from './decoder.js';
import type { VideoCodecDecoder } from './decoder.js';
import type { RendererSurface } from './types.js';
import { mediaError } from './errors.js';
import { StallMonitor } from './qos.js';
import { drawOrClose } from './render-surface.js';

const STALL_THRESHOLD_MS = 1500;
const FATAL_STALL_MS = 10_000;

export interface SchedulerStats {
  framesDecoded: number;
  framesDropped: number;
  fps: number;
  stalledCount: number;
  rebufferMs: number;
  currentBufferMs: number;
}

export interface SchedulerOptions {
  latencyBudgetMs?: number;
  now?: () => number;
  onFrame?: (frame: VideoFrame, ptsUs: number) => void;
  onError?: (info: MediaErrorInfo) => void;
  /** No data for this long (ms) declares a stall episode. Default 1500. */
  stallThresholdMs?: number;
  /** A stall episode longer than this (ms) is fatal. Default 10000. */
  fatalStallMs?: number;
  /** Fired once per stall episode, at the tick the episode begins. */
  onStalled?: () => void;
  /** Fired once when a stall episode exceeds fatalStallMs. */
  onFatalStall?: (info: MediaErrorInfo) => void;
}

/**
 * Wires the jitter buffer -> decoder -> renderer pipeline. `tick()` is driven
 * by the engine's pump. Drop-late policy: chunks whose PTS is older than
 * `latencyBudgetMs` is discarded. Backpressure: nothing is pulled from the
 * jitter buffer while the decoder is at the high-water mark. A stall watchdog
 * (QoS) declares an episode when both the jitter buffer and the decoder queue
 * sit empty past `stallThresholdMs`.
 */
export class Scheduler {
  private readonly decoder: VideoCodecDecoder;
  private readonly jitter = new JitterBuffer<EncodedVideoChunkData>();
  private readonly clock: AvSyncClock;
  private readonly renderer: RendererSurface | null;
  private readonly latencyBudgetMs: number;
  private readonly onFrame: ((frame: VideoFrame, ptsUs: number) => void) | undefined;
  private readonly onError: ((info: MediaErrorInfo) => void) | undefined;
  private readonly onStalled: (() => void) | undefined;
  private readonly onFatalStall: ((info: MediaErrorInfo) => void) | undefined;
  private readonly stallThresholdMs: number;
  private readonly fatalStallMs: number;
  private readonly stallMonitor: StallMonitor;
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
    this.onError = options.onError;
    this.onStalled = options.onStalled;
    this.onFatalStall = options.onFatalStall;
    this.stallThresholdMs = options.stallThresholdMs ?? STALL_THRESHOLD_MS;
    this.fatalStallMs = options.fatalStallMs ?? FATAL_STALL_MS;
    this.now = options.now ?? (() => performance.now());
    this.clock = new AvSyncClock(this.now);
    this.stallMonitor = new StallMonitor({
      stallThresholdMs: this.stallThresholdMs,
      fatalStallMs: this.fatalStallMs,
    });
    decoder.onOutput((frame, ptsUs) => this.handleOutput(frame, ptsUs));
  }

  enqueue(chunk: EncodedVideoChunkData): void {
    if (!this.clockReset) {
      this.clock.reset(chunk.timestamp, this.now());
      this.clockReset = true;
    }
    this.jitter.push(chunk);
    this.stallMonitor.noteData(this.now());
  }

  /**
   * Clears the clock base so the next enqueue re-bases it. Called by the
   * engine when audio becomes the master clock: the video clock must realign
   * to the audio media time instead of the wall clock.
   */
  resync(): void {
    this.clockReset = false;
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
    if (this.decoder.queueSize < DECODER_HIGH_WATER) {
      const head = this.jitter.peek();
      if (head !== undefined) {
        this.jitter.next();
        this.decoder.decode(head);
      }
    }
    this.watchStall(nowMs);
  }

  getStats(): SchedulerStats {
    return {
      framesDecoded: this.framesDecoded,
      framesDropped: this.framesDropped,
      fps: this.decodeTimes.length,
      stalledCount: this.stallMonitor.stalledCount,
      rebufferMs: this.stallMonitor.rebufferMs,
      currentBufferMs: this.bufferedMs(),
    };
  }

  private bufferedMs(): number {
    const head = this.jitter.peek();
    const tail = this.jitter.tail();
    if (head === undefined || tail === undefined) {
      return 0;
    }
    return Math.max(0, (tail.timestamp - head.timestamp) / 1000);
  }

  private watchStall(nowMs: number): void {
    const hasData = this.jitter.peek() !== undefined || this.decoder.idle === false;
    const result = this.stallMonitor.onTick(hasData, nowMs);
    if (result === undefined) {
      return;
    }
    if (result.started) {
      this.onStalled?.();
    }
    if (result.fatal) {
      this.onFatalStall?.(mediaError('STALLED', `playback stalled for > ${this.fatalStallMs} ms`));
    }
  }

  private handleOutput(frame: VideoFrame, ptsUs: number): void {
    this.framesDecoded++;
    this.recordDecode();
    this.stallMonitor.noteData(this.now());
    this.onFrame?.(frame, ptsUs);
    drawOrClose(this.renderer, frame, (info) => this.onError?.(info));
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

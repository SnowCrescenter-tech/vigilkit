import type { MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { mediaError } from './errors.js';

/** How far ahead of the context clock buffers are scheduled, in ms. */
export const SCHEDULE_AHEAD_MS = 250;

export interface AudioOutputOptions {
  /** Injectable AudioContext constructor; defaults to the global one. */
  AudioContextCtor?: typeof AudioContext;
  /** Audio-output failures (copyTo, scheduling) surface here. */
  onError?: (info: MediaErrorInfo) => void;
}

/**
 * WebAudio sink. Per AudioData: copies each channel to an f32-planar buffer
 * and schedules an AudioBufferSourceNode `SCHEDULE_AHEAD_MS` ahead of the
 * context clock, keeping scheduling monotonic. Tracks the media time base
 * (pts of the first scheduled buffer + its scheduling time) so the engine's
 * master clock can derive the audio media time from `ctx.currentTime`.
 */
export class AudioOutput {
  private ctx: AudioContext | null = null;
  private readonly audioContextCtor: typeof AudioContext | undefined;
  private readonly onError: ((info: MediaErrorInfo) => void) | undefined;
  private firstPtsUs: number | null = null;
  private firstWhen = 0;
  private nextWhen = 0;
  private closed = false;

  constructor(options: AudioOutputOptions = {}) {
    this.audioContextCtor = options.AudioContextCtor;
    this.onError = options.onError;
  }

  /** Creates the AudioContext lazily. Idempotent; a no-op after close(). */
  start(): void {
    if (this.closed || this.ctx !== null) {
      return;
    }
    const ctor = this.audioContextCtor ?? globalThis.AudioContext;
    if (ctor === undefined) {
      this.onError?.(mediaError('DECODE', 'AudioContext unavailable'));
      return;
    }
    this.ctx = new ctor();
  }

  onAudioData(data: AudioData): void {
    if (this.closed) {
      return;
    }
    const ctx = this.ctx;
    if (ctx === null) {
      return;
    }
    if (data.numberOfFrames === 0) {
      return;
    }
    if (ctx.state === 'suspended') {
      this.resume();
    }
    try {
      this.schedule(data, ctx);
    } catch {
      this.onError?.(mediaError('DECODE', 'audio output failed'));
    }
  }

  /**
   * Audio media time in µs, derived from the first scheduled buffer's pts and
   * the elapsed context time since it was scheduled. 0 until a base exists.
   */
  masterTimeUs(): number {
    const ctx = this.ctx;
    if (ctx === null || this.firstPtsUs === null) {
      return 0;
    }
    return this.firstPtsUs + (ctx.currentTime - this.firstWhen) * 1e6;
  }

  /** True while the context is running and a media time base exists. */
  audioActive(): boolean {
    return this.ctx !== null && this.ctx.state === 'running' && this.firstPtsUs !== null;
  }

  /** Attempts to lift a suspended context; a rejection is left to the caller. */
  resume(): void {
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== 'suspended') {
      return;
    }
    try {
      const result = ctx.resume();
      if (result instanceof Promise) {
        // Autoplay policy may still reject: the master clock falls back to the
        // wall clock until a later resume succeeds, so swallow deliberately.
        void result.catch(() => {});
      }
    } catch {
      // Synchronous throw (NotSupportedError): same wall-clock fallback.
    }
  }

  /** Clears the media base and schedule anchor; the next buffer re-bases. */
  reset(): void {
    this.firstPtsUs = null;
    this.firstWhen = 0;
    this.nextWhen = 0;
  }

  /** Tears down the context. Idempotent; stops all scheduling. */
  close(): void {
    this.closed = true;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx !== null && ctx.state !== 'closed') {
      try {
        void ctx.close();
      } catch {
        // Already closed by the runtime; nothing further to tear down.
      }
    }
    this.reset();
  }

  private schedule(data: AudioData, ctx: AudioContext): void {
    const channels = data.numberOfChannels;
    const frames = data.numberOfFrames;
    const buffer = ctx.createBuffer(channels, frames, data.sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const plane = new Float32Array(frames);
      data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
      buffer.copyToChannel(plane, ch);
    }
    const when = Math.max(ctx.currentTime, this.nextWhen) + SCHEDULE_AHEAD_MS / 1000;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(when);
    if (this.firstPtsUs === null) {
      this.firstPtsUs = data.timestamp;
      this.firstWhen = when;
    }
    this.nextWhen = when;
  }
}

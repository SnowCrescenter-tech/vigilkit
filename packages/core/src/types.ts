import type { MediaErrorInfo, Plugin, SourceOptions } from '@vigilkit/plugin-sdk';
import type { SoftVideoDecoderFactory } from './decoder-chain.js';

export interface RendererSurface {
  readonly renderMode: 'webgl2' | 'canvas2d' | 'webgpu';
  draw(frame: VideoFrame): void; // takes OWNERSHIP: renders then closes the frame
  resize(): void;
  destroy(): void;
}

export type PlayerState = 'idle' | 'connecting' | 'playing' | 'paused' | 'stopped' | 'error';

export interface PlayerStats {
  state: PlayerState;
  framesDecoded: number;
  framesDropped: number;
  fps: number;
  audioFramesDecoded: number;
  /** Smoothed A/V offset (video PTS - audio media time) in ms; 0 while audio is inactive. */
  avOffsetMs: number;
  errors: MediaErrorInfo[];
  /** Stall episodes detected since playback began (QoS watchdog). */
  stalledCount: number;
  /** Total time spent stalled, in ms. */
  rebufferMs: number;
  /** Head-to-tail media span currently buffered in the jitter buffer, in ms. */
  currentBufferMs: number;
}

export interface PlayerOptions {
  url: string;
  demuxer: string; // demuxer or source plugin id, e.g. 'flv' or 'hls'
  plugins: Plugin[];
  renderer: RendererSurface | null; // null = decode-only
  /** Passed to the source plugin's `create(url, options)` when a source path is used. */
  sourceOptions?: SourceOptions;
  /** Optional soft codec backend; the engine routes via WebCodecs → soft fallback. */
  softDecoder?: { factory: SoftVideoDecoderFactory };
  /** Bypass the WebCodecs capability probe and always use the soft decoder when it supports the codec. */
  forceSoft?: boolean;
  /**
   * Advanced: override the frame-scheduling drivers behind the playback pump.
   * `requestFrame(cb)` schedules a single `cb` invocation and returns a handle;
   * `cancelFrame(id)` cancels it. Defaults to requestAnimationFrame in browsers,
   * falling back to setInterval (30ms) in non-browser runtimes.
   */
  pump?: { requestFrame?: (cb: () => void) => number; cancelFrame?: (id: number) => void };
  /** Enable the audio decode + WebAudio output pipeline. Default true. */
  audio?: boolean;
  /** Injectable wall clock in ms for tests; defaults to performance.now. */
  now?: () => number;
  /**
   * QoS / stall-detection tuning. Defaults: `stallThresholdMs` 1500,
   * `fatalStallMs` 10000.
   */
  qos?: {
    /** No data for this long (ms) declares a stall episode. Default 1500. */
    stallThresholdMs?: number;
    /** A stall episode longer than this (ms) is fatal (STALLED error). Default 10000. */
    fatalStallMs?: number;
  };
}

export interface PlayerEvents {
  error: MediaErrorInfo;
  frame: { frame: VideoFrame; ptsUs: number };
  stats: PlayerStats;
  /** Non-fatal stall-episode notification; payload shape matches 'stats'. */
  stalled: { stats: PlayerStats };
}

export interface Player {
  play(): void;
  pause(): void;
  destroy(): void;
  on<K extends keyof PlayerEvents>(type: K, cb: (payload: PlayerEvents[K]) => void): () => void;
  getStats(): PlayerStats;
}

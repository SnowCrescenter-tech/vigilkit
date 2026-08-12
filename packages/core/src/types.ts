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
  errors: MediaErrorInfo[];
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
}

export interface PlayerEvents {
  error: MediaErrorInfo;
  frame: { frame: VideoFrame; ptsUs: number };
  stats: PlayerStats;
}

export interface Player {
  play(): void;
  pause(): void;
  destroy(): void;
  on<K extends keyof PlayerEvents>(type: K, cb: (payload: PlayerEvents[K]) => void): () => void;
  getStats(): PlayerStats;
}

import type { MediaErrorInfo, Plugin } from '@vigilkit/plugin-sdk';

export interface RendererSurface {
  readonly renderMode: 'webgl2' | 'canvas2d';
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
  demuxer: string; // demuxer scheme e.g. 'flv'
  plugins: Plugin[];
  renderer: RendererSurface | null; // null = decode-only
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

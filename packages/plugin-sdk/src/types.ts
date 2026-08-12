export type MediaErrorCode =
  | 'TRANSPORT' | 'DEMUX' | 'DEMUX_BAD_SIGNATURE' | 'DEMUX_MISSING_SEQUENCE_HEADER'
  | 'DECODE' | 'BUFFER_OVERFLOW' | 'RENDERER' | 'PLUGIN_COLLISION' | 'UNSUPPORTED';

export interface MediaErrorInfo { code: MediaErrorCode; message: string; }

export interface StreamMetadata {
  width?: number; height?: number; framerate?: number; duration?: number;
  hasAudio: boolean; hasVideo: boolean; codec?: string;
  sampleRate?: number; channels?: number;
}

export interface EncodedVideoChunkData {
  type: 'key' | 'delta';
  timestamp: number;        // microseconds
  duration?: number;
  data: Uint8Array;         // Annex-B or avc-format payload per config
}

export interface EncodedAudioChunkData { type: 'key' | 'delta'; timestamp: number; data: Uint8Array; }

export type DemuxerEvent =
  | { type: 'metadata'; metadata: StreamMetadata }
  | { type: 'sequence-header'; config: VideoDecoderConfig }   // DOM type (lib DOM)
  | { type: 'video'; chunk: EncodedVideoChunkData }
  | { type: 'audio'; chunk: EncodedAudioChunkData }
  | { type: 'error'; error: MediaErrorInfo };

export type TransportEvent =
  | { type: 'open' }
  | { type: 'data'; data: Uint8Array }
  | { type: 'close'; code: number }
  | { type: 'error'; error: MediaErrorInfo };

export interface Demuxer {
  push(chunk: Uint8Array): void;
  flush(): void;
  onEvent(listener: (event: DemuxerEvent) => void): () => void;  // returns unsubscribe
  close(): void;
}

export interface Transport {
  connect(): void;
  close(): void;
  onEvent(listener: (event: TransportEvent) => void): () => void;
}

export interface DemuxerPlugin {
  type: 'demuxer';
  id: string;
  mimeTypes: readonly string[];   // e.g. ['video/x-flv']
  schemes: readonly string[];     // e.g. ['flv']
  create(): Demuxer;
}

export interface TransportPlugin {
  type: 'transport';
  id: string;
  schemes: readonly string[];     // e.g. ['ws', 'wss']
  create(url: string): Transport;
}

export interface MediaSource {
  start(): void;             // begin fetching/parsing (called by engine on play)
  stop(): void;              // stop fetching; idempotent; no events after stop
  onEvent(listener: (event: DemuxerEvent) => void): () => void;  // same event union as Demuxer
}

export interface SourcePlugin {
  type: 'source';
  id: string;
  mimeTypes: readonly string[];   // e.g. ['application/vnd.apple.mpegurl', 'application/x-mpegURL']
  schemes: readonly string[];     // e.g. ['http', 'https']
  create(url: string, options?: SourceOptions): MediaSource;
}

export interface SourceOptions {
  variant?: 'lowest' | 'highest' | number;  // HLS variant selection; default 'lowest'
}

export type Plugin = DemuxerPlugin | TransportPlugin | SourcePlugin;
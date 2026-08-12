export type MediaErrorCode =
  | 'TRANSPORT' | 'DEMUX' | 'DEMUX_BAD_SIGNATURE' | 'DEMUX_MISSING_SEQUENCE_HEADER'
  | 'DECODE' | 'BUFFER_OVERFLOW' | 'RENDERER' | 'PLUGIN_COLLISION' | 'UNSUPPORTED';

export interface MediaErrorInfo { code: MediaErrorCode; message: string; }

export interface StreamMetadata {
  width?: number; height?: number; framerate?: number; duration?: number;
  hasAudio: boolean; hasVideo: boolean; codec?: string;
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

export type Plugin = DemuxerPlugin | TransportPlugin;
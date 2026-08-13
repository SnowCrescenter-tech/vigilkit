/**
 * Media error taxonomy. 'NETWORK' is reserved for future network-failure
 * classification (connection-level outages distinct from a stalled pipeline);
 * no code path emits it yet. 'STALLED' comes from the core QoS watchdog when a
 * stall episode outlives `PlayerOptions.qos.fatalStallMs`, and 'TIMEOUT' from
 * a connect that never opened within the transport pipeline's connect window.
 */
export type MediaErrorCode =
  | 'TRANSPORT' | 'DEMUX' | 'DEMUX_BAD_SIGNATURE' | 'DEMUX_MISSING_SEQUENCE_HEADER'
  | 'DECODE' | 'BUFFER_OVERFLOW' | 'RENDERER' | 'PLUGIN_COLLISION' | 'UNSUPPORTED'
  | 'STALLED' | 'NETWORK' | 'TIMEOUT';

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
  /**
   * Emitted once before the first audio chunk. Consumers configure their
   * AudioDecoder with `config`.
   */
  | { type: 'audio-config'; config: AudioDecoderConfig }      // DOM type (lib DOM)
  | { type: 'video'; chunk: EncodedVideoChunkData }
  | { type: 'audio'; chunk: EncodedAudioChunkData }
  /**
   * A direct-decoded frame from a source plugin (e.g. WebRTC/WHEP), bypassing
   * the encoded decode chain. The frame is handed to the engine and MUST NOT
   * be closed by the emitting source; the engine renders it (renderer takes
   * ownership) or closes it when no renderer is attached.
   */
  | { type: 'frame'; frame: VideoFrame }
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
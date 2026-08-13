import type { EncodedVideoChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { mediaError } from './errors.js';

export const DECODER_HIGH_WATER = 10;

export interface VideoDecoderHandlers {
  output(frame: VideoFrame): void;
  error(error: unknown): void;
}

export type VideoDecoderFactory = (handlers: VideoDecoderHandlers) => VideoDecoder;

/**
 * Decoder contract consumed by the scheduler/engine. Satisfied by the
 * WebCodecs-backed `VideoDecoderWrapper` and by soft (WASM/JS) decoders so the
 * pipeline can route between codec implementations without knowing the backend.
 */
export interface VideoCodecDecoder {
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunkData): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
  readonly queueSize: number;
  /**
   * True when no decode work is pending. Optional so out-of-tree soft
   * decoders need not implement it; consumers (the stall watchdog) treat an
   * absent decoder as not busy.
   */
  readonly idle?: boolean;
  onOutput(cb: (frame: VideoFrame, ptsUs: number) => void): void;
  onError(cb: (info: MediaErrorInfo) => void): void;
}

/** Default browser factory: wires the native decoder to the wrapper handlers. */
export const nativeDecoderFactory: VideoDecoderFactory = (handlers) =>
  new VideoDecoder({
    output: (frame) => handlers.output(frame),
    error: (error) => handlers.error(error),
  });

interface OutputEntry {
  frame: VideoFrame;
  ptsUs: number;
}

/**
 * Thin facade over a WebCodecs `VideoDecoder`. The decoder instance is created
 * lazily on first `configure`. Decoded frames are staged in an internal output
 * queue (with their PTS) and forwarded synchronously to the `onOutput` listener
 * once one is registered.
 */
export class VideoDecoderWrapper implements VideoCodecDecoder {
  private decoder: VideoDecoder | null = null;
  private readonly outputs: OutputEntry[] = [];
  private outputCb: ((frame: VideoFrame, ptsUs: number) => void) | null = null;
  private errorCb: ((info: MediaErrorInfo) => void) | null = null;
  private readonly factory: VideoDecoderFactory;

  constructor(factory: VideoDecoderFactory) {
    this.factory = factory;
  }

  onOutput(cb: (frame: VideoFrame, ptsUs: number) => void): void {
    this.outputCb = cb;
    this.drainOutputs();
  }

  onError(cb: (info: MediaErrorInfo) => void): void {
    this.errorCb = cb;
  }

  configure(config: VideoDecoderConfig): void {
    try {
      if (this.decoder === null || this.decoder.state === 'closed') {
        // A null reference (after close()) or a decoder that closed itself
        // (e.g. after a fatal decode error) must not be reused: build a fresh
        // native decoder.
        this.decoder = this.factory({
          output: (frame) => this.deliverOutput(frame),
          error: (error) => this.handleError(error),
        });
      }
      this.decoder.configure(config);
    } catch {
      this.surfaceError(mediaError('DECODE', 'decoder configure failed'));
    }
  }

  decode(chunk: EncodedVideoChunkData): void {
    if (this.decoder === null || this.decoder.state === 'closed') {
      this.surfaceError(mediaError('DECODE', 'decode called before configure'));
      return;
    }
    try {
      const encoded = new EncodedVideoChunk({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data: chunk.data,
      });
      this.decoder.decode(encoded);
    } catch {
      this.surfaceError(mediaError('DECODE', 'decode failed'));
    }
  }

  flush(): Promise<void> {
    if (this.decoder === null || this.decoder.state === 'closed') {
      return Promise.resolve();
    }
    return this.decoder.flush();
  }

  close(): void {
    if (this.decoder !== null && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    // Drop the reference so a later configure() builds a new decoder and any
    // further close()/reset()/decode() call is a guarded no-op.
    this.decoder = null;
    this.outputs.length = 0;
  }

  reset(): void {
    if (this.decoder !== null && this.decoder.state !== 'closed') {
      this.decoder.reset();
    }
    this.outputs.length = 0;
  }

  get queueSize(): number {
    return this.decoder === null ? 0 : this.decoder.decodeQueueSize;
  }

  get idle(): boolean {
    return this.decoder === null || this.decoder.decodeQueueSize === 0;
  }

  get outputSize(): number {
    return this.outputs.length;
  }

  private deliverOutput(frame: VideoFrame): void {
    this.outputs.push({ frame, ptsUs: frame.timestamp });
    this.drainOutputs();
  }

  private drainOutputs(): void {
    if (this.outputCb === null) {
      return;
    }
    for (const entry of this.outputs) {
      this.outputCb(entry.frame, entry.ptsUs);
    }
    this.outputs.length = 0;
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : 'decoder error';
    this.surfaceError(mediaError('DECODE', message));
  }

  private surfaceError(info: MediaErrorInfo): void {
    this.errorCb?.(info);
  }
}

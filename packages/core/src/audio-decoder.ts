import type { EncodedAudioChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { mediaError } from './errors.js';

export interface AudioDecoderHandlers {
  output(data: AudioData): void;
  error(error: unknown): void;
}

export type AudioDecoderFactory = (handlers: AudioDecoderHandlers) => AudioDecoder;

/** Default browser factory: wires the native decoder to the wrapper handlers. */
export const nativeAudioDecoderFactory: AudioDecoderFactory = (handlers) =>
  new AudioDecoder({
    output: (data) => handlers.output(data),
    error: (error) => handlers.error(error),
  });

/**
 * Decoder contract consumed by the audio pipeline. Satisfied by the
 * WebCodecs-backed `AudioDecoderWrapper` so the pipeline can swap backends
 * without knowing the implementation.
 */
export interface AudioCodecDecoder {
  configure(config: AudioDecoderConfig): void;
  decode(chunk: EncodedAudioChunkData): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
  readonly queueSize: number;
  onOutput(cb: (data: AudioData) => void): void;
  onError(cb: (info: MediaErrorInfo) => void): void;
}

/**
 * Thin facade over a WebCodecs `AudioDecoder`. The decoder instance is created
 * lazily on first `configure`. Decoded AudioData is staged in an internal
 * output queue and forwarded synchronously to the `onOutput` listener once one
 * is registered.
 */
export class AudioDecoderWrapper implements AudioCodecDecoder {
  private decoder: AudioDecoder | null = null;
  private readonly outputs: AudioData[] = [];
  private outputCb: ((data: AudioData) => void) | null = null;
  private errorCb: ((info: MediaErrorInfo) => void) | null = null;
  private readonly factory: AudioDecoderFactory;

  constructor(factory: AudioDecoderFactory) {
    this.factory = factory;
  }

  onOutput(cb: (data: AudioData) => void): void {
    this.outputCb = cb;
    this.drainOutputs();
  }

  onError(cb: (info: MediaErrorInfo) => void): void {
    this.errorCb = cb;
  }

  configure(config: AudioDecoderConfig): void {
    try {
      if (this.decoder === null || this.decoder.state === 'closed') {
        // A null reference (after close()) or a decoder that closed itself
        // (e.g. after a fatal decode error) must not be reused: build a fresh
        // native decoder.
        this.decoder = this.factory({
          output: (data) => this.deliverOutput(data),
          error: (error) => this.handleError(error),
        });
      }
      this.decoder.configure(config);
    } catch {
      this.surfaceError(mediaError('DECODE', 'decoder configure failed'));
    }
  }

  decode(chunk: EncodedAudioChunkData): void {
    if (this.decoder === null || this.decoder.state === 'closed') {
      this.surfaceError(mediaError('DECODE', 'decode called before configure'));
      return;
    }
    try {
      const encoded = new EncodedAudioChunk({
        type: chunk.type,
        timestamp: chunk.timestamp,
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

  get outputSize(): number {
    return this.outputs.length;
  }

  private deliverOutput(data: AudioData): void {
    this.outputs.push(data);
    this.drainOutputs();
  }

  private drainOutputs(): void {
    if (this.outputCb === null) {
      return;
    }
    for (const entry of this.outputs) {
      this.outputCb(entry);
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

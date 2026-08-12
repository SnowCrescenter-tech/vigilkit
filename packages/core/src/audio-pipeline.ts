import type { DemuxerEvent, EncodedAudioChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { AudioDecoderWrapper } from './audio-decoder.js';
import type { AudioCodecDecoder, AudioDecoderFactory } from './audio-decoder.js';
import { AudioOutput } from './audio-output.js';

export interface AudioPipelineOptions {
  /** Builds the underlying WebCodecs AudioDecoder. */
  decoderFactory: AudioDecoderFactory;
  /** Injectable AudioContext constructor for the WebAudio sink. */
  AudioContextCtor?: typeof AudioContext;
  /** When false the pipeline is inert: no decoder, no context, no output. */
  enabled?: boolean;
  /** Fired once, on the first decoded audio frame, with the audio sink. */
  onFirstAudio?: (output: AudioOutput) => void;
  onError?: (info: MediaErrorInfo) => void;
}

/**
 * Owns the audio branch: AudioDecoderWrapper → AudioOutput. Created lazily on
 * the first audio-config event; audio chunks before a config are dropped.
 * Reports decoded-frame counts for the engine stats.
 */
export class AudioPipeline {
  private decoder: AudioCodecDecoder | null = null;
  private output: AudioOutput | null = null;
  private audioFramesDecoded = 0;
  private audioMasterActivated = false;
  private readonly enabled: boolean;
  private readonly options: AudioPipelineOptions;

  constructor(options: AudioPipelineOptions) {
    this.enabled = options.enabled !== false;
    this.options = options;
  }

  handleConfig(config: AudioDecoderConfig): void {
    if (!this.enabled) {
      return;
    }
    if (this.decoder === null) {
      this.decoder = this.buildDecoder();
    }
    this.decoder.configure(config);
  }

  handleChunk(chunk: EncodedAudioChunkData): void {
    if (!this.enabled || this.decoder === null) {
      return; // audio disabled, or no audio-config seen yet — drop
    }
    this.decoder.decode(chunk);
  }

  /** Routes an audio demuxer event to config or chunk handling. */
  handle(event: Extract<DemuxerEvent, { type: 'audio-config' } | { type: 'audio' }>): void {
    if (event.type === 'audio-config') {
      this.handleConfig(event.config);
    } else {
      this.handleChunk(event.chunk);
    }
  }

  destroy(): void {
    this.decoder?.close();
    this.output?.close();
    this.decoder = null;
    this.output = null;
  }

  get decodedFrameCount(): number {
    return this.audioFramesDecoded;
  }

  private buildDecoder(): AudioCodecDecoder {
    const decoder = new AudioDecoderWrapper(this.options.decoderFactory);
    decoder.onError((info) => this.options.onError?.(info));
    decoder.onOutput((data) => this.handleDecodedFrame(data));
    return decoder;
  }

  private handleDecodedFrame(data: AudioData): void {
    this.audioFramesDecoded++;
    const output = this.ensureOutput();
    output.onAudioData(data);
    if (!this.audioMasterActivated) {
      this.audioMasterActivated = true;
      this.options.onFirstAudio?.(output);
    }
  }

  private ensureOutput(): AudioOutput {
    if (this.output === null) {
      this.output = new AudioOutput({
        AudioContextCtor: this.options.AudioContextCtor,
        onError: (info) => this.options.onError?.(info),
      });
      this.output.start();
    }
    return this.output;
  }
}

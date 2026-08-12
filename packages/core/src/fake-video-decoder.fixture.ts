import type { EncodedVideoChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';

export class FakeVideoFrame {
  readonly timestamp: number;
  closeCount = 0;

  constructor(timestamp: number) {
    this.timestamp = timestamp;
  }

  close(): void {
    this.closeCount++;
  }
}

export class FakeEncodedVideoChunk {
  readonly type: string;
  readonly timestamp: number;
  readonly duration: number | undefined;
  readonly data: Uint8Array;

  constructor(init: { type: string; timestamp: number; duration?: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration;
    this.data = init.data;
  }
}

/**
 * Minimal WebCodecs VideoDecoder stand-in for tests. `decode` produces a
 * frame synchronously through the constructor-provided output handler, and
 * manual `triggerError` drives the error path.
 */
export class FakeVideoDecoder {
  static readonly instances: FakeVideoDecoder[] = [];
  static isConfigSupported: ((config: VideoDecoderConfig) => Promise<VideoDecoderSupport>) | undefined;

  readonly configureCalls: VideoDecoderConfig[] = [];
  readonly decodeCalls: EncodedVideoChunk[] = [];
  readonly outputFrames: VideoFrame[] = [];
  flushCount = 0;
  resetCount = 0;
  closed = false;
  state: string = 'unconfigured';
  decodeQueueSize = 0;
  failConfigure = false;
  private readonly output: (frame: VideoFrame) => void;
  private readonly error: (error: unknown) => void;

  constructor(init: { output: (frame: VideoFrame) => void; error: (error: unknown) => void }) {
    this.output = init.output;
    this.error = init.error;
    FakeVideoDecoder.instances.push(this);
  }

  configure(config: VideoDecoderConfig): void {
    this.assertOpen();
    if (this.failConfigure) {
      throw new Error('configure failed');
    }
    this.configureCalls.push(config);
    this.state = 'configured';
  }

  decode(chunk: EncodedVideoChunk): void {
    this.assertOpen();
    this.decodeCalls.push(chunk);
    this.decodeQueueSize++;
    const frame = new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame;
    this.outputFrames.push(frame);
    this.output(frame);
    this.decodeQueueSize--;
  }

  flush(): Promise<void> {
    this.assertOpen();
    this.flushCount++;
    return Promise.resolve();
  }

  reset(): void {
    this.assertOpen();
    this.resetCount++;
    this.state = 'unconfigured';
  }

  close(): void {
    this.assertOpen();
    this.closed = true;
    this.state = 'closed';
  }

  /** Mirrors native WebCodecs: any method call on a closed codec throws. */
  private assertOpen(): void {
    if (this.state === 'closed') {
      throw new Error('Cannot call on a closed codec.');
    }
  }

  triggerError(error: unknown): void {
    this.error(error);
  }

  static resetInstances(): void {
    FakeVideoDecoder.instances.length = 0;
  }
}

/**
 * Soft (non-WebCodecs) decoder stand-in implementing `VideoCodecDecoder`.
 * Emits one fake frame per decoded chunk with the chunk's PTS, so the routing
 * layer and the pipeline can be exercised without a real soft codec.
 */
export class FakeSoftDecoder {
  static readonly instances: FakeSoftDecoder[] = [];

  readonly configureCalls: VideoDecoderConfig[] = [];
  readonly decodeCalls: EncodedVideoChunkData[] = [];
  readonly outputFrames: FakeVideoFrame[] = [];
  flushCount = 0;
  resetCount = 0;
  closeCount = 0;
  closed = false;
  queueSize = 0;
  private outputCb: ((frame: VideoFrame, ptsUs: number) => void) | null = null;
  private errorCb: ((info: MediaErrorInfo) => void) | null = null;

  constructor() {
    FakeSoftDecoder.instances.push(this);
  }

  configure(config: VideoDecoderConfig): void {
    this.configureCalls.push(config);
  }

  decode(chunk: EncodedVideoChunkData): void {
    this.decodeCalls.push(chunk);
    const fakeFrame = new FakeVideoFrame(chunk.timestamp);
    this.outputFrames.push(fakeFrame);
    this.outputCb?.(fakeFrame as unknown as VideoFrame, chunk.timestamp);
  }

  flush(): Promise<void> {
    this.flushCount++;
    return Promise.resolve();
  }

  reset(): void {
    this.resetCount++;
  }

  close(): void {
    this.closeCount++;
    this.closed = true;
  }

  onOutput(cb: (frame: VideoFrame, ptsUs: number) => void): void {
    this.outputCb = cb;
  }

  onError(cb: (info: MediaErrorInfo) => void): void {
    this.errorCb = cb;
  }

  triggerError(info: MediaErrorInfo): void {
    this.errorCb?.(info);
  }

  static resetInstances(): void {
    FakeSoftDecoder.instances.length = 0;
  }
}

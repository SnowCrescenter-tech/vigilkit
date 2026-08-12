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
    if (this.failConfigure) {
      throw new Error('configure failed');
    }
    this.configureCalls.push(config);
    this.state = 'configured';
  }

  decode(chunk: EncodedVideoChunk): void {
    this.decodeCalls.push(chunk);
    this.decodeQueueSize++;
    const frame = new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame;
    this.outputFrames.push(frame);
    this.output(frame);
    this.decodeQueueSize--;
  }

  flush(): Promise<void> {
    this.flushCount++;
    return Promise.resolve();
  }

  reset(): void {
    this.resetCount++;
    this.state = 'unconfigured';
  }

  close(): void {
    this.closed = true;
    this.state = 'closed';
  }

  triggerError(error: unknown): void {
    this.error(error);
  }

  static resetInstances(): void {
    FakeVideoDecoder.instances.length = 0;
  }
}

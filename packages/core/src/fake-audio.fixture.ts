/**
 * WebCodecs/WebAudio audio stand-ins for tests. Mirrors the video fixtures
 * (`fake-video-decoder.fixture.ts`): the fake decoder decodes synchronously
 * through the constructor-provided output handler, and `triggerError` drives
 * the error path.
 */

export class FakeEncodedAudioChunk {
  readonly type: string;
  readonly timestamp: number;
  readonly data: Uint8Array;

  constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}

export class FakeAudioData {
  readonly timestamp: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  /** One f32 plane per channel; channel ch is filled with ch + 1. */
  readonly planes: Float32Array[];
  throwOnCopy = false;

  constructor(init: {
    timestamp: number;
    numberOfFrames: number;
    numberOfChannels: number;
    sampleRate: number;
  }) {
    this.timestamp = init.timestamp;
    this.numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.sampleRate = init.sampleRate;
    this.planes = Array.from({ length: init.numberOfChannels }, (_, ch) =>
      new Float32Array(init.numberOfFrames).fill(ch + 1),
    );
  }

  /** Mirrors AudioData.copyTo for a single f32-planar plane. */
  copyTo(target: Float32Array, options: { planeIndex: number; format?: string }): void {
    if (this.throwOnCopy) {
      throw new Error('copyTo failed');
    }
    const plane = this.planes[options.planeIndex];
    if (plane === undefined) {
      return;
    }
    target.set(plane);
  }
}

/**
 * Minimal WebCodecs AudioDecoder stand-in. `decode` emits one AudioData
 * synchronously with the chunk's timestamp.
 */
export class FakeAudioDecoder {
  static readonly instances: FakeAudioDecoder[] = [];

  readonly configureCalls: AudioDecoderConfig[] = [];
  readonly decodeCalls: EncodedAudioChunk[] = [];
  readonly outputData: AudioData[] = [];
  flushCount = 0;
  resetCount = 0;
  closed = false;
  state: string = 'unconfigured';
  decodeQueueSize = 0;
  failConfigure = false;
  private readonly output: (data: AudioData) => void;
  private readonly error: (error: unknown) => void;

  constructor(init: { output: (data: AudioData) => void; error: (error: unknown) => void }) {
    this.output = init.output;
    this.error = init.error;
    FakeAudioDecoder.instances.push(this);
  }

  configure(config: AudioDecoderConfig): void {
    this.assertOpen();
    if (this.failConfigure) {
      throw new Error('configure failed');
    }
    this.configureCalls.push(config);
    this.state = 'configured';
  }

  decode(chunk: EncodedAudioChunk): void {
    this.assertOpen();
    this.decodeCalls.push(chunk);
    this.decodeQueueSize++;
    const data = new FakeAudioData({
      timestamp: chunk.timestamp,
      numberOfFrames: 1024,
      numberOfChannels: 2,
      sampleRate: 48000,
    }) as unknown as AudioData;
    this.outputData.push(data);
    this.output(data);
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
    FakeAudioDecoder.instances.length = 0;
  }
}

export class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly channelData: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channelData = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  copyToChannel(source: Float32Array, channel: number): void {
    const target = this.channelData[channel];
    if (target !== undefined) {
      target.set(source);
    }
  }

  getChannelData(channel: number): Float32Array {
    return this.channelData[channel] ?? new Float32Array(this.length);
  }
}

export class FakeAudioBufferSourceNode {
  buffer: FakeAudioBuffer | null = null;
  startTime: number | null = null;
  connected = false;

  start(when: number): void {
    this.startTime = when;
  }

  connect(_destination: unknown): void {
    this.connected = true;
  }
}

export class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];

  readonly buffers: FakeAudioBuffer[] = [];
  readonly sources: FakeAudioBufferSourceNode[] = [];
  readonly destination = {};
  currentTime = 0;
  state: AudioContextState = 'running';
  /** When 'reject', resume() rejects (autoplay policy still blocking). */
  resumeBehavior: 'resolve' | 'reject' = 'resolve';
  resumeCount = 0;
  closeCount = 0;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    const buffer = new FakeAudioBuffer(numberOfChannels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource(): FakeAudioBufferSourceNode {
    const source = new FakeAudioBufferSourceNode();
    this.sources.push(source);
    return source;
  }

  /** Modeled like the real API: state flips only when the promise resolves. */
  resume(): Promise<void> {
    this.resumeCount++;
    if (this.resumeBehavior === 'reject') {
      return Promise.reject(new Error('resume blocked'));
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount++;
    this.state = 'closed';
    return Promise.resolve();
  }

  static resetInstances(): void {
    FakeAudioContext.instances.length = 0;
  }
}

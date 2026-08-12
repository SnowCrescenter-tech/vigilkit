import type {
  Libde265Decoder,
  Libde265DecoderCtor,
  Libde265Image,
  Libde265Module,
} from './libde265-loader.js';

/** Subsampling factors per libde265 chroma format. */
export function chromaDims(
  chroma: number,
): { subW: number; subH: number } {
  switch (chroma) {
    case 2: // 4:2:2
      return { subW: 2, subH: 1 };
    case 3: // 4:4:4
      return { subW: 1, subH: 1 };
    default: // 4:2:0
      return { subW: 2, subH: 2 };
  }
}

export class FakeImage implements Libde265Image {
  readonly pts: bigint;
  readonly chromaFormat: number;
  readonly isFullRange: boolean;
  width: number;
  height: number;
  deleted = false;
  deleteCalls = 0;
  private readonly bitsPerPixel: number;
  private readonly planeBytes: Uint8Array[];
  private readonly planeStrides: number[];

  constructor(
    pts: bigint,
    width = 16,
    height = 16,
    chroma = 1,
    bitsPerPixel = 8,
    isFullRange = false,
    nonTightStride = false,
  ) {
    this.pts = pts;
    this.width = width;
    this.height = height;
    this.chromaFormat = chroma;
    this.bitsPerPixel = bitsPerPixel;
    this.isFullRange = isFullRange;
    const { subW, subH } = chromaDims(chroma);
    const sampleBytes = bitsPerPixel > 8 ? 2 : 1;
    this.planeBytes = [];
    this.planeStrides = [];
    for (let channel = 0; channel < 3; channel++) {
      const w = width / (channel === 0 ? 1 : subW);
      const h = height / (channel === 0 ? 1 : subH);
      const tight = new Uint8Array(w * h * sampleBytes);
      tight.fill(channel === 0 ? 64 : 128);
      // Model the wasm heap: the underlying plane is stride*height bytes and
      // `bytes` is the tight subview at its start. Backing the subview with
      // the full plane size keeps yuvToRgba's fullPlaneView (stride*height) in
      // bounds, and the persistent view keeps in-place fills observable.
      const stride = nonTightStride ? w * 2 : w * sampleBytes;
      const backing = new ArrayBuffer(stride * h);
      new Uint8Array(backing).set(tight);
      this.planeBytes.push(new Uint8Array(backing, 0, tight.length));
      this.planeStrides.push(stride);
    }
  }

  getWidth(channel: number): number {
    const { subW } = chromaDims(this.chromaFormat);
    return channel === 0 ? this.width : this.width / subW;
  }

  getHeight(channel: number): number {
    const { subH } = chromaDims(this.chromaFormat);
    return channel === 0 ? this.height : this.height / subH;
  }

  getBitsPerPixel(): number {
    return this.bitsPerPixel;
  }

  getImagePlane(channel: number): { width: number; height: number; bytes: Uint8Array; stride: number } {
    return {
      width: this.getWidth(channel),
      height: this.getHeight(channel),
      bytes: this.planeBytes[channel]!,
      stride: this.planeStrides[channel]!,
    };
  }

  delete(): void {
    this.deleted = true;
    this.deleteCalls++;
  }
}

export class FakeDecoder implements Libde265Decoder {
  readonly pushed: { data: Uint8Array; pts: bigint }[] = [];
  readonly produced: FakeImage[] = [];
  readonly imagesToProduce: FakeImage[] = [];
  decodeCalls = 0;
  resetCalls = 0;
  deleteCalls = 0;
  flushCalls = 0;
  nextError = 0;

  /** Queue an image the next `decode()` call will produce. */
  triggerImage(img: FakeImage): void {
    this.imagesToProduce.push(img);
  }

  /** Make the next `decode()` call return this error code. */
  triggerError(error: number): void {
    this.nextError = error;
  }

  pushData(input: Uint8Array, pts: bigint): number {
    this.pushed.push({ data: input, pts });
    return 0;
  }

  decode(): { error: number; more: boolean } {
    this.decodeCalls++;
    const img = this.imagesToProduce.shift();
    if (img !== undefined) {
      this.produced.push(img);
    }
    return { error: this.nextError, more: this.produced.length > 0 };
  }

  getNextPicture(): FakeImage | null {
    return this.produced.shift() ?? null;
  }

  flushData(): number {
    this.flushCalls++;
    return 0;
  }

  reset(): void {
    this.resetCalls++;
  }

  delete(): void {
    this.deleteCalls++;
  }
}

export interface FakeModuleHandle {
  module: Libde265Module;
  decoders: FakeDecoder[];
}

/** Builds a Libde265Module backed by FakeDecoder instances that tests control. */
export function makeModule(): FakeModuleHandle {
  const decoders: FakeDecoder[] = [];
  class Decoder extends FakeDecoder {
    constructor() {
      super();
      decoders.push(this);
    }
  }
  const module: Libde265Module = {
    Decoder: Decoder as Libde265DecoderCtor,
    Error: { OK: 0, ERROR_WAITING_FOR_INPUT_DATA: 13 },
    Chroma: { MONO: 0, 420: 1, 422: 2, 444: 3 },
    isOk: (error) => error === 0 || error >= 1000,
    getErrorText: (error) => `libde265 error ${error}`,
  };
  return { module, decoders };
}

/** Records the init passed to a stubbed global VideoFrame. */
export interface StubFrameInit {
  format?: string;
  codedWidth?: number;
  codedHeight?: number;
  timestamp?: number;
  layout?: { offset: number; stride: number }[];
}

export class StubVideoFrame {
  static last: StubVideoFrame | null = null;
  readonly init: StubFrameInit;
  readonly buffer: ArrayBuffer;

  constructor(buffer: ArrayBuffer, init: StubFrameInit) {
    this.buffer = buffer;
    this.init = init;
    StubVideoFrame.last = this;
  }

  close(): void {}
}

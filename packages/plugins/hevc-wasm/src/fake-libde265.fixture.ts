import type {
  Libde265Decoder,
  Libde265DecoderCtor,
  Libde265Image,
  Libde265Module,
} from './libde265-loader.js';

/** Subsampling factors per libde265 chroma format. */
export function chromaDims(
  chroma: number,
  width: number,
  height: number,
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
  private readonly bitsPerPixel: number;
  private readonly planes: Uint8Array[];

  constructor(pts: bigint, width = 16, height = 16, chroma = 1, bitsPerPixel = 8, isFullRange = false) {
    this.pts = pts;
    this.width = width;
    this.height = height;
    this.chromaFormat = chroma;
    this.bitsPerPixel = bitsPerPixel;
    this.isFullRange = isFullRange;
    const { subW, subH } = chromaDims(chroma, width, height);
    const sampleBytes = bitsPerPixel > 8 ? 2 : 1;
    const y = new Uint8Array(width * height * sampleBytes);
    const u = new Uint8Array((width / subW) * (height / subH) * sampleBytes);
    const v = new Uint8Array((width / subW) * (height / subH) * sampleBytes);
    y.fill(64);
    u.fill(128);
    v.fill(128);
    this.planes = [y, u, v];
  }

  getWidth(channel: number): number {
    const { subW } = chromaDims(this.chromaFormat, this.width, this.height);
    return channel === 0 ? this.width : this.width / subW;
  }

  getHeight(channel: number): number {
    const { subH } = chromaDims(this.chromaFormat, this.width, this.height);
    return channel === 0 ? this.height : this.height / subH;
  }

  getBitsPerPixel(): number {
    return this.bitsPerPixel;
  }

  getImagePlane(channel: number): { width: number; height: number; bytes: Uint8Array; stride: number } {
    const bytes = this.planes[channel]!;
    const height = this.getHeight(channel);
    return { width: this.getWidth(channel), height, bytes, stride: bytes.length / height };
  }

  delete(): void {
    this.deleted = true;
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

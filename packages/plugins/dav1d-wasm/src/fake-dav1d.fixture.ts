import type { Dav1dInstance, Dav1dModule, Dav1dYuvFrame } from './dav1d-loader.js';

/**
 * Fake dav1d wasm instance for tests. Decodes each pushed OBU into a synthetic
 * I420 frame; `triggerFailure` makes the next decode throw (as the wrapper does
 * for non-8-bit / non-4:2:0 pictures or malformed OBUs).
 */
export class FakeDav1dInstance implements Dav1dInstance {
  readonly decoded: Uint8Array[] = [];
  cleanupCalls = 0;
  failure: Error | null = null;

  decodeFrameAsYUV(obu: Uint8Array): Dav1dYuvFrame {
    if (this.failure !== null) {
      throw this.failure;
    }
    this.decoded.push(obu);
    const width = 16;
    const height = 16;
    const data = new Uint8Array(width * height * 1.5);
    data.fill(64);
    return { width, height, data };
  }

  unsafeCleanup(): void {
    this.cleanupCalls++;
  }
}

export interface FakeModuleHandle {
  module: Dav1dModule;
  instances: FakeDav1dInstance[];
  createCalls: number;
}

/** Builds a Dav1dModule backed by FakeDav1dInstance that tests control. */
export function makeModule(): FakeModuleHandle {
  const instances: FakeDav1dInstance[] = [];
  let createCalls = 0;
  const module: Dav1dModule = {
    create: () => {
      createCalls++;
      const instance = new FakeDav1dInstance();
      instances.push(instance);
      return Promise.resolve(instance);
    },
  };
  return { module, instances, get createCalls() { return createCalls; } };
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

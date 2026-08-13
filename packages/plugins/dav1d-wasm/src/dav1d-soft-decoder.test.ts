import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncodedVideoChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { Dav1dSoftDecoder } from './dav1d-soft-decoder.js';
import type { Dav1dInstance, Dav1dModule } from './dav1d-loader.js';
import { StubVideoFrame, makeModule } from './fake-dav1d.fixture.js';
import type { FakeModuleHandle } from './fake-dav1d.fixture.js';

function chunk(timestamp: number, data?: Uint8Array): EncodedVideoChunkData {
  return { type: 'key', timestamp, data: data ?? new Uint8Array([0x0a, 0x0f, 0x00]) };
}

// --- Canvas stand-ins for the RGBA fallback path (buildCanvasFrame) --------

class FakeImageData {
  data = new Uint8ClampedArray(16 * 16 * 4);
}

class FakeCanvasRenderingContext2D {
  createImageData(): FakeImageData {
    return new FakeImageData();
  }

  putImageData(): void {}
}

class FakeCanvas {
  width = 0;
  height = 0;

  getContext(): FakeCanvasRenderingContext2D {
    return new FakeCanvasRenderingContext2D();
  }
}

class FakeDocument {
  createElement(tag: string): FakeCanvas {
    if (tag !== 'canvas') throw new Error(`unexpected element type: ${tag}`);
    return new FakeCanvas();
  }
}

/** A VideoFrame stub that rejects the planar (buffer) form but accepts a canvas. */
class ThrowingVideoFrame {
  static last: { init: { format?: string; timestamp: number } } | null = null;

  constructor(source: ArrayBuffer | HTMLCanvasElement, init: { format?: string; timestamp: number }) {
    if (source instanceof ArrayBuffer) {
      throw new Error('I420 buffer rejected');
    }
    ThrowingVideoFrame.last = { init };
  }
}

describe('Dav1dSoftDecoder', () => {
  let mod: FakeModuleHandle;
  let decoder: Dav1dSoftDecoder;

  beforeEach(() => {
    mod = makeModule();
    decoder = new Dav1dSoftDecoder(mod.module);
    StubVideoFrame.last = null;
    vi.stubGlobal('VideoFrame', StubVideoFrame);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts av01 codecs in configure without error', () => {
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.configure({ codec: 'av01.0.04M.08' });
    decoder.configure({ codec: 'av01.1.04M.08' });
    expect(errors).toEqual([]);
  });

  it('rejects a non-AV1 codec with an UNSUPPORTED error and stops processing', () => {
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.configure({ codec: 'avc1.64001f' });
    expect(errors).toEqual([{ code: 'UNSUPPORTED', message: 'not an AV1 codec: avc1.64001f' }]);
    decoder.decode(chunk(1));
    expect(mod.instances[0]!.decoded).toHaveLength(0);
  });

  it('creates one wasm instance per decoder and feeds OBU payloads to it', async () => {
    decoder.configure({ codec: 'av01.0.04M.08' });
    const obu = new Uint8Array([0x0a, 0x0f, 0x00, 0x01]);
    decoder.decode({ type: 'key', timestamp: 7, data: obu });
    await decoder.flush();
    expect(mod.createCalls).toBe(1);
    expect(mod.instances[0]!.decoded).toEqual([obu]);
  });

  it('buffers chunks that arrive before the wasm instantiation resolves', async () => {
    // A module whose create() resolves on a later microtask.
    let resolveCreate: (instance: Dav1dInstance) => void = () => {};
    const module: Dav1dModule = {
      create: () =>
        new Promise<Dav1dInstance>((resolve) => {
          resolveCreate = resolve;
        }),
    };
    const slow = new Dav1dSoftDecoder(module);
    slow.configure({ codec: 'av01.0.04M.08' });
    const outputs: { frame: unknown; pts: number }[] = [];
    slow.onOutput((frame, pts) => outputs.push({ frame, pts }));

    slow.decode(chunk(10));
    slow.decode(chunk(11));
    expect(slow.queueSize).toBe(2); // both held while instantiation is pending

    resolveCreate({
      decodeFrameAsYUV: (obu: Uint8Array) => {
        void obu;
        return { width: 16, height: 16, data: new Uint8Array(16 * 16 * 1.5).fill(64) };
      },
      unsafeCleanup: () => {},
    });
    await slow.flush();

    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.pts).toBe(10);
    expect(outputs[1]!.pts).toBe(11);
    expect(slow.queueSize).toBe(0);
  });

  it('delivers a planar I420 VideoFrame with the tight layout', async () => {
    decoder.configure({ codec: 'av01.0.04M.08' });
    const outputs: { frame: unknown; pts: number }[] = [];
    decoder.onOutput((frame, pts) => outputs.push({ frame, pts }));
    decoder.decode(chunk(123));
    await decoder.flush();

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.pts).toBe(123);
    const last = StubVideoFrame.last!;
    expect(last.init.format).toBe('I420');
    expect(last.init.codedWidth).toBe(16);
    expect(last.init.codedHeight).toBe(16);
    expect(last.init.timestamp).toBe(123);
    expect(last.init.layout).toEqual([
      { offset: 0, stride: 16 },
      { offset: 256, stride: 8 },
      { offset: 320, stride: 8 },
    ]);
    expect(last.buffer.byteLength).toBe(16 * 16 * 1.5);
  });

  it('delivers a count-only null frame when VideoFrame is absent (Node smoke)', async () => {
    vi.unstubAllGlobals(); // Node-like environment: no VideoFrame
    const outputs: { frame: unknown; pts: number }[] = [];
    decoder.onOutput((frame, pts) => outputs.push({ frame, pts }));
    decoder.decode(chunk(42));
    await decoder.flush();
    expect(outputs).toEqual([{ frame: null, pts: 42 }]);
  });

  it('delivers frames synchronously and drains queueSize when the wasm is ready', async () => {
    decoder.configure({ codec: 'av01.0.04M.08' });
    const outputs: { pts: number; frame: unknown }[] = [];
    decoder.onOutput((frame, pts) => outputs.push({ pts, frame }));
    // The fake module's create() resolves before the test body runs, so the
    // instance is ready: decode() is synchronous and queueSize stays at 0.
    decoder.decode(chunk(1));
    decoder.decode(chunk(2));
    expect(decoder.queueSize).toBe(0);
    await decoder.flush();
    expect(decoder.queueSize).toBe(0);
    expect(outputs).toHaveLength(2);
    expect(outputs.map((o) => o.pts)).toEqual([1, 2]);
  });

  it('surfaces a decode failure as a DECODE MediaErrorInfo and stops processing', async () => {
    decoder.configure({ codec: 'av01.0.04M.08' });
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    mod.instances[0]!.failure = new Error('error in djs_decode');
    decoder.decode(chunk(1));
    await decoder.flush();
    expect(errors).toEqual([{ code: 'DECODE', message: 'dav1d: frame decode failed: error in djs_decode' }]);
    expect(decoder.queueSize).toBe(0);
  });

  it('surfaces a module init failure as a DECODE MediaErrorInfo', async () => {
    const module: Dav1dModule = {
      create: () => Promise.reject(new Error('instantiate failed')),
    };
    const failing = new Dav1dSoftDecoder(module);
    const errors: MediaErrorInfo[] = [];
    failing.onError((info) => errors.push(info));
    failing.configure({ codec: 'av01.0.04M.08' });
    failing.decode(chunk(1));
    await failing.flush();
    expect(errors).toEqual([{ code: 'DECODE', message: 'dav1d: module init failed: instantiate failed' }]);
  });

  it('flush resolves without output when closed', async () => {
    decoder.close();
    await expect(decoder.flush()).resolves.toBeUndefined();
    expect(mod.instances[0]!.cleanupCalls).toBe(1);
  });

  it('reset drops the context and re-creates a fresh one', async () => {
    decoder.configure({ codec: 'av01.0.04M.08' });
    decoder.decode(chunk(1));
    await decoder.flush();
    expect(mod.createCalls).toBe(1);

    decoder.reset();
    await decoder.flush();
    expect(mod.createCalls).toBe(2); // a fresh context was created
  });

  it('close is idempotent and stops all processing', async () => {
    decoder.configure({ codec: 'av01.0.04M.08' });
    decoder.decode(chunk(1));
    await decoder.flush();
    decoder.close();
    decoder.close();
    expect(mod.instances[0]!.cleanupCalls).toBe(1);
    const decodedBefore = mod.instances[0]!.decoded.length;
    decoder.decode(chunk(2));
    expect(mod.instances[0]!.decoded.length).toBe(decodedBefore);
    expect(decoder.queueSize).toBe(0);
  });

  it('ignores callbacks after close', async () => {
    decoder.configure({ codec: 'av01.0.04M.08' });
    const errors: MediaErrorInfo[] = [];
    const outputs: unknown[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.onOutput((frame) => outputs.push(frame));
    decoder.close();
    mod.instances[0]!.failure = new Error('boom');
    decoder.decode(chunk(1));
    await decoder.flush();
    expect(errors).toEqual([]);
    expect(outputs).toEqual([]);
  });

  it('falls back to the RGBA canvas path when the planar VideoFrame ctor throws', async () => {
    decoder.configure({ codec: 'av01.0.04M.08' });
    vi.stubGlobal('VideoFrame', ThrowingVideoFrame);
    vi.stubGlobal('document', new FakeDocument());
    const errors: MediaErrorInfo[] = [];
    const outputs: { frame: unknown; pts: number }[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.onOutput((frame, pts) => outputs.push({ frame, pts }));

    decoder.decode(chunk(7));
    await decoder.flush();

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.pts).toBe(7);
    // The canvas ctor receives no planar format init, proving the fallback ran.
    expect(ThrowingVideoFrame.last?.init.format).toBeUndefined();
    expect(ThrowingVideoFrame.last?.init.timestamp).toBe(7);
    expect(errors).toEqual([]);
  });

  it('surfaces a DECODE error when both the planar and canvas paths fail', async () => {
    decoder.configure({ codec: 'av01.0.04M.08' });
    vi.stubGlobal('VideoFrame', ThrowingVideoFrame);
    const errors: MediaErrorInfo[] = [];
    const outputs: unknown[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.onOutput((frame) => outputs.push(frame));
    // No document stub: document.createElement throws inside the canvas path.
    vi.stubGlobal('document', undefined);

    decoder.decode(chunk(7));
    await decoder.flush();

    expect(errors).toEqual([
      { code: 'DECODE', message: 'dav1d: unable to construct a VideoFrame from the decoded picture' },
    ]);
    // Mirrors hevc: the failed frame is delivered as a count-only null frame.
    expect(outputs).toEqual([null]);
  });
});

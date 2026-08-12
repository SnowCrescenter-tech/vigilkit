import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncodedVideoChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { HevcSoftDecoder } from './hevc-soft-decoder.js';
import {
  FakeImage,
  StubVideoFrame,
  makeModule,
} from './fake-libde265.fixture.js';
import type { FakeModuleHandle } from './fake-libde265.fixture.js';

function chunk(timestamp: number): EncodedVideoChunkData {
  return { type: 'key', timestamp, data: new Uint8Array([0, 0, 1]) };
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

/** A VideoFrame stub whose construction always throws (Chromium rejecting a buffer). */
class ThrowingVideoFrame {
  constructor(_buffer: ArrayBuffer, _init: unknown) {
    throw new Error('I420 buffer rejected');
  }
}

describe('HevcSoftDecoder', () => {
  let mod: FakeModuleHandle;
  let decoder: HevcSoftDecoder;

  beforeEach(() => {
    mod = makeModule();
    decoder = new HevcSoftDecoder(mod.module);
    StubVideoFrame.last = null;
    vi.stubGlobal('VideoFrame', StubVideoFrame);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts hvc1/hev1/hevc codecs in configure without error', () => {
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.configure({ codec: 'hvc1.1.6.L120.90' });
    decoder.configure({ codec: 'hev1.1.6.L93.B0' });
    decoder.configure({ codec: 'HEVC' });
    expect(errors).toEqual([]);
  });

  it('rejects a non-HEVC codec with an UNSUPPORTED error and stops processing', () => {
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.configure({ codec: 'avc1.64001f' });
    expect(errors).toEqual([{ code: 'UNSUPPORTED', message: 'not an HEVC codec: avc1.64001f' }]);
    const fake = mod.decoders[0]!;
    decoder.decode(chunk(1));
    expect(fake.decodeCalls).toBe(0);
  });

  it('increments queueSize per undelivered chunk and decrements when an image is delivered', async () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    const outputs: { pts: number; frame: unknown }[] = [];
    decoder.onOutput((frame, pts) => outputs.push({ pts, frame }));

    decoder.decode(chunk(123));
    expect(decoder.queueSize).toBe(1);
    expect(fake.pushed).toEqual([{ data: chunk(123).data, pts: 123n }]);

    fake.triggerImage(new FakeImage(123n));
    await decoder.flush();
    expect(decoder.queueSize).toBe(0);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.pts).toBe(123);

    const last = StubVideoFrame.last!;
    expect(last.init.format).toBe('I420');
    expect(last.init.codedWidth).toBe(16);
    expect(last.init.codedHeight).toBe(16);
    expect(last.init.timestamp).toBe(123);
    expect(last.buffer.byteLength).toBe(16 * 16 * 1.5);
    expect(last.init.layout).toEqual([
      { offset: 0, stride: 16 },
      { offset: 256, stride: 8 },
      { offset: 320, stride: 8 },
    ]);
  });

  it('delivers a count-only null frame when VideoFrame is absent (Node smoke)', async () => {
    vi.unstubAllGlobals(); // remove the VideoFrame stub -> Node-like environment
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hevc' });
    const outputs: { frame: unknown; pts: number }[] = [];
    decoder.onOutput((frame, pts) => outputs.push({ frame, pts }));

    decoder.decode(chunk(42));
    fake.triggerImage(new FakeImage(42n, 8, 8));
    await decoder.flush();

    expect(outputs).toEqual([{ frame: null, pts: 42 }]);
    expect(fake.produced[0]).toBeUndefined(); // image was deleted
  });

  it('passes through 4:2:0 I420 frames and deletes the libde265 image', async () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    const img = new FakeImage(7n);
    fake.triggerImage(img);
    await decoder.flush();
    expect(img.deleted).toBe(true);
    expect(decoder.queueSize).toBe(0);
  });

  it('flush resolves after calling decoder.flushData', async () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    await expect(decoder.flush()).resolves.toBeUndefined();
    expect(fake.flushCalls).toBe(1);
  });

  it('reset calls decoder.reset and clears the pending count', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    decoder.decode(chunk(1));
    expect(decoder.queueSize).toBe(1);
    decoder.reset();
    expect(fake.resetCalls).toBe(1);
    expect(decoder.queueSize).toBe(0);
  });

  it('close is idempotent, deletes the decoder once, and stops all processing', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    decoder.close();
    decoder.close();
    expect(fake.deleteCalls).toBe(1);
    const before = fake.decodeCalls;
    decoder.decode(chunk(1));
    expect(fake.decodeCalls).toBe(before);
    expect(decoder.queueSize).toBe(0);
  });

  it('surfaces a non-recoverable decoder error as a DECODE MediaErrorInfo', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    fake.triggerError(15); // ERROR_PARAMETER_PARSING
    decoder.decode(chunk(1));
    expect(errors).toEqual([{ code: 'DECODE', message: 'libde265 error 15' }]);
    expect(decoder.queueSize).toBe(0);
  });

  it('treats WAITING_FOR_INPUT_DATA as backpressure, not as a failure', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    fake.triggerError(13); // ERROR_WAITING_FOR_INPUT_DATA
    decoder.decode(chunk(1));
    expect(errors).toEqual([]);
    expect(decoder.queueSize).toBe(1); // image still owed
  });

  it('ignores callbacks after close', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    const errors: MediaErrorInfo[] = [];
    const outputs: unknown[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.onOutput((frame) => outputs.push(frame));
    decoder.close();
    fake.triggerImage(new FakeImage(1n));
    fake.triggerError(15);
    decoder.decode(chunk(1));
    expect(errors).toEqual([]);
    expect(outputs).toEqual([]);
  });

  it('a 10-bit image falls back to the canvas RGBA path', async () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    vi.stubGlobal('document', new FakeDocument());
    const outputs: { frame: unknown; pts: number }[] = [];
    decoder.onOutput((frame, pts) => outputs.push({ frame, pts }));
    const img = new FakeImage(123n, 16, 16, 1, 10); // 10-bit samples
    fake.triggerImage(img);
    await decoder.flush();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.pts).toBe(123);
    // The canvas ctor receives no planar format init, proving the fallback ran.
    expect(StubVideoFrame.last?.init.format).toBeUndefined();
    expect(StubVideoFrame.last?.init.timestamp).toBe(123);
    expect(img.deleted).toBe(true);
  });

  it('image.delete() is called exactly once when VideoFrame construction throws', async () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    vi.stubGlobal('VideoFrame', ThrowingVideoFrame);
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    const img = new FakeImage(7n);
    fake.triggerImage(img);
    await decoder.flush();
    expect(errors).toEqual([
      { code: 'DECODE', message: 'libde265: unable to construct a VideoFrame from the decoded picture' },
    ]);
    expect(img.deleteCalls).toBe(1);
    expect(img.deleted).toBe(true);
  });

  it('non-tight plane strides reject the planar path and fall back', async () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    vi.stubGlobal('document', new FakeDocument());
    const errors: MediaErrorInfo[] = [];
    const outputs: { frame: unknown; pts: number }[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.onOutput((frame, pts) => outputs.push({ frame, pts }));
    // 8-bit 4:2:0 with padded rows: stride (32) !== sample width (16).
    const img = new FakeImage(5n, 16, 16, 1, 8, false, true);
    fake.triggerImage(img);
    await decoder.flush();
    expect(outputs).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(StubVideoFrame.last?.init.format).toBeUndefined(); // canvas path, not I420
    expect(img.deleted).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncodedVideoChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { HevcSoftDecoder } from './hevc-soft-decoder.js';
import {
  FakeImage,
  StubVideoFrame,
  makeModule,
} from './fake-libde265.fixture.js';
import type { FakeModuleHandle } from './fake-libde265.fixture.js';

/**
 * Real hvcC record extracted from examples/basic/hevc-fixtures/flv-hevc.flv
 * (SequenceStart tag, box-unwrapped). Carries VPS (57 B) + SPS + PPS arrays.
 */
const HVC_C = Uint8Array.from(
  Buffer.from(
    '0104080000006d08000000007bf000fcfefafa00000f03a00001003940010c01ffff0408000003006d0800000300007b082c0c00000fa40003a98200fa57005ef7e000040d9900001036650000206cc8000081b322a1000100434201010408000003006d0800000300007bb003c080221f2b65082e490a5846021a000007d20001d4c1007d3c017bdf8000103664000040d994000081b320000206cc84a2000100724401c073c0331a20a411c47c8a2893346e6f9148493272793e4fc9fc9f93e4f27264908a2095ae4f27d7e4febf27d793ac9445225264e4f27c9f93f93f27c9e4e4c921144255ae4f27d7e4febf27d793ac9445225264e4f27c9f93f93f27c9e4e4c9244255ae4f27d7e4febf27d793ac9590',
    'hex',
  ),
);

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

  it('converts a single-NALU length-prefixed chunk to Annex-B before pushData', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    // AVCC-style framing: [u32 length][NALU]. The first length equals the
    // number of remaining bytes, so the isLengthPrefixed heuristic fires.
    const framed = new Uint8Array([0, 0, 0, 4, 0x26, 0x01, 0xaf, 0x03]);
    decoder.decode({ type: 'key', timestamp: 5, data: framed });
    const pushed = fake.pushed[0]!.data;
    expect(Array.from(pushed.subarray(0, 4))).toEqual([0, 0, 0, 1]); // start code
    expect(Array.from(pushed)).toEqual([0, 0, 0, 1, 0x26, 0x01, 0xaf, 0x03]);
    expect(fake.pushed[0]!.pts).toBe(5n);
  });

  it('converts a multi-NALU length-prefixed chunk (whole access unit) to Annex-B', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    // A keyframe access unit: VPS + SPS + PPS + IDR slice. The first length
    // (4) does not match the remaining bytes (16), so only the chain walk can
    // recognize this framing.
    const framed = new Uint8Array([
      0, 0, 0, 4, 0x40, 0x01, 0x0c, 0x01,
      0, 0, 0, 3, 0x42, 0x01, 0x01,
      0, 0, 0, 2, 0x44, 0x01,
      0, 0, 0, 7, 0x26, 0x01, 0xaf, 0x03, 0x40, 0x01, 0x00,
    ]);
    decoder.decode({ type: 'key', timestamp: 9, data: framed });
    expect(Array.from(fake.pushed[0]!.data)).toEqual([
      0, 0, 0, 1, 0x40, 0x01, 0x0c, 0x01,
      0, 0, 0, 1, 0x42, 0x01, 0x01,
      0, 0, 0, 1, 0x44, 0x01,
      0, 0, 0, 1, 0x26, 0x01, 0xaf, 0x03, 0x40, 0x01, 0x00,
    ]);
  });

  it('passes Annex-B chunks through unchanged (raw-ES demo path)', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    const annexB = new Uint8Array([0, 0, 0, 1, 0x26, 0x01, 0xaf, 0x03]);
    decoder.decode({ type: 'delta', timestamp: 3, data: annexB });
    expect(fake.pushed[0]!.data).toBe(annexB); // same buffer, no copy
    expect(Array.from(fake.pushed[0]!.data)).toEqual(Array.from(annexB));
  });

  it('normalizes unrecognized framing to a self-delimiting start code (libde265 reports it)', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    // Declared length 8 but only 2 payload bytes remain: neither Annex-B nor
    // a valid length-prefixed chain, so the payload is passed through and
    // the decoder's own error reporting owns the malformed stream. The head
    // is still normalized so every pushed buffer is self-delimiting.
    const malformed = new Uint8Array([0, 0, 0, 8, 0x26, 0x01]);
    decoder.decode({ type: 'key', timestamp: 1, data: malformed });
    expect(Array.from(fake.pushed[0]!.data)).toEqual([0, 0, 0, 1, 8, 0x26, 0x01]);
  });

  it('normalizes partial start codes so each push is self-delimiting', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    // The raw-ES demo splits AT start codes: chunks begin with the bare
    // start-code tail (`01`) or its zero head (`00 00 00`).
    decoder.decode({ type: 'delta', timestamp: 1, data: new Uint8Array([1, 0x26, 0x01]) });
    expect(Array.from(fake.pushed[0]!.data)).toEqual([0, 0, 0, 1, 0x26, 0x01]);
    decoder.decode({ type: 'delta', timestamp: 2, data: new Uint8Array([0, 0, 0]) });
    expect(Array.from(fake.pushed[1]!.data)).toEqual([0, 0, 0, 1]);
  });

  it('prepends the hvcC VPS/SPS/PPS to the first chunk and never again', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1.4.10.L123.6D.08', description: HVC_C });
    const first = new Uint8Array([0, 0, 0, 4, 0x26, 0x01, 0xaf, 0x03]);
    decoder.decode({ type: 'key', timestamp: 5, data: first });

    const pushed = fake.pushed[0]!.data;
    // The VPS (NAL type 32: 0x40 >> 1 = 32) is the first Annex-B frame.
    expect(Array.from(pushed.subarray(0, 5))).toEqual([0, 0, 0, 1, 0x40]);
    // 3 parameter sets (4-byte start code + NALU each: VPS 57 / SPS 67 /
    // PPS 114 bytes) precede the Annex-B-converted chunk (start code + 4 B).
    expect(pushed.length).toBe(4 + 57 + 4 + 67 + 4 + 114 + 8);
    expect(Array.from(pushed.subarray(pushed.length - 8))).toEqual([0, 0, 0, 1, 0x26, 0x01, 0xaf, 0x03]);

    decoder.decode({ type: 'delta', timestamp: 6, data: first });
    // Second push carries only the chunk — parameter sets are sent once.
    expect(fake.pushed[1]!.data.length).toBe(first.length);
  });

  it('re-pushes parameter sets after reset', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1', description: HVC_C });
    const chunkBytes = new Uint8Array([0, 0, 0, 4, 0x26, 0x01, 0xaf, 0x03]);
    decoder.decode({ type: 'key', timestamp: 1, data: chunkBytes });
    const firstLength = fake.pushed[0]!.data.length;
    expect(firstLength).toBeGreaterThan(chunkBytes.length);

    decoder.reset();
    decoder.decode({ type: 'key', timestamp: 2, data: chunkBytes });
    expect(fake.pushed[1]!.data.length).toBe(firstLength);
  });

  it('surfaces an UNSUPPORTED error for a malformed hvcC description', () => {
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.configure({ codec: 'hvc1', description: new Uint8Array([1, 2, 3]) });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('UNSUPPORTED');
    expect(errors[0]?.message).toMatch(/hvcC description/);
  });

  it('flushes before every chunk after the first (libde265 releases on flush)', () => {
    const fake = mod.decoders[0]!;
    decoder.configure({ codec: 'hvc1' });
    const nalu = new Uint8Array([0, 0, 0, 1, 0x26, 0x01]);
    decoder.decode({ type: 'key', timestamp: 1, data: nalu });
    expect(fake.flushCalls).toBe(0); // first chunk: nothing buffered yet
    decoder.decode({ type: 'delta', timestamp: 2, data: nalu });
    expect(fake.flushCalls).toBe(1); // every later chunk forces prior pictures out
    decoder.decode({ type: 'key', timestamp: 3, data: nalu });
    expect(fake.flushCalls).toBe(2);
    expect(fake.pushed).toHaveLength(3); // flushes are not pushes
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

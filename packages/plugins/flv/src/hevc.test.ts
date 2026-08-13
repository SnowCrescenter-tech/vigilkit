import { describe, expect, it } from 'vitest';
import { parseEnhancedHevcHeader, readSi24Cts, unwrapHvccBox } from './hevc.js';

const HVC1 = new TextEncoder().encode('hvc1');
const HVCC = new TextEncoder().encode('hvcc');

/** A 6-byte Enhanced-RTMP video header: byte0, IsExHeader byte, FourCC. */
function enhancedHeader(frameType: number, packetType: number): Uint8Array {
  const out = new Uint8Array(6);
  out[0] = (frameType << 4) | packetType;
  out[1] = 0x80; // IsExHeader
  out.set(HVC1, 2);
  return out;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** A 23-byte hvcC-shaped record (configurationVersion 1 plus filler). */
const RECORD = new Uint8Array([0x01, ...new Uint8Array(22)]);

describe('parseEnhancedHevcHeader', () => {
  it('extracts frame type, packet type and FourCC from an enhanced header', () => {
    expect(parseEnhancedHevcHeader(enhancedHeader(1, 0))).toEqual({
      frameType: 'key',
      packetType: 0,
      fourCC: 'hvc1',
    });
    expect(parseEnhancedHevcHeader(enhancedHeader(2, 1))).toEqual({
      frameType: 'delta',
      packetType: 1,
      fourCC: 'hvc1',
    });
    expect(parseEnhancedHevcHeader(enhancedHeader(2, 5))).toEqual({
      frameType: 'delta',
      packetType: 5,
      fourCC: 'hvc1',
    });
  });

  it('returns null when the IsExHeader bit is clear', () => {
    expect(parseEnhancedHevcHeader(new Uint8Array([0x11, 0x00, ...HVC1]))).toBeNull();
  });

  it('returns null for a non-HEVC FourCC', () => {
    expect(parseEnhancedHevcHeader(new Uint8Array([0x11, 0x80, ...new TextEncoder().encode('avc1')]))).toBeNull();
  });

  it('returns null when the buffer is shorter than the 6-byte header', () => {
    expect(parseEnhancedHevcHeader(new Uint8Array(0))).toBeNull();
    expect(parseEnhancedHevcHeader(new Uint8Array([0x11, 0x80, 0x68, 0x76, 0x63]))).toBeNull();
  });
});

describe('unwrapHvccBox', () => {
  it('unwraps a box-wrapped record ([u32 size][hvcc][record])', () => {
    const box = new Uint8Array(8 + RECORD.length);
    box.set(u32(4 + RECORD.length), 0);
    box.set(HVCC, 4);
    box.set(RECORD, 8);
    const out = unwrapHvccBox(box);
    expect(out).not.toBeNull();
    expect(Array.from(out as Uint8Array)).toEqual(Array.from(RECORD));
  });

  it('passes a raw hvcC record through unchanged', () => {
    expect(Array.from(unwrapHvccBox(RECORD) as Uint8Array)).toEqual(Array.from(RECORD));
  });

  it('returns null when the declared box size does not match the record', () => {
    const box = new Uint8Array(8 + RECORD.length);
    box.set(u32(4 + RECORD.length + 1), 0); // one byte larger than the payload
    box.set(HVCC, 4);
    box.set(RECORD, 8);
    expect(unwrapHvccBox(box)).toBeNull();
  });

  it('returns null for a raw buffer that does not start with configurationVersion 1', () => {
    expect(unwrapHvccBox(new Uint8Array([0x02, ...new Uint8Array(22)]))).toBeNull();
  });

  it('returns null for a buffer too short to hold a box header', () => {
    expect(unwrapHvccBox(new Uint8Array(7))).toBeNull();
  });
});

describe('readSi24Cts', () => {
  it('reads a positive 24-bit composition time offset', () => {
    expect(readSi24Cts(new Uint8Array([0x00, 0x02, 0x00]), 0)).toBe(512);
  });

  it('sign-extends a negative 24-bit composition time offset', () => {
    expect(readSi24Cts(new Uint8Array([0xff, 0xfe, 0x00]), 0)).toBe(-512);
  });

  it('reads from an explicit offset', () => {
    expect(readSi24Cts(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x00]), 2)).toBe(256);
  });
});

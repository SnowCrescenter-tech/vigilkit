import { describe, expect, it } from 'vitest';
import { ByteReader } from './byte-reader.js';
import { DemuxError } from './errors.js';

describe('ByteReader', () => {
  it('reads big-endian u8/u16/u24/u32 and advances sequentially', () => {
    const reader = new ByteReader(
      new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0xab, 0xcd]),
    );
    expect(reader.readU8()).toBe(0x12);
    expect(reader.readU16()).toBe(0x3456);
    expect(reader.readU24()).toBe(0x789abc);
    expect(reader.readU32()).toBe(0xdef0abcd);
    expect(reader.eof()).toBe(true);
    expect(reader.remaining).toBe(0);
  });

  it('reads a u32 big-endian across the full 32-bit range', () => {
    const reader = new ByteReader(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(reader.readU32()).toBe(0xdeadbeef);
    expect(reader.eof()).toBe(true);
  });

  it('exposes position and remaining', () => {
    const reader = new ByteReader(new Uint8Array([1, 2, 3, 4]));
    expect(reader.position).toBe(0);
    expect(reader.remaining).toBe(4);
    reader.skip(2);
    expect(reader.position).toBe(2);
    expect(reader.remaining).toBe(2);
  });

  it('throws DemuxError on an out-of-bounds read', () => {
    const reader = new ByteReader(new Uint8Array([0x01, 0x02]));
    expect(() => reader.readU24()).toThrow(DemuxError);
    expect(() => reader.readU32()).toThrow(/out of bounds/);
  });

  it('throws DemuxError on an out-of-bounds skip', () => {
    const reader = new ByteReader(new Uint8Array([0x01, 0x02, 0x03]));
    reader.skip(3);
    expect(reader.eof()).toBe(true);
    expect(() => reader.skip(1)).toThrow(DemuxError);
  });

  it('throws a DemuxError whose code is DEMUX', () => {
    const reader = new ByteReader(new Uint8Array([0x01]));
    let thrown: unknown;
    try {
      reader.readU16();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DemuxError);
    expect(thrown).toMatchObject({ code: 'DEMUX' });
  });
});

import { describe, expect, it } from 'vitest';
import { BitReader } from './bit-reader.js';
import { MediaFormatError } from './errors.js';

/** Packs a string of '0'/'1' into a Uint8Array, MSB-first. */
function pack(bits: string): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') {
      const index = i >> 3;
      bytes[index] = (bytes[index] as number) | (0x80 >> (i & 7));
    }
  }
  return bytes;
}

describe('BitReader', () => {
  it('reads bits across byte boundaries', () => {
    const reader = new BitReader(pack('1010010100111100'));
    expect(reader.readBits(3)).toBe(0b101);
    expect(reader.readBits(5)).toBe(0b00101);
    expect(reader.readBits(6)).toBe(0b001111);
    expect(reader.readBits(2)).toBe(0);
    expect(reader.eof()).toBe(true);
  });

  it('readBits(32) returns an unsigned value', () => {
    const reader = new BitReader(new Uint8Array([0x80, 0x00, 0x00, 0x00]));
    expect(reader.readBits(32)).toBe(0x80000000);
  });

  it('decodes ue(v) exp-Golomb codes for known values', () => {
    const codes = ['1', '010', '011', '00100', '00101', '00110', '00111', '0001000'];
    const reader = new BitReader(pack(codes.join('')));
    for (let expected = 0; expected < 8; expected++) {
      expect(reader.readUe()).toBe(expected);
    }
    expect(reader.bitPosition).toBe(codes.join('').length);
  });

  it('decodes se(v) with the signed mapping', () => {
    const codes = ['1', '010', '011', '00100', '00101']; // ue values 0..4
    const reader = new BitReader(pack(codes.join('')));
    expect(reader.readSe()).toBe(0);
    expect(reader.readSe()).toBe(1);
    expect(reader.readSe()).toBe(-1);
    expect(reader.readSe()).toBe(2);
    expect(reader.readSe()).toBe(-2);
    expect(reader.bitPosition).toBe(codes.join('').length);
  });

  it('readFlag returns a single bit as boolean', () => {
    const reader = new BitReader(pack('10'));
    expect(reader.readFlag()).toBe(true);
    expect(reader.readFlag()).toBe(false);
    expect(reader.bitPosition).toBe(2);
  });

  it('alignToByte advances to the next byte boundary', () => {
    const reader = new BitReader(new Uint8Array([0xab, 0xcd, 0xef]));
    expect(reader.readBits(5)).toBe(0b10101);
    reader.alignToByte();
    expect(reader.readBits(8)).toBe(0xcd);
  });

  it('alignToByte is a no-op when already aligned', () => {
    const reader = new BitReader(new Uint8Array([0xff]));
    reader.alignToByte();
    expect(reader.readBits(8)).toBe(0xff);
  });

  it('eof reflects whether every bit is consumed', () => {
    expect(new BitReader(new Uint8Array(0)).eof()).toBe(true);
    const reader = new BitReader(new Uint8Array([0xff]));
    expect(reader.eof()).toBe(false);
    reader.readBits(8);
    expect(reader.eof()).toBe(true);
  });

  it('throws MediaFormatError on a bit overrun', () => {
    const reader = new BitReader(new Uint8Array([0xff]));
    expect(() => reader.readBits(9)).toThrow(MediaFormatError);
    expect(() => reader.readBits(9)).toThrow(/overrun/);
  });

  it('throws MediaFormatError when a ue(v) code never terminates', () => {
    const reader = new BitReader(new Uint8Array([0x00, 0x00, 0x00]));
    expect(() => reader.readUe()).toThrow(MediaFormatError);
  });

  it('throws MediaFormatError when an exp-Golomb suffix overruns', () => {
    const reader = new BitReader(pack('00001'));
    expect(() => reader.readUe()).toThrow(MediaFormatError);
  });

  it('throws a MediaFormatError whose code is DEMUX', () => {
    let thrown: unknown;
    try {
      new BitReader(new Uint8Array([0xff])).readBits(9);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MediaFormatError);
    expect(thrown).toMatchObject({ code: 'DEMUX' });
  });
});

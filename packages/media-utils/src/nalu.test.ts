import { describe, expect, it } from 'vitest';
import { hasAnnexBStartCode, isAnnexB, isLengthPrefixed, splitAnnexBNalus } from './nalu.js';

describe('hasAnnexBStartCode', () => {
  it('detects a 3-byte start code at pos 0', () => {
    expect(hasAnnexBStartCode(new Uint8Array([0x00, 0x00, 0x01, 0x67]), 0)).toBe(true);
  });

  it('detects a 4-byte start code at pos 0', () => {
    expect(hasAnnexBStartCode(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67]), 0)).toBe(true);
  });

  it('detects a start code at a non-zero offset', () => {
    const data = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x01, 0x67, 0x42]);
    expect(hasAnnexBStartCode(data, 2)).toBe(true);
    expect(hasAnnexBStartCode(data, 0)).toBe(false);
  });

  it('does not match bytes that merely begin with zero', () => {
    expect(hasAnnexBStartCode(new Uint8Array([0x00, 0x00, 0x00, 0x00]), 0)).toBe(false);
    expect(hasAnnexBStartCode(new Uint8Array([0x00, 0x00, 0x02, 0x01]), 0)).toBe(false);
  });

  it('returns false when pos is near the end', () => {
    expect(hasAnnexBStartCode(new Uint8Array([0x00, 0x00]), 0)).toBe(false);
    expect(hasAnnexBStartCode(new Uint8Array([0x00, 0x00, 0x01]), 1)).toBe(false);
  });
});

describe('isAnnexB', () => {
  it('is true when data starts with a 3-byte start code', () => {
    expect(isAnnexB(new Uint8Array([0x00, 0x00, 0x01, 0x67, 0x42]))).toBe(true);
  });

  it('is true when data starts with a 4-byte start code', () => {
    expect(isAnnexB(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]))).toBe(true);
  });

  it('is false for random bytes', () => {
    expect(isAnnexB(new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0x95, 0x01]))).toBe(false);
    expect(isAnnexB(new Uint8Array([0xab, 0xcd, 0xef, 0x01]))).toBe(false);
  });

  it('is false for empty and too-short input', () => {
    expect(isAnnexB(new Uint8Array(0))).toBe(false);
    expect(isAnnexB(new Uint8Array([0x00, 0x00]))).toBe(false);
  });
});

describe('splitAnnexBNalus', () => {
  it('splits a single NALU with a 3-byte start code', () => {
    const nalus = splitAnnexBNalus(new Uint8Array([0x00, 0x00, 0x01, 0x67, 0x42, 0x00]));
    expect(nalus).toHaveLength(1);
    expect(Array.from(nalus[0] as Uint8Array)).toEqual([0x67, 0x42, 0x00]);
  });

  it('splits multiple NALUs with mixed 3-byte and 4-byte start codes', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, //
      0x00, 0x00, 0x01, 0x41, 0x9a, 0x22, //
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f,
    ]);
    const nalus = splitAnnexBNalus(data);
    expect(nalus).toHaveLength(3);
    expect(Array.from(nalus[0] as Uint8Array)).toEqual([0x65, 0x88, 0x84]);
    expect(Array.from(nalus[1] as Uint8Array)).toEqual([0x41, 0x9a, 0x22]);
    expect(Array.from(nalus[2] as Uint8Array)).toEqual([0x67, 0x42, 0x00, 0x1f]);
  });

  it('discards leading garbage before the first start code', () => {
    const data = new Uint8Array([0xff, 0xee, 0x00, 0x00, 0x01, 0x67, 0x42]);
    const nalus = splitAnnexBNalus(data);
    expect(nalus).toHaveLength(1);
    expect(Array.from(nalus[0] as Uint8Array)).toEqual([0x67, 0x42]);
  });

  it('returns an empty array when no start code is present', () => {
    expect(splitAnnexBNalus(new Uint8Array([0x67, 0x42, 0x00, 0x1f]))).toEqual([]);
    expect(splitAnnexBNalus(new Uint8Array(0))).toEqual([]);
  });

  it('includes a partial trailing NALU without a closing start code', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x01, 0x65, 0x88, //
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, // trailing NAL with no end code
    ]);
    const nalus = splitAnnexBNalus(data);
    expect(nalus).toHaveLength(2);
    expect(Array.from(nalus[0] as Uint8Array)).toEqual([0x65, 0x88]);
    expect(Array.from(nalus[1] as Uint8Array)).toEqual([0x67, 0x42]);
  });
});

describe('isLengthPrefixed', () => {
  it('is true when the 4-byte length matches the remaining bytes', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x67, 0x42, 0x00]);
    expect(isLengthPrefixed(data)).toBe(true);
  });

  it('is false when the 4-byte length does not match', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x05, 0x67, 0x42, 0x00]);
    expect(isLengthPrefixed(data)).toBe(false);
  });

  it('is false for empty and too-short input', () => {
    expect(isLengthPrefixed(new Uint8Array(0))).toBe(false);
    expect(isLengthPrefixed(new Uint8Array([0x00, 0x00, 0x01]))).toBe(false);
  });
});

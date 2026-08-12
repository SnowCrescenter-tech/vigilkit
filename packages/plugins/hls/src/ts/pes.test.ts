import { describe, expect, it } from 'vitest';
import { parsePesHeader } from './pes.js';

function tsBytes(value: number, marker: number): number[] {
  return [
    0x01 | (marker << 4) | ((Math.floor(value / 0x40000000) & 7) << 1),
    Math.floor(value / 0x400000) & 0xff,
    0x01 | ((Math.floor(value / 0x8000) & 0x7f) << 1),
    Math.floor(value / 0x80) & 0xff,
    0x01 | ((value & 0x7f) << 1),
  ];
}

function pesHeader(streamId: number, pts?: number, dts?: number): Uint8Array {
  const hasPts = pts !== undefined;
  const hasDts = dts !== undefined;
  const ptsDtsFlags = hasPts ? (hasDts ? 0x30 : 0x20) : 0;
  const optional: number[] = [];
  if (hasPts) optional.push(...tsBytes(pts as number, 2));
  if (hasDts) optional.push(...tsBytes(dts as number, 1));
  const out = new Uint8Array(9 + optional.length);
  out[0] = 0;
  out[1] = 0;
  out[2] = 1;
  out[3] = streamId;
  out[4] = 0;
  out[5] = 0;
  out[6] = 0x80 | ptsDtsFlags;
  out[7] = 0;
  out[8] = optional.length;
  out.set(optional, 9);
  return out;
}

describe('parsePesHeader', () => {
  it('parses PTS only and reports header length', () => {
    const header = parsePesHeader(pesHeader(0xe0, 90000));
    expect(header).not.toBeNull();
    expect(header?.streamId).toBe(0xe0);
    expect(header?.ptsUs).toBeCloseTo(1_000_000, 0); // 90000 * 100/9
    expect(header?.dtsUs).toBeUndefined();
    expect(header?.headerLength).toBe(14);
  });

  it('parses PTS + DTS', () => {
    const header = parsePesHeader(pesHeader(0xe0, 90000, 81000));
    expect(header?.ptsUs).toBeCloseTo(1_000_000, 0);
    expect(header?.dtsUs).toBeCloseTo(900_000, 0);
  });

  it('returns null for a non-PES start', () => {
    expect(parsePesHeader(new Uint8Array([0x00, 0x00, 0x02, 0xe0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('returns null for too-short payloads', () => {
    expect(parsePesHeader(new Uint8Array([0, 0, 1, 0xe0, 0, 0, 0]))).toBeNull();
  });

  it('handles stream ids without an optional header (padding)', () => {
    const header = parsePesHeader(new Uint8Array([0, 0, 1, 0xbe, 0, 0]));
    expect(header?.headerLength).toBe(6);
    expect(header?.ptsUs).toBeUndefined();
  });

  it('returns null for sub-6-byte buffers', () => {
    expect(parsePesHeader(new Uint8Array([0, 0, 1]))).toBeNull();
  });
});

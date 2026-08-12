import { describe, expect, it } from 'vitest';
import { parseAvcC, naluToAnnexB } from './avc.js';
import { DemuxError } from './errors.js';

const AVC_CONFIG = new Uint8Array([
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x05, 0x67, 0x42, 0x00, 0x1f, 0x95, 0x01, 0x00,
]);

describe('parseAvcC', () => {
  it('derives avc1.codec from profile/compat/level and keeps description as a copy', () => {
    const config = parseAvcC(AVC_CONFIG);
    expect(config.codec).toBe('avc1.64001f');
    expect(config.description).toEqual(AVC_CONFIG);
    expect(config.description).not.toBe(AVC_CONFIG);
  });

  it('lowercases hex digits in the codec string', () => {
    const config = parseAvcC(new Uint8Array([0x01, 0x4d, 0x40, 0x15, 0xff, 0xe1, 0x00]));
    expect(config.codec).toBe('avc1.4d4015');
  });

  it('throws DemuxError for an avcC shorter than 7 bytes', () => {
    expect(() => parseAvcC(new Uint8Array([0x01, 0x64, 0x00, 0x1f, 0xff]))).toThrow(DemuxError);
  });
});

describe('naluToAnnexB', () => {
  it('converts a single length-prefixed NALU to Annex-B', () => {
    const nalu = new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x67, 0x42, 0x00]);
    expect(Array.from(naluToAnnexB(nalu))).toEqual([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00]);
  });

  it('converts multiple NALUs, preserving payload bytes', () => {
    const nalu = new Uint8Array([
      0x00, 0x00, 0x00, 0x03, 0x67, 0x42, 0x00, //
      0x00, 0x00, 0x00, 0x05, 0x68, 0xce, 0x3c, 0x80, 0x01,
    ]);
    expect(Array.from(naluToAnnexB(nalu))).toEqual([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, //
      0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80, 0x01,
    ]);
  });

  it('throws DemuxError when a length prefix exceeds the buffer', () => {
    const nalu = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x67]);
    expect(() => naluToAnnexB(nalu)).toThrow(DemuxError);
  });

  it('returns an empty buffer for empty input', () => {
    expect(naluToAnnexB(new Uint8Array(0)).length).toBe(0);
  });
});

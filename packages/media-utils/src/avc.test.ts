import { describe, expect, it } from 'vitest';
import { annexBToAvcc, buildAvcC, codecStringFromSps, naluToAnnexB, parseAvcC } from './avc.js';
import { MediaFormatError } from './errors.js';

const AVC_CONFIG = new Uint8Array([
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x05, 0x67, 0x42, 0x00, 0x1f, 0x95, 0x01, 0x00,
]);

describe('parseAvcC', () => {
  it('derives the codec string and description from a known record', () => {
    const config = parseAvcC(AVC_CONFIG);
    expect(config.codec).toBe('avc1.64001f');
    expect(config.description).toEqual(AVC_CONFIG);
    expect(config.description).not.toBe(AVC_CONFIG);
  });

  it('lowercases hex digits in the codec string', () => {
    const config = parseAvcC(new Uint8Array([0x01, 0x4d, 0x40, 0x15, 0xff, 0xe1, 0x00]));
    expect(config.codec).toBe('avc1.4d4015');
  });

  it('throws MediaFormatError when shorter than 7 bytes', () => {
    expect(() => parseAvcC(new Uint8Array([0x01, 0x64, 0x00, 0x1f, 0xff]))).toThrow(MediaFormatError);
  });
});

describe('codecStringFromSps', () => {
  it('builds avc1.xxxxxx from SPS profile/constraint/level', () => {
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0x95, 0x01, 0x00]);
    expect(codecStringFromSps(sps)).toBe('avc1.64001f');
  });

  it('lowercases hex digits', () => {
    const sps = new Uint8Array([0x67, 0x4d, 0x40, 0x15]);
    expect(codecStringFromSps(sps)).toBe('avc1.4d4015');
  });

  it('throws MediaFormatError when shorter than 4 bytes', () => {
    expect(() => codecStringFromSps(new Uint8Array([0x67, 0x64, 0x00]))).toThrow(MediaFormatError);
  });
});

describe('buildAvcC', () => {
  it('round-trips: buildAvcC(sps, pps) parses back with matching profile bytes and sps+pps payload', () => {
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0x95, 0x01, 0x00]);
    const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
    const record = buildAvcC(sps, pps);
    const config = parseAvcC(record);
    expect(config.codec).toBe('avc1.64001f');
    expect(Array.from(record.slice(1, 4))).toEqual([0x64, 0x00, 0x1f]);
    // description is a copy of the record containing sps and pps verbatim
    expect(Array.from(config.description)).toEqual(Array.from(record));
    const joined = Array.from(record);
    const spsIndex = joined.indexOf(0x67);
    expect(joined.slice(spsIndex, spsIndex + sps.length)).toEqual(Array.from(sps));
    expect(joined).toEqual(
      expect.arrayContaining([
        0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x07, // configVersion..spsLen
        ...sps,
        0x01, 0x00, 0x04, // numPps, ppsLen
        ...pps,
      ]),
    );
  });

  it('honours a custom lengthSize', () => {
    const record = buildAvcC(
      new Uint8Array([0x67, 0x64, 0x00, 0x1f]),
      new Uint8Array([0x68, 0xce]),
      2,
    );
    // lengthSizeMinusOne byte = 0xFC | (lengthSize - 1)
    expect(record[4]).toBe(0xfc | 1);
  });
});

describe('annexBToAvcc', () => {
  it('re-prefixes Annex-B NALUs with 4-byte big-endian lengths', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, //
      0x00, 0x00, 0x01, 0x41, 0x9a, 0x22,
    ]);
    const avcc = annexBToAvcc(data);
    expect(Array.from(avcc)).toEqual([
      0x00, 0x00, 0x00, 0x03, 0x65, 0x88, 0x84, //
      0x00, 0x00, 0x00, 0x03, 0x41, 0x9a, 0x22,
    ]);
  });

  it('round-trips: naluToAnnexB(annexBToAvcc(x)) deep-equals x for 4-byte start codes', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, //
      0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x22, //
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00,
    ]);
    const avcc = annexBToAvcc(data);
    expect(naluToAnnexB(avcc)).toEqual(data);
  });

  it('returns an empty buffer for empty input', () => {
    expect(annexBToAvcc(new Uint8Array(0)).length).toBe(0);
  });

  it('throws MediaFormatError when no NALU is found', () => {
    expect(() => annexBToAvcc(new Uint8Array([0x67, 0x42, 0x00, 0x1f]))).toThrow(MediaFormatError);
    expect(() => annexBToAvcc(new Uint8Array([0x67, 0x42, 0x00, 0x1f]))).toThrow(/no NALU found/);
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

  it('throws MediaFormatError when a length prefix exceeds the buffer', () => {
    const nalu = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x67]);
    expect(() => naluToAnnexB(nalu)).toThrow(MediaFormatError);
    expect(() => naluToAnnexB(nalu)).toThrow(/truncated/);
  });

  it('returns an empty buffer for empty input', () => {
    expect(naluToAnnexB(new Uint8Array(0)).length).toBe(0);
  });
});

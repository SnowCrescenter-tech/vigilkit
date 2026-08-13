import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MediaFormatError } from './errors.js';
import { splitAnnexBNalus } from './nalu.js';
import {
  buildHvcC,
  codecStringFromHvcC,
  parseHvcC,
  parseHevcSps,
  parseHevcVps,
  removeEmulationPrevention,
} from './hevc.js';

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../../examples/basic/hevc-fixtures/paired_fields.hevc', import.meta.url)),
);

function findNalu(nalus: Uint8Array[], type: number): Uint8Array {
  const nalu = nalus.find((n) => (((n[0] as number) >> 1) & 0x3f) === type);
  if (!nalu) throw new Error(`missing NAL type ${type}`);
  return nalu;
}

describe('removeEmulationPrevention', () => {
  it('strips a 0x03 inserted after two zero bytes', () => {
    expect(Array.from(removeEmulationPrevention(new Uint8Array([0, 0, 3, 1])))).toEqual([0, 0, 1]);
  });

  it('strips multiple emulation-prevention bytes', () => {
    expect(Array.from(removeEmulationPrevention(new Uint8Array([0, 0, 3, 0, 0, 3, 1])))).toEqual([
      0, 0, 0, 0, 1,
    ]);
  });

  it('treats 0x00000300 as 0x03 stripped, keeping the trailing 0x00', () => {
    expect(Array.from(removeEmulationPrevention(new Uint8Array([0, 0, 3, 0])))).toEqual([0, 0, 0]);
  });

  it('does not strip a 0x03 that does not follow two zeros', () => {
    expect(Array.from(removeEmulationPrevention(new Uint8Array([1, 0, 0, 2, 0, 0, 4, 0, 3, 5])))).toEqual(
      [1, 0, 0, 2, 0, 0, 4, 0, 3, 5],
    );
  });

  it('does not mutate its input', () => {
    const data = new Uint8Array([0, 0, 3, 1]);
    removeEmulationPrevention(data);
    expect(Array.from(data)).toEqual([0, 0, 3, 1]);
  });
});

describe('synthetic parameter sets', () => {
  // VPS: vps_video_parameter_set_id=0, max_layers=1, max_sub_layers=1,
  // temporal_id_nesting=1, general profile 1/tier 0/level 93,
  // compat 0x60000000, constraint 0x0000000000B0.
  const VPS = new Uint8Array([
    0x40, 0x01, // NAL header: VPS (type 32), temporal_id_plus1 = 1
    0x00, 0x01, // id=0, reserved=0, max_layers_minus1=0, max_sub_layers_minus1=0, nesting=1
    0xff, 0xff, // vps_reserved_0xffff_16bits
    0x01, // general_profile_space=0, tier=0, profile_idc=1
    0x60, 0x00, 0x00, 0x00, // general_profile_compatibility_flags
    0x00, 0x00, 0x00, 0x00, 0x00, 0xb0, // general_constraint_indicator_flags
    0x5d, // general_level_idc = 93
  ]);
  // SPS: sps_video_parameter_set_id=0, max_sub_layers_minus1=0, nesting=1,
  // same general fields as the VPS, chroma_format_idc=1, bit depths 0.
  const SPS = new Uint8Array([
    0x42, 0x01, // NAL header: SPS (type 33)
    0x01, // id=0, max_sub_layers_minus1=0, temporal_id_nesting_flag=1
    0x01, // general_profile_space=0, tier=0, profile_idc=1
    0x60, 0x00, 0x00, 0x00, // general_profile_compatibility_flags
    0x00, 0x00, 0x00, 0x00, 0x00, 0xb0, // general_constraint_indicator_flags
    0x5d, // general_level_idc = 93
    // sps_seq_parameter_set_id ue=0, chroma_format_idc ue=1, width ue=16,
    // height ue=16, conformance_window_flag=0, bit_depth_luma_minus8 ue=0,
    // bit_depth_chroma_minus8 ue=0, rbsp_trailing_bits
    0xa0, 0x88, 0x45, 0x80,
  ]);
  const PPS = new Uint8Array([0x44, 0x01, 0x00, 0x00, 0x00]);

  it('parseHevcSps recovers the synthetic fields', () => {
    const info = parseHevcSps(SPS);
    expect(info.generalProfileIdc).toBe(1);
    expect(info.generalTierFlag).toBe(0);
    expect(info.generalLevelIdc).toBe(93);
    expect(info.generalProfileCompatibilityFlags).toBe(0x60000000);
    expect(Array.from(info.generalConstraintIndicatorFlags)).toEqual([0, 0, 0, 0, 0, 0xb0]);
    expect(info.maxSubLayersMinus1).toBe(0);
    expect(info.temporalIdNestingFlag).toBe(1);
    expect(info.chromaFormatIdc).toBe(1);
    expect(info.bitDepthLumaMinus8).toBe(0);
    expect(info.bitDepthChromaMinus8).toBe(0);
  });

  it('parseHevcVps recovers the synthetic general fields', () => {
    const info = parseHevcVps(VPS);
    expect(info.generalProfileIdc).toBe(1);
    expect(info.generalTierFlag).toBe(0);
    expect(info.generalLevelIdc).toBe(93);
    expect(info.generalProfileCompatibilityFlags).toBe(0x60000000);
    expect(Array.from(info.generalConstraintIndicatorFlags)).toEqual([0, 0, 0, 0, 0, 0xb0]);
  });

  it('buildHvcC produces the hand-computed record byte-for-byte', () => {
    const record = buildHvcC({ vps: VPS, sps: SPS, pps: PPS });
    const expected = new Uint8Array([
      0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xb0, 0x5d, // header
      0xf0, 0x00, 0xfc, 0xfd, 0xf8, 0xf8, 0x00, 0x00, 0x0f, 0x03, // profile ext..numOfArrays
      0xa0, 0x00, 0x01, 0x00, 0x12, ...VPS, // array: VPS (type 32)
      0xa1, 0x00, 0x01, 0x00, 0x13, ...SPS, // array: SPS (type 33)
      0xa2, 0x00, 0x01, 0x00, 0x05, ...PPS, // array: PPS (type 34)
    ]);
    expect(Array.from(record)).toEqual(Array.from(expected));
    expect(record.length).toBe(80);
  });

  it('derives the canonical hvc1 codec string', () => {
    const record = buildHvcC({ vps: VPS, sps: SPS, pps: PPS });
    expect(parseHvcC(record).codec).toBe('hvc1.1.6.L93.B0');
    expect(codecStringFromHvcC(record)).toBe('hvc1.1.6.L93.B0');
  });

  it('round-trips buildHvcC → parseHvcC', () => {
    const record = buildHvcC({ vps: VPS, sps: SPS, pps: PPS, lengthSizeMinusOne: 1 });
    const parsed = parseHvcC(record);
    expect(parsed.profileIdc).toBe(1);
    expect(parsed.levelIdc).toBe(93);
    expect(parsed.lengthSizeMinusOne).toBe(1);
    expect(Array.from(parsed.description)).toEqual(Array.from(record));
    expect(parsed.arrays.map((a) => a.naluType)).toEqual([32, 33, 34]);
    expect(parsed.arrays).toHaveLength(3);
    expect(Array.from(parsed.arrays[0]?.nalus[0] as Uint8Array)).toEqual(Array.from(VPS));
    expect(Array.from(parsed.arrays[1]?.nalus[0] as Uint8Array)).toEqual(Array.from(SPS));
    expect(Array.from(parsed.arrays[2]?.nalus[0] as Uint8Array)).toEqual(Array.from(PPS));
  });

  it('throws MediaFormatError when the SPS is malformed', () => {
    expect(() =>
      buildHvcC({ vps: VPS, sps: new Uint8Array([0x42, 0x01]), pps: PPS }),
    ).toThrow(MediaFormatError);
  });

  it('throws MediaFormatError for a header-only SPS/VPS', () => {
    expect(() => parseHevcSps(new Uint8Array([0x42]))).toThrow(MediaFormatError);
    expect(() => parseHevcVps(new Uint8Array([0x40]))).toThrow(MediaFormatError);
  });
});

describe('real fixture: examples/basic/hevc-fixtures/paired_fields.hevc', () => {
  const nalus = splitAnnexBNalus(FIXTURE);
  const vps = findNalu(nalus, 32);
  const sps = findNalu(nalus, 33);
  const pps = findNalu(nalus, 34);

  it('splits the fixture into NALUs containing the parameter sets', () => {
    expect(nalus.length).toBeGreaterThan(10);
    expect(vps.length).toBeGreaterThan(2);
    expect(sps.length).toBeGreaterThan(2);
    expect(pps.length).toBeGreaterThan(2);
  });

  it('parseHevcSps extracts sane fields from the real SPS', () => {
    const info = parseHevcSps(sps);
    expect(info.generalProfileIdc).toBeGreaterThan(0);
    expect(info.generalLevelIdc).toBeGreaterThan(0);
    expect(info.generalProfileIdc).toBe(4);
    expect(info.generalLevelIdc).toBe(123);
    expect(info.chromaFormatIdc).toBe(2);
    expect(info.bitDepthLumaMinus8).toBe(2);
    expect(info.bitDepthChromaMinus8).toBe(2);
  });

  it('parseHevcVps agrees with the SPS general fields', () => {
    const vpsInfo = parseHevcVps(vps);
    const spsInfo = parseHevcSps(sps);
    expect(vpsInfo.generalProfileIdc).toBe(spsInfo.generalProfileIdc);
    expect(vpsInfo.generalTierFlag).toBe(spsInfo.generalTierFlag);
    expect(vpsInfo.generalLevelIdc).toBe(spsInfo.generalLevelIdc);
    expect(vpsInfo.generalProfileCompatibilityFlags).toBe(spsInfo.generalProfileCompatibilityFlags);
    expect(Array.from(vpsInfo.generalConstraintIndicatorFlags)).toEqual(
      Array.from(spsInfo.generalConstraintIndicatorFlags),
    );
  });

  it('buildHvcC → parseHvcC round-trips with a well-formed codec string', () => {
    const record = buildHvcC({ vps, sps, pps });
    const parsed = parseHvcC(record);
    expect(parsed.codec).toMatch(/^hvc1\.\d+\.[0-9a-f]+\.(L|H)\d+(\.\w+)*$/);
    expect(parsed.codec).toBe(codecStringFromHvcC(record));
    expect(parsed.profileIdc).toBe(4);
    expect(parsed.levelIdc).toBe(123);
    expect(parsed.lengthSizeMinusOne).toBe(3);
    expect(parsed.arrays.map((a) => a.naluType)).toEqual([32, 33, 34]);
    expect(Array.from(parsed.arrays[0]?.nalus[0] as Uint8Array)).toEqual(Array.from(vps));
    expect(Array.from(parsed.arrays[1]?.nalus[0] as Uint8Array)).toEqual(Array.from(sps));
    expect(Array.from(parsed.arrays[2]?.nalus[0] as Uint8Array)).toEqual(Array.from(pps));
    expect(Array.from(parsed.description)).toEqual(Array.from(record));
  });
});

describe('parseHvcC malformed records', () => {
  const VPS = new Uint8Array([
    0x40, 0x01, 0x00, 0x01, 0xff, 0xff, 0x01, 0x60, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0xb0, 0x5d,
  ]);
  const SPS = new Uint8Array([
    0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xb0, 0x5d,
    0xa0, 0x88, 0x45, 0x80,
  ]);
  const PPS = new Uint8Array([0x44, 0x01, 0x00, 0x00, 0x00]);

  it('throws MediaFormatError for a record shorter than 23 bytes', () => {
    expect(() => parseHvcC(new Uint8Array(22))).toThrow(MediaFormatError);
    expect(() => parseHvcC(new Uint8Array(22))).toThrow(/shorter than 23/);
    expect(() => codecStringFromHvcC(new Uint8Array(5))).toThrow(MediaFormatError);
  });

  it('throws MediaFormatError for a bad configurationVersion', () => {
    const record = buildHvcC({ vps: VPS, sps: SPS, pps: PPS });
    record[0] = 2;
    expect(() => parseHvcC(record)).toThrow(MediaFormatError);
    expect(() => parseHvcC(record)).toThrow(/configurationVersion/);
  });

  it('throws MediaFormatError when an array NALU length overruns the record', () => {
    const record = buildHvcC({ vps: VPS, sps: SPS, pps: PPS });
    record[26] = 0xff; // corrupt the first NAL length high byte
    expect(() => parseHvcC(record)).toThrow(MediaFormatError);
  });
});

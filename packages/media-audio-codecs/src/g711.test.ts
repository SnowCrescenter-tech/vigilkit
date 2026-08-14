import { describe, expect, it } from 'vitest';
import {
  alawDecode, alawDecodeSample, alawEncode, alawEncodeSample,
  ulawDecode, ulawDecodeSample, ulawEncode, ulawEncodeSample,
} from './g711.js';

/**
 * Reference vectors from the CCITT G.711 reference implementation (Python
 * audioop, which copies the CCITT specification tables). Generated
 * programmatically from audioop: encode pairs are sample -> [ulaw, alaw];
 * decode tables are the exact 256-entry expansion tables.
 */
const ENCODE_VECTORS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0xff, 0xd5], [1, 0xff, 0xd5], [2, 0xff, 0xd5], [3, 0xff, 0xd5], [7, 0xfe, 0xd5],
  [8, 0xfe, 0xd5], [9, 0xfe, 0xd5], [15, 0xfd, 0xd5], [16, 0xfd, 0xd4], [17, 0xfd, 0xd4],
  [31, 0xfb, 0xd4], [32, 0xfb, 0xd7], [33, 0xfb, 0xd7], [63, 0xf7, 0xd6], [64, 0xf7, 0xd1],
  [65, 0xf7, 0xd1], [127, 0xef, 0xd2], [128, 0xef, 0xdd], [129, 0xef, 0xdd], [255, 0xe7, 0xda],
  [256, 0xe7, 0xc5], [257, 0xe7, 0xc5], [511, 0xdb, 0xca], [512, 0xdb, 0xf5], [513, 0xdb, 0xf5],
  [1023, 0xcd, 0xfa], [1024, 0xcd, 0xe5], [2047, 0xbe, 0xea], [2048, 0xbe, 0x95], [4095, 0xaf, 0x9a],
  [4096, 0xaf, 0x85], [8191, 0x9f, 0x8a], [8192, 0x9f, 0xb5], [16383, 0x8f, 0xba], [16384, 0x8f, 0xa5],
  [32635, 0x80, 0xaa], [-1, 0x7e, 0x55], [-2, 0x7e, 0x55], [-8, 0x7e, 0x55], [-9, 0x7d, 0x55],
  [-16, 0x7d, 0x55], [-17, 0x7c, 0x54], [-32, 0x7b, 0x54], [-33, 0x7a, 0x57], [-64, 0x77, 0x56],
  [-65, 0x76, 0x51], [-128, 0x6f, 0x52], [-129, 0x6f, 0x5d], [-256, 0x67, 0x5a], [-257, 0x67, 0x45],
  [-512, 0x5b, 0x4a], [-513, 0x5b, 0x75], [-1024, 0x4d, 0x7a], [-1025, 0x4d, 0x65], [-2048, 0x3e, 0x6a],
  [-4096, 0x2f, 0x1a], [-8192, 0x1f, 0xa], [-16384, 0xf, 0x3a], [-31608, 0x1, 0x2b], [-31609, 0x0, 0x2b],
  [-31744, 0x0, 0x2b], [-32768, 0x0, 0x2a],
];

const ULAW_DECODE: readonly number[] = [
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956, -23932, -22908, -21884, -20860,
  -19836, -18812, -17788, -16764, -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316, -7932, -7676, -7420, -7164,
  -6908, -6652, -6396, -6140, -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004, -2876, -2748, -2620, -2492,
  -2364, -2236, -2108, -1980, -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924, -876, -844, -812, -780,
  -748, -716, -684, -652, -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260, -244, -228, -212, -196,
  -180, -164, -148, -132, -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0, 32124, 31100, 30076, 29052,
  28028, 27004, 25980, 24956, 23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412, 11900, 11388, 10876, 10364,
  9852, 9340, 8828, 8316, 7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092, 3900, 3772, 3644, 3516,
  3388, 3260, 3132, 3004, 2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436, 1372, 1308, 1244, 1180,
  1116, 1052, 988, 924, 876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396, 372, 356, 340, 324,
  308, 292, 276, 260, 244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64, 56, 48, 40, 32,
  24, 16, 8, 0,
];

const ALAW_DECODE: readonly number[] = [
  -5504, -5248, -6016, -5760, -4480, -4224, -4992, -4736, -7552, -7296, -8064, -7808,
  -6528, -6272, -7040, -6784, -2752, -2624, -3008, -2880, -2240, -2112, -2496, -2368,
  -3776, -3648, -4032, -3904, -3264, -3136, -3520, -3392, -22016, -20992, -24064, -23040,
  -17920, -16896, -19968, -18944, -30208, -29184, -32256, -31232, -26112, -25088, -28160, -27136,
  -11008, -10496, -12032, -11520, -8960, -8448, -9984, -9472, -15104, -14592, -16128, -15616,
  -13056, -12544, -14080, -13568, -344, -328, -376, -360, -280, -264, -312, -296,
  -472, -456, -504, -488, -408, -392, -440, -424, -88, -72, -120, -104,
  -24, -8, -56, -40, -216, -200, -248, -232, -152, -136, -184, -168,
  -1376, -1312, -1504, -1440, -1120, -1056, -1248, -1184, -1888, -1824, -2016, -1952,
  -1632, -1568, -1760, -1696, -688, -656, -752, -720, -560, -528, -624, -592,
  -944, -912, -1008, -976, -816, -784, -880, -848, 5504, 5248, 6016, 5760,
  4480, 4224, 4992, 4736, 7552, 7296, 8064, 7808, 6528, 6272, 7040, 6784,
  2752, 2624, 3008, 2880, 2240, 2112, 2496, 2368, 3776, 3648, 4032, 3904,
  3264, 3136, 3520, 3392, 22016, 20992, 24064, 23040, 17920, 16896, 19968, 18944,
  30208, 29184, 32256, 31232, 26112, 25088, 28160, 27136, 11008, 10496, 12032, 11520,
  8960, 8448, 9984, 9472, 15104, 14592, 16128, 15616, 13056, 12544, 14080, 13568,
  344, 328, 376, 360, 280, 264, 312, 296, 472, 456, 504, 488,
  408, 392, 440, 424, 88, 72, 120, 104, 24, 8, 56, 40,
  216, 200, 248, 232, 152, 136, 184, 168, 1376, 1312, 1504, 1440,
  1120, 1056, 1248, 1184, 1888, 1824, 2016, 1952, 1632, 1568, 1760, 1696,
  688, 656, 752, 720, 560, 528, 624, 592, 944, 912, 1008, 976,
  816, 784, 880, 848,
];

function sweep(step = 1): Int16Array {
  const values: number[] = [];
  for (let v = -32768; v <= 32767; v += step) values.push(v);
  return Int16Array.from(values);
}

/**
 * Segment-aware round-trip tolerances, calibrated against the CCITT reference
 * (Python audioop) maximum per-segment error. G.711 companding is lossy: the
 * quantization step doubles per segment (μ-law step = 2^(seg+3), A-law step =
 * 2^(seg+3) for seg>=1, 16 for seg 0), so the error bound must grow with the
 * segment. Measured maxima: μ-law {11,19,35,67,131,259,515,644}, A-law
 * {8,8,16,32,64,128,256,512}.
 */
function ulawSegment(value: number): number {
  const mag = Math.min(Math.abs(value), 32635) + 132;
  if (mag < 0x100) return 0;
  if (mag < 0x200) return 1;
  if (mag < 0x400) return 2;
  if (mag < 0x800) return 3;
  if (mag < 0x1000) return 4;
  if (mag < 0x2000) return 5;
  if (mag < 0x4000) return 6;
  return 7;
}
function ulawTolerance(value: number): number {
  // Segment step is 2^(seg+3); the measured max error is step + one LSB
  // (plus the ±3 negative-side bias), so use step + 8 with a floor of 8.
  return (1 << (ulawSegment(value) + 3)) + 8;
}

function alawSegment(value: number): number {
  const mag = Math.abs(value);
  if (mag < 256) return 0;
  if (mag < 512) return 1;
  if (mag < 1024) return 2;
  if (mag < 2048) return 3;
  if (mag < 4096) return 4;
  if (mag < 8192) return 5;
  if (mag < 16384) return 6;
  return 7;
}
function alawTolerance(value: number): number {
  // A-law step for seg 0 is 16; for seg>=1 it is 2^(seg+4). Measured max is
  // half the step for seg 0 (8) and up to the full step for the top segment
  // (512). Use the segment step as the bound.
  return alawSegment(value) === 0 ? 16 : 1 << (alawSegment(value) + 4);
}

describe('G.711 μ-law', () => {
  it('matches the CCITT reference encode table', () => {
    for (const [sample, expected] of ENCODE_VECTORS) {
      expect(ulawEncodeSample(sample), `ulawEncodeSample(${sample})`).toBe(expected);
    }
  });

  it('matches the CCITT reference decode table (all 256 codes)', () => {
    for (let code = 0; code < 256; code++) {
      expect(ulawDecodeSample(code), `ulawDecodeSample(0x${code.toString(16)})`).toBe(ULAW_DECODE[code]);
    }
  });

  it('round-trips the full int16 range within the companding tolerance', () => {
    const pcm = sweep(7);
    const decoded = ulawDecode(ulawEncode(pcm));
    for (let i = 0; i < pcm.length; i++) {
      const delta = Math.abs(decoded[i]! - pcm[i]!);
      expect(delta, `sample ${pcm[i]}`).toBeLessThanOrEqual(ulawTolerance(pcm[i]!));
    }
  });
});

describe('G.711 A-law', () => {
  it('matches the CCITT reference encode table', () => {
    for (const [sample, , expected] of ENCODE_VECTORS) {
      expect(alawEncodeSample(sample), `alawEncodeSample(${sample})`).toBe(expected);
    }
  });

  it('matches the CCITT reference decode table (all 256 codes)', () => {
    for (let code = 0; code < 256; code++) {
      expect(alawDecodeSample(code), `alawDecodeSample(0x${code.toString(16)})`).toBe(ALAW_DECODE[code]);
    }
  });

  it('round-trips the full int16 range within the companding tolerance', () => {
    const pcm = sweep(7);
    const decoded = alawDecode(alawEncode(pcm));
    for (let i = 0; i < pcm.length; i++) {
      const delta = Math.abs(decoded[i]! - pcm[i]!);
      expect(delta, `sample ${pcm[i]}`).toBeLessThanOrEqual(alawTolerance(pcm[i]!));
    }
  });
});

describe('G.711 buffer helpers', () => {
  it('encode/decode buffers round-trip at the documented size', () => {
    const pcm = sweep(3);
    expect(ulawEncode(pcm)).toHaveLength(pcm.length);
    expect(ulawDecode(ulawEncode(pcm))).toHaveLength(pcm.length);
    expect(alawEncode(pcm)).toHaveLength(pcm.length);
    expect(alawDecode(alawEncode(pcm))).toHaveLength(pcm.length);
  });
});

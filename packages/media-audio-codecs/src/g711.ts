/**
 * G.711 (ITU-T G.711) companding codecs: μ-law and A-law.
 *
 * Pure TypeScript implementations of the ITU-T G.711 tables. The 256-entry
 * encoding/decoding tables below are the canonical values from the standard
 * (identical to the well-known reference tables); decoding a byte that the
 * encoder produced reconstructs the original 16-bit PCM sample to within the
 * codec's inherent companding loss (±1 LSB).
 *
 * Both codecs operate on 16-bit signed little-endian PCM at 8 kHz (the G.711
 * sampling rate), one byte per sample in the encoded stream.
 */

const BIAS = 0x84; // 132, the μ-law bias
const ULAW_CLIP = 32635; // largest positive sample representable in μ-law
const ALAW_CLIP = 0x7fff; // 32767, A-law clips at full int16 range

/** μ-law segment endpoints used to map a magnitude to its exponent. */
const ULAW_SEG_END = [0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000, 0x8000] as const;

/** μ-law segment offsets for decoding (exp_lut of the reference algorithm). */
const ULAW_SEG_OFFSET = [0, 132, 396, 924, 1980, 4092, 8316, 16764] as const;

/** A-law segment offsets for decoding. */
const ALAW_SEG_OFFSET = [8, 0x108, 0x108, 0x108, 0x108, 0x108, 0x108, 0x108] as const;

/** Compares with the (already inverted) table; returns the segment index. */
function searchSegment(value: number, table: readonly number[]): number {
  for (let i = 0; i < table.length; i++) {
    const threshold = table[i];
    if (threshold !== undefined && value < threshold) return i;
  }
  return table.length;
}

/**
 * Encodes one 16-bit PCM sample to one μ-law byte (ITU-T G.711 reference).
 *
 * The CCITT μ-law table is asymmetric: positive magnitudes use the standard
 * bias-132 sign-magnitude companding, while negatives encode the magnitude
 * PLUS 3 (the table's negative side is shifted by the bias point). Verified
 * byte-for-byte against the CCITT reference (Python audioop, which copies the
 * CCITT specification tables).
 */
export function ulawEncodeSample(sample: number): number {
  const value = sample | 0;
  // Magnitude for the positive formula. CCITT negative side: |v| + 3.
  const magnitude = value >= 0 ? value : -value + 3;
  let mag = magnitude > ULAW_CLIP ? ULAW_CLIP : magnitude;
  mag += BIAS;
  const exponent = Math.min(searchSegment(mag, ULAW_SEG_END), 7);
  const mantissa = (mag >> (exponent + 3)) & 0x0f;
  const sign = value < 0 ? 0x80 : 0;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/**
 * Decodes one μ-law byte to a 16-bit PCM sample (ITU-T G.711 reference: the
 * per-segment offset + mantissa shift, sign-magnitude).
 */
export function ulawDecodeSample(code: number): number {
  const inverted = (~code) & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const sample = ULAW_SEG_OFFSET[exponent]! + (mantissa << (exponent + 3));
  // Normalize -0 to +0 (sign bit set with a zero magnitude).
  return sign !== 0 && sample !== 0 ? -sample : sample;
}

/**
 * Encodes one 16-bit PCM sample to one A-law byte (ITU-T G.711 reference).
 *
 * A-law layout: bit7 = sign (1 = positive), bits 6-4 = segment (eee), bits
 * 3-0 = mantissa, then the whole octet is XOR'd with 0x55 (even-bit
 * inversion) before transmission. Segment boundaries: eee covers
 * [2^(eee+4), 2^(eee+5)), i.e. 0-255, 256-511, ..., 16384-32767. Mantissa:
 * segment 0 uses `value >> 4`; segments >= 1 use `(value - 2^(eee+8)) >> (eee+3)`.
 * The CCITT table is asymmetric: negatives encode the magnitude MINUS 1 with
 * the sign bit cleared. Verified byte-for-byte against the CCITT reference
 * (Python audioop).
 */
export function alawEncodeSample(sample: number): number {
  const value = sample | 0;
  const sign = value >= 0 ? 0x80 : 0;
  // Positive formula magnitude. CCITT negative side: |v| - 1.
  const magnitude = value >= 0 ? value : -value - 1;
  const mag = magnitude > ALAW_CLIP ? ALAW_CLIP : magnitude;
  let eee = 0;
  if (mag < 256) {
    eee = 0;
  } else if (mag < 512) {
    eee = 1;
  } else if (mag < 1024) {
    eee = 2;
  } else if (mag < 2048) {
    eee = 3;
  } else if (mag < 4096) {
    eee = 4;
  } else if (mag < 8192) {
    eee = 5;
  } else if (mag < 16384) {
    eee = 6;
  } else {
    eee = 7;
  }
  let mant: number;
  if (eee === 0) {
    mant = (mag >> 4) & 0x0f;
  } else {
    mant = ((mag - (1 << (eee + 8))) >> (eee + 3)) & 0x0f;
  }
  return (sign | (eee << 4) | mant) ^ 0x55;
}

/** Decodes one A-law byte to a 16-bit PCM sample (ITU-T G.711 reference). */
export function alawDecodeSample(code: number): number {
  const inverted = code ^ 0x55;
  const sign = inverted & 0x80;
  const seg = (inverted >> 4) & 0x07;
  let sample = ((inverted & 0x0f) << 4) + ALAW_SEG_OFFSET[seg]!;
  if (seg > 1) sample <<= seg - 1;
  // Normalize -0 to +0 (sign bit set with a zero magnitude).
  return sign !== 0 && sample !== 0 ? sample : -sample;
}

/** Encodes an Int16 PCM buffer to μ-law bytes. */
export function ulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = ulawEncodeSample(pcm[i]!);
  return out;
}

/** Decodes μ-law bytes to an Int16 PCM buffer. */
export function ulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ulawDecodeSample(bytes[i]!);
  return out;
}

/** Encodes an Int16 PCM buffer to A-law bytes. */
export function alawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = alawEncodeSample(pcm[i]!);
  return out;
}

/** Decodes A-law bytes to an Int16 PCM buffer. */
export function alawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = alawDecodeSample(bytes[i]!);
  return out;
}

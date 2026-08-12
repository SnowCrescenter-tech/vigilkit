import { ByteReader } from './byte-reader.js';
import { formatError } from './errors.js';
import { splitAnnexBNalus } from './nalu.js';

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function codecFromSps(sps: Uint8Array): string {
  // Bytes after the NAL header byte: profile_idc, constraint flags, level_idc.
  return `avc1.${hex2(sps[1] as number)}${hex2(sps[2] as number)}${hex2(sps[3] as number)}`;
}

/**
 * Parses an AVCDecoderConfigurationRecord (avcC) into its codec string and a
 * copy of the record (the `description` a decoder needs for initialization).
 */
export function parseAvcC(avcC: Uint8Array): { codec: string; description: Uint8Array } {
  if (avcC.length < 7) {
    throw formatError('malformed avcC: shorter than 7 bytes');
  }
  return {
    codec: `avc1.${hex2(avcC[1] as number)}${hex2(avcC[2] as number)}${hex2(avcC[3] as number)}`,
    description: avcC.slice(),
  };
}

/**
 * Builds the `avc1.` codec string from an SPS NAL. `sps[0]` is the NAL header
 * byte; profile/constraint/level live in bytes 1..3.
 */
export function codecStringFromSps(sps: Uint8Array): string {
  if (sps.length < 4) {
    throw formatError('malformed SPS: shorter than 4 bytes');
  }
  return codecFromSps(sps);
}

/**
 * Constructs an AVCDecoderConfigurationRecord from SPS and PPS NALUs.
 * Returns a fresh copy; the caller owns the result.
 */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array, lengthSize = 4): Uint8Array {
  const spsLen = sps.length;
  const ppsLen = pps.length;
  const record = new Uint8Array(6 + 2 + spsLen + 1 + 2 + ppsLen);
  let pos = 0;
  record[pos++] = 1; // configurationVersion
  record[pos++] = sps[1] as number; // AVCProfileIndication
  record[pos++] = sps[2] as number; // profile_compatibility
  record[pos++] = sps[3] as number; // AVCLevelIndication
  record[pos++] = 0xfc | (lengthSize - 1); // lengthSizeMinusOne (reserved bits 1)
  record[pos++] = 0xe0 | 1; // numOfSequenceParameterSets
  record[pos++] = (spsLen >> 8) & 0xff; // SPS length (high byte)
  record[pos++] = spsLen & 0xff; // SPS length (low byte)
  record.set(sps, pos);
  pos += spsLen;
  record[pos++] = 1; // numOfPictureParameterSets
  record[pos++] = (ppsLen >> 8) & 0xff; // PPS length (high byte)
  record[pos++] = ppsLen & 0xff; // PPS length (low byte)
  record.set(pps, pos);
  return record;
}

/**
 * Converts Annex-B NALU data to AVCC (length-prefixed) form. Each NALU is
 * prefixed with its 4-byte big-endian length. Throws when no NALU is found.
 */
export function annexBToAvcc(data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  const nalus = splitAnnexBNalus(data);
  if (nalus.length === 0) {
    throw formatError('no NALU found');
  }
  let total = 0;
  for (const nalu of nalus) total += 4 + nalu.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const nalu of nalus) {
    out[pos] = (nalu.length >> 24) & 0xff;
    out[pos + 1] = (nalu.length >> 16) & 0xff;
    out[pos + 2] = (nalu.length >> 8) & 0xff;
    out[pos + 3] = nalu.length & 0xff;
    pos += 4;
    out.set(nalu, pos);
    pos += nalu.length;
  }
  return out;
}

/**
 * Converts AVCC (length-prefixed) NALU data to Annex-B form by replacing each
 * 4-byte big-endian length with the `00 00 00 01` start code. Throws when a
 * length prefix exceeds the buffer.
 */
export function naluToAnnexB(data: Uint8Array): Uint8Array {
  const reader = new ByteReader(data);
  const parts: Array<{ offset: number; length: number }> = [];
  let total = 0;
  while (!reader.eof()) {
    const length = reader.readU32();
    if (length > reader.remaining) {
      throw formatError('truncated NALU length');
    }
    parts.push({ offset: reader.position, length });
    reader.skip(length);
    total += 4 + length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out[pos] = 0;
    out[pos + 1] = 0;
    out[pos + 2] = 0;
    out[pos + 3] = 1;
    pos += 4;
    out.set(data.subarray(part.offset, part.offset + part.length), pos);
    pos += part.length;
  }
  return out;
}

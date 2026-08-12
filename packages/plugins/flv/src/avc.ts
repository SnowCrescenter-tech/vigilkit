import { ByteReader } from './byte-reader.js';
import { demuxError } from './errors.js';

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/**
 * Parses an AVCDecoderConfigurationRecord (avcC) into a `VideoDecoderConfig`
 * (a WebCodecs DOM type, provided by lib.dom).
 * The codec string is `avc1.<profile><compat><level>` (2 lowercase hex digits
 * each, from avcC bytes 1..3); `description` is a copy of the avcC bytes, which
 * WebCodecs needs to decode the stream.
 */
export function parseAvcC(avcC: Uint8Array): VideoDecoderConfig {
  if (avcC.length < 7) {
    throw demuxError('DEMUX', 'malformed avcC: shorter than 7 bytes');
  }
  const profile = avcC[1] as number;
  const compatibility = avcC[2] as number;
  const level = avcC[3] as number;
  return {
    codec: `avc1.${hex2(profile)}${hex2(compatibility)}${hex2(level)}`,
    description: avcC.slice(),
  };
}

/**
 * Converts a length-prefixed (AVCC) NALU sequence to Annex-B form by replacing
 * each 4-byte big-endian length with the 4-byte start code `00 00 00 01`.
 * Handles any number of NALUs; throws if a length prefix exceeds the input.
 */
export function naluToAnnexB(nalu: Uint8Array): Uint8Array {
  const reader = new ByteReader(nalu);
  const parts: Array<{ offset: number; length: number }> = [];
  let total = 0;
  while (!reader.eof()) {
    const length = reader.readU32();
    if (length > reader.remaining) {
      throw demuxError('DEMUX', 'truncated NALU length');
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
    out.set(nalu.subarray(part.offset, part.offset + part.length), pos);
    pos += part.length;
  }
  return out;
}

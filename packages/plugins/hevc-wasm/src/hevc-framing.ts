import { hasAnnexBStartCode, isLengthPrefixed, naluToAnnexB } from '@vigilkit/media-utils';

/**
 * Framing helpers shared by the soft decoder: every push into libde265 must
 * be a self-delimiting Annex-B buffer (beginning with a complete start
 * code), because the demuxers deliver 4-byte length-prefixed chunks and the
 * raw-ES demo splits Annex-B AT start codes (chunks begin mid-start-code).
 */

/**
 * Converts demuxer chunk framing to the Annex-B elementary stream libde265
 * requires. Annex-B input (the raw-ES demo path) passes through unchanged;
 * AVCC-style 4-byte length-prefixed input (FLV/HLS HEVC demuxers) is
 * re-framed with `00 00 00 01` start codes. Framing that is neither (e.g. a
 * truncated prefix) passes through unchanged — libde265 then reports the
 * malformed stream itself.
 */
export function chunkFramingToAnnexB(data: Uint8Array): Uint8Array {
  if (data.length < 4 || hasAnnexBStartCode(data, 0)) {
    return data;
  }
  // A chunk may hold a single NALU (`isLengthPrefixed`) or a whole access
  // unit — multi-NALU keyframes carry VPS/SPS/PPS + slice, which the
  // single-NALU heuristic cannot recognize, so walk the length chain too.
  if (isLengthPrefixed(data) || isLengthPrefixedChain(data)) {
    return naluToAnnexB(data);
  }
  return data;
}

/**
 * Returns `data` unchanged when it already begins with a complete Annex-B
 * start code; otherwise strips a partial start code from the head (bare
 * zeros and/or a lone 0x01 — the splitter splits AT the start code's 1-byte)
 * and prepends `00 00 00 01` so every pushed buffer is self-delimiting.
 */
export function selfDelimitingAnnexB(data: Uint8Array): Uint8Array {
  if (data.length === 0 || hasAnnexBStartCode(data, 0)) {
    return data;
  }
  let pos = 0;
  while (pos < data.length && (data[pos] as number) === 0) {
    pos++;
  }
  if (pos < data.length && (data[pos] as number) === 1) {
    pos++;
  }
  const out = new Uint8Array(4 + data.length - pos);
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
  out.set(data.subarray(pos), 4);
  return out;
}

/** Frames NALUs (headers included) as one Annex-B buffer with 4-byte start codes. */
export function annexBFrame(nalus: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const nalu of nalus) total += 4 + nalu.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const nalu of nalus) {
    out[pos] = 0;
    out[pos + 1] = 0;
    out[pos + 2] = 0;
    out[pos + 3] = 1;
    pos += 4;
    out.set(nalu, pos);
    pos += nalu.length;
  }
  return out;
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Views a WebCodecs BufferSource (description) as a Uint8Array without copying. */
export function asUint8Array(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  if (source instanceof SharedArrayBuffer) {
    return new Uint8Array(source);
  }
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

/** True when `data` parses as a complete chain of 4-byte length-prefixed NALUs. */
function isLengthPrefixedChain(data: Uint8Array): boolean {
  let pos = 0;
  while (pos < data.length) {
    if (pos + 4 > data.length) {
      return false;
    }
    const length = readU32BE(data, pos);
    if (length === 0 || pos + 4 + length > data.length) {
      return false;
    }
    pos += 4 + length;
  }
  return true;
}

function readU32BE(data: Uint8Array, offset: number): number {
  return (
    ((((data[offset] as number) << 24) |
      ((data[offset + 1] as number) << 16) |
      ((data[offset + 2] as number) << 8) |
      (data[offset + 3] as number)) >>>
      0)
  );
}

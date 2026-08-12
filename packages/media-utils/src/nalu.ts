/**
 * Annex-B / AVCC NALU framing helpers.
 * Annex-B frames NALUs with start codes (`00 00 01` or `00 00 00 01`);
 * AVCC frames them with a 4-byte big-endian length prefix.
 */

/** Returns the length (3 or 4) of an Annex-B start code at `pos`, or 0. */
function startCodeLength(data: Uint8Array, pos: number): number {
  if (pos + 3 > data.length) return 0;
  if (data[pos] !== 0 || data[pos + 1] !== 0) return 0;
  if (data[pos + 2] === 1) return 3;
  if (pos + 4 <= data.length && data[pos + 2] === 0 && data[pos + 3] === 1) return 4;
  return 0;
}

/** True when an Annex-B start code (`00 00 01` or `00 00 00 01`) sits at `pos`. */
export function hasAnnexBStartCode(data: Uint8Array, pos: number): boolean {
  return startCodeLength(data, pos) > 0;
}

/**
 * True when the buffer begins with an Annex-B start code within its first
 * few bytes — the heuristic used to tell Annex-B from AVCC framing.
 */
export function isAnnexB(data: Uint8Array): boolean {
  const limit = Math.min(data.length - 3, 3);
  for (let pos = 0; pos <= limit; pos++) {
    if (startCodeLength(data, pos) > 0) return true;
  }
  return false;
}

/**
 * Splits Annex-B data into NALU payloads.
 * Leading garbage before the first start code is discarded; a trailing NALU
 * without a closing start code is included when non-empty.
 */
export function splitAnnexBNalus(data: Uint8Array): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  const length = data.length;

  // Skip leading garbage to the first start code.
  let i = 0;
  while (i + 3 <= length && startCodeLength(data, i) === 0) {
    i++;
  }
  if (i + 3 > length) return nalus; // no start code present

  let start = i + startCodeLength(data, i);
  i = start;
  while (i + 3 <= length) {
    const len = startCodeLength(data, i);
    if (len > 0) {
      if (i > start) nalus.push(data.slice(start, i));
      i += len;
      start = i;
    } else {
      i++;
    }
  }
  if (start < length) nalus.push(data.slice(start));
  return nalus;
}

/**
 * Heuristic for AVCC detection: the first 4-byte big-endian length equals the
 * number of remaining bytes. Empty (or sub-4-byte) input is never length-prefixed.
 */
export function isLengthPrefixed(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  const length =
    ((((data[0] as number) << 24) |
      ((data[1] as number) << 16) |
      ((data[2] as number) << 8) |
      (data[3] as number)) >>>
      0);
  return length === data.length - 4;
}

import { isAnnexB, splitAnnexBNalus } from '@vigilkit/media-utils';

/**
 * Elementary-stream helpers shared by the TS demuxer: NALU splitting
 * (Annex-B or 4-byte length-prefixed) and AVCC re-framing.
 */

/** Splits ES data into NALUs whether Annex-B or 4-byte length prefixed. */
export function splitNalus(data: Uint8Array): Uint8Array[] {
  const nalus = isAnnexB(data) ? splitAnnexBNalus(data) : splitByLengthPrefix(data);
  return nalus.filter((nalu) => nalu.length > 0 && (nalu[0] as number) !== 0xff);
}

function splitByLengthPrefix(data: Uint8Array): Uint8Array[] {
  if (data.length < 4) return [];
  const firstLength = readU32(data, 0);
  if (firstLength === 0 || firstLength > data.length - 4) return [];
  const nalus: Uint8Array[] = [];
  let pos = 0;
  while (pos + 4 <= data.length) {
    const length = readU32(data, pos);
    if (length === 0 || pos + 4 + length > data.length) break;
    nalus.push(data.slice(pos + 4, pos + 4 + length));
    pos += 4 + length;
  }
  return nalus;
}

/** Re-frames NALUs as AVCC (4-byte BE length prefix) — drops TS stuffing bytes. */
export function rebuildAvcc(nalus: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const nalu of nalus) total += 4 + nalu.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const nalu of nalus) {
    out[pos] = (nalu.length >>> 24) & 0xff;
    out[pos + 1] = (nalu.length >>> 16) & 0xff;
    out[pos + 2] = (nalu.length >>> 8) & 0xff;
    out[pos + 3] = nalu.length & 0xff;
    out.set(nalu, pos + 4);
    pos += 4 + nalu.length;
  }
  return out;
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    ((((data[offset] as number) << 24) |
      ((data[offset + 1] as number) << 16) |
      ((data[offset + 2] as number) << 8) |
      (data[offset + 3] as number)) >>>
      0)
  );
}

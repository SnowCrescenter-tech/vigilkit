/**
 * PES header parsing. Returns `null` when the buffer does not start with a
 * PES packet (packet_start_code_prefix `00 00 01`) or is too short.
 */

export interface PesHeader {
  streamId: number;
  /** Presentation timestamp in microseconds (90 kHz ticks * 100 / 9). */
  ptsUs?: number;
  dtsUs?: number;
  /** Length of the PES header in bytes; the ES payload starts here. */
  headerLength: number;
}

// stream_id values that carry no optional header fields (PES_packet_length only).
const NO_OPTIONAL_HEADER = new Set<number>([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff]);

/** Extracts the 33-bit PTS/DTS value from its 5-byte MPEG encoding. */
function readTimestamp(data: Uint8Array, offset: number): number {
  const b0 = data[offset] as number;
  const b1 = data[offset + 1] as number;
  const b2 = data[offset + 2] as number;
  const b3 = data[offset + 3] as number;
  const b4 = data[offset + 4] as number;
  return (
    ((b0 & 0x0e) >>> 1) * 0x40000000 +
    (b1 & 0xff) * 0x400000 +
    (b2 & 0xfe) * 0x4000 +
    (b3 & 0xff) * 0x80 +
    ((b4 & 0xfe) >>> 1)
  );
}

export function parsePesHeader(payload: Uint8Array): PesHeader | null {
  if (payload.length < 6) return null;
  if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return null;
  const streamId = payload[3] as number;

  if (NO_OPTIONAL_HEADER.has(streamId)) {
    return { streamId, headerLength: 6 };
  }
  if (payload.length < 9) return null;

  const flags = payload[6] as number;
  const headerDataLength = payload[8] as number;
  const ptsDtsFlags = (flags >> 4) & 0x03;
  let offset = 9;
  let ptsUs: number | undefined;
  let dtsUs: number | undefined;

  if (ptsDtsFlags === 0b10 || ptsDtsFlags === 0b11) {
    if (payload.length < offset + 5) return null;
    ptsUs = (readTimestamp(payload, offset) * 100) / 9;
    offset += 5;
  }
  if (ptsDtsFlags === 0b11) {
    if (payload.length < offset + 5) return null;
    dtsUs = (readTimestamp(payload, offset) * 100) / 9;
  }
  return { streamId, ptsUs, dtsUs, headerLength: 9 + headerDataLength };
}

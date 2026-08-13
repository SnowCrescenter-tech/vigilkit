// Enhanced-RTMP (veovera) HEVC video-tag helpers.
//
// An Enhanced-RTMP HEVC video tag replaces the legacy AVC header (codecId
// nibble + packetType byte + composition time) with a fixed 6-byte header:
//
//   byte[0]  frameType(4) | packetType(4)   — packetType: 0 SequenceStart,
//                                            1 CodedFrames, 2 SequenceEnd,
//                                            3 CodedFramesX, 4 Metadata,
//                                            5 MPEG2TSSequenceStart
//   byte[1]  IsExHeader(0x80) | reserved
//   bytes[2..5]  FourCC 'hvc1'
//
// CodedFrames payloads carry a signed 24-bit composition-time offset followed
// by length-prefixed NALUs. SequenceStart payloads carry an
// HEVCDecoderConfigurationRecord, either raw or wrapped in a de-facto
// `[u32 size]['hvcc'][record]` box (auto-detected here).

/** Size of the fixed Enhanced-RTMP video header in bytes. */
export const ENHANCED_HEADER_SIZE = 6;

const IS_EX_HEADER = 0x80;
const HVC1 = new Uint8Array([0x68, 0x76, 0x63, 0x31]); // 'hvc1'
const HVCC = new Uint8Array([0x68, 0x76, 0x63, 0x63]); // 'hvcc'
/** An hvcC record (raw or inside a box) is at least this long. */
const HVC_C_MIN_SIZE = 23;

export interface EnhancedHevcHeader {
  frameType: 'key' | 'delta';
  packetType: number;
  fourCC: string;
}

/**
 * Parses the Enhanced-RTMP header when `data` is an HEVC enhanced video tag.
 * Returns null for any other framing: missing the IsExHeader bit, a non-`hvc1`
 * FourCC, or a buffer shorter than the 6-byte header.
 */
export function parseEnhancedHevcHeader(data: Uint8Array): EnhancedHevcHeader | null {
  if (data.length < ENHANCED_HEADER_SIZE || ((data[1] as number) & IS_EX_HEADER) === 0) {
    return null;
  }
  if (!hasBytes(data, 2, HVC1)) {
    return null;
  }
  const frameType = (data[0] as number) >> 4;
  const packetType = (data[0] as number) & 0x0f;
  return { frameType: frameType === 1 ? 'key' : 'delta', packetType, fourCC: 'hvc1' };
}

/**
 * Extracts the HEVCDecoderConfigurationRecord from a SequenceStart payload,
 * auto-detecting the de-facto box wrapper (`[u32 size]['hvcc'][record]`) from a
 * raw record. Returns null when the wrapper is malformed or the raw record does
 * not start with configurationVersion 1.
 */
export function unwrapHvccBox(data: Uint8Array): Uint8Array | null {
  if (data.length < 8) {
    return null;
  }
  if (hasBytes(data, 4, HVCC)) {
    // Box-wrapped: `size` covers the 'hvcc' bytes plus the record.
    const size = readU32At(data, 0);
    if (size < 4) {
      return null;
    }
    const record = data.subarray(8);
    if (record.length !== size - 4) {
      return null;
    }
    return record;
  }
  // Raw hvcC record: configurationVersion 1 is mandatory.
  if ((data[0] as number) !== 1) {
    return null;
  }
  return data.length >= HVC_C_MIN_SIZE ? data : null;
}

/** Reads a signed 24-bit big-endian composition-time offset at `offset`. */
export function readSi24Cts(data: Uint8Array, offset: number): number {
  const value =
    (data[offset] as number) * 65536 + (data[offset + 1] as number) * 256 + (data[offset + 2] as number);
  return value >= 0x800000 ? value - 0x1000000 : value;
}

function hasBytes(data: Uint8Array, offset: number, bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if ((data[offset + i] as number) !== (bytes[i] as number)) {
      return false;
    }
  }
  return true;
}

function readU32At(data: Uint8Array, offset: number): number {
  return (
    (((data[offset] as number) << 24) |
      ((data[offset + 1] as number) << 16) |
      ((data[offset + 2] as number) << 8) |
      (data[offset + 3] as number)) >>>
    0
  );
}

// Test-only helpers for crafting synthetic FLV buffers. Not a test file and
// not exported from the package entry, so it never ships.
import { buildHvcC } from '@vigilkit/media-utils';
import type { Demuxer, DemuxerEvent } from '@vigilkit/plugin-sdk';

export const AVC_CONFIG = new Uint8Array([
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x05, 0x67, 0x42, 0x00, 0x1f, 0x95, 0x01, 0x00,
]);
export const NALU = concat(new Uint8Array([0x00, 0x00, 0x00, 0x03]), new Uint8Array([0x67, 0x42, 0x00]));

export type VideoEvent = Extract<DemuxerEvent, { type: 'video' }>;
export type SeqEvent = Extract<DemuxerEvent, { type: 'sequence-header' }>;
export type MetadataEvent = Extract<DemuxerEvent, { type: 'metadata' }>;
export type AudioEvent = Extract<DemuxerEvent, { type: 'audio' }>;
export type AudioConfigEvent = Extract<DemuxerEvent, { type: 'audio-config' }>;

export function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

export function u24(n: number): number[] {
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 9-byte FLV header + 4-byte PreviousTagSize0. */
export function header(flags = 0x05): Uint8Array {
  return new Uint8Array([0x46, 0x4c, 0x56, 0x01, flags, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00]);
}

/** Full tag: 11-byte header + payload + 4-byte prevTagSize. */
export function craftTag(tagType: number, payload: Uint8Array, timestamp = 0): Uint8Array {
  const out = new Uint8Array(11 + payload.length + 4);
  out[0] = tagType;
  out.set(u24(payload.length), 1);
  out.set(u24(timestamp & 0xffffff), 4);
  out[7] = (timestamp >>> 24) & 0xff;
  out.set(payload, 11);
  out.set(u24(11 + payload.length), 11 + payload.length);
  return out;
}

export function videoSeqTag(config: Uint8Array = AVC_CONFIG, timestamp = 0): Uint8Array {
  const payload = new Uint8Array(5 + config.length);
  payload[0] = 0x17; // frameType=1 key, codecId=7 AVC
  payload[1] = 0x00; // AVC packet type = sequence header
  payload.set(config, 5);
  return craftTag(9, payload, timestamp);
}

export function videoNaluTag(nalu: Uint8Array, frameType = 1, timestamp = 0): Uint8Array {
  const payload = new Uint8Array(5 + nalu.length);
  payload[0] = ((frameType & 0x0f) << 4) | 7;
  payload[1] = 0x01; // AVC packet type = NALU
  payload.set(nalu, 5);
  return craftTag(9, payload, timestamp);
}

export function aacTag(packetType: number, data: Uint8Array, timestamp = 0): Uint8Array {
  const payload = new Uint8Array(2 + data.length);
  payload[0] = 0xaf; // soundFormat=10 AAC
  payload[1] = packetType;
  payload.set(data, 2);
  return craftTag(8, payload, timestamp);
}

/** AMF0 number value = marker 0x00 followed by the big-endian double. */
export function amfNumber(n: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n, false);
  return new Uint8Array([0x00, ...new Uint8Array(buf)]);
}

export function metadataTag(): Uint8Array {
  const name = new TextEncoder().encode('onMetaData');
  const width = new TextEncoder().encode('width');
  const height = new TextEncoder().encode('height');
  const payload = concat(
    new Uint8Array([0x02, ...u16(name.length)]),
    name,
    new Uint8Array([0x08, ...u32(2)]),
    new Uint8Array([...u16(width.length)]),
    width,
    amfNumber(1280),
    new Uint8Array([...u16(height.length)]),
    height,
    amfNumber(720),
  );
  return craftTag(18, payload);
}

export function collect(demuxer: Demuxer): DemuxerEvent[] {
  const events: DemuxerEvent[] = [];
  demuxer.onEvent((event) => events.push(event));
  return events;
}

// --- Enhanced-RTMP HEVC helpers -------------------------------------------------

/** FourCC 'hvc1' marking an Enhanced-RTMP HEVC video packet. */
export const HEVC_FOURCC = new TextEncoder().encode('hvc1');

// Synthetic HEVC parameter sets (same as the media-utils A0 fixtures):
// profile 1 / tier 0 / level 93, compatibility 0x60000000, constraint ...B0.
export const HEVC_VPS = new Uint8Array([
  0x40, 0x01, // NAL header: VPS (type 32)
  0x00, 0x01, // id=0, max_layers_minus1=0, max_sub_layers_minus1=0, nesting=1
  0xff, 0xff, // vps_reserved_0xffff_16bits
  0x01, // general_profile_space=0, tier=0, profile_idc=1
  0x60, 0x00, 0x00, 0x00, // general_profile_compatibility_flags
  0x00, 0x00, 0x00, 0x00, 0x00, 0xb0, // general_constraint_indicator_flags
  0x5d, // general_level_idc = 93
]);
export const HEVC_SPS = new Uint8Array([
  0x42, 0x01, // NAL header: SPS (type 33)
  0x01, // id=0, max_sub_layers_minus1=0, temporal_id_nesting_flag=1
  0x01, // general_profile_space=0, tier=0, profile_idc=1
  0x60, 0x00, 0x00, 0x00, // general_profile_compatibility_flags
  0x00, 0x00, 0x00, 0x00, 0x00, 0xb0, // general_constraint_indicator_flags
  0x5d, // general_level_idc = 93
  0xa0, 0x88, 0x45, 0x80, // sps_id=0, chroma 4:2:0, 16x16, trailing bits
]);
export const HEVC_PPS = new Uint8Array([0x44, 0x01, 0x00, 0x00, 0x00]);
/** The hvcC record the synthetic parameter sets build to. */
export const HEVC_HVCC = buildHvcC({ vps: HEVC_VPS, sps: HEVC_SPS, pps: HEVC_PPS });

/** Length-prefixed VCL NALU payload (4-byte length + type-19 IDR NAL header). */
export const HEVC_NALUS = concat(new Uint8Array(u32(4)), new Uint8Array([0x27, 0x01, 0x00, 0x01]));

/** Enhanced-RTMP HEVC SequenceStart tag: box-wrapped by default, raw on demand. */
export function hevcSeqTag(record: Uint8Array, timestamp = 0, boxWrapped = true): Uint8Array {
  const box = boxWrapped
    ? concat(new Uint8Array(u32(4 + record.length)), new TextEncoder().encode('hvcc'), record)
    : record;
  const payload = new Uint8Array(6 + box.length);
  payload[0] = 0x10; // frameType=1 key, packetType=0 SequenceStart
  payload[1] = 0x80; // IsExHeader
  payload.set(HEVC_FOURCC, 2);
  payload.set(box, 6);
  return craftTag(9, payload, timestamp);
}

/** Enhanced-RTMP HEVC CodedFrames tag: SI24 CTS (0) + length-prefixed NALUs. */
export function hevcCodedFramesTag(
  naluPayload: Uint8Array,
  frameType = 1,
  timestamp = 0,
  packetType = 1,
): Uint8Array {
  const payload = new Uint8Array(6 + 3 + naluPayload.length);
  payload[0] = ((frameType & 0x0f) << 4) | (packetType & 0x0f);
  payload[1] = 0x80; // IsExHeader
  payload.set(HEVC_FOURCC, 2);
  payload.set(naluPayload, 9);
  return craftTag(9, payload, timestamp);
}

/** Legacy (non-enhanced) codecId 12 video tag: AVC-style header layout. */
export function legacyHevcTag(): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = 0x1c; // frameType=1 key, codecId=12 HEVC
  payload[1] = 0x00; // AVC-style packet type = sequence header
  return craftTag(9, payload);
}

// Test-only helpers for crafting synthetic FLV buffers. Not a test file and
// not exported from the package entry, so it never ships.
import type { Demuxer, DemuxerEvent } from '@vigilkit/plugin-sdk';

export const AVC_CONFIG = new Uint8Array([
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x05, 0x67, 0x42, 0x00, 0x1f, 0x95, 0x01, 0x00,
]);
export const NALU = concat(new Uint8Array([0x00, 0x00, 0x00, 0x03]), new Uint8Array([0x67, 0x42, 0x00]));

export type VideoEvent = Extract<DemuxerEvent, { type: 'video' }>;
export type SeqEvent = Extract<DemuxerEvent, { type: 'sequence-header' }>;
export type MetadataEvent = Extract<DemuxerEvent, { type: 'metadata' }>;
export type AudioEvent = Extract<DemuxerEvent, { type: 'audio' }>;

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

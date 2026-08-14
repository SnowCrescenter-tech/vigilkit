/**
 * Hand-crafted PS packet builders for the PsDemuxer tests. The byte layouts
 * follow ISO/IEC 13818-1: pack headers (MPEG-1/MPEG-2), PES packets with
 * optional PTS/DTS, and Annex-B H.264/HEVC elementary streams.
 */
import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import type { PsDemuxer } from './ps-demuxer.js';

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/**
 * Encodes a 33-bit PTS/DTS value into its 5-byte MPEG representation:
 * `'0010' PTS[32..30] m PTS[29..22] PTS[21..15] m PTS[14..7] PTS[6..0] m`
 * (marker bits set). Inverse of `readPts33`. Note the 33-bit range forces
 * division-based field extraction — JS bitwise ops truncate to 32 bits.
 */
export function encodePts33(ticks: number): number[] {
  return [
    0x21 | ((Math.floor(ticks / 0x40000000) & 0x07) << 1),
    Math.floor(ticks / 0x400000) & 0xff,
    ((Math.floor(ticks / 0x8000) & 0x7f) << 1) | 1,
    Math.floor(ticks / 0x80) & 0xff,
    ((ticks & 0x7f) << 1) | 1,
  ];
}

export interface PackHeaderOptions {
  /** 1 = MPEG-1 (12 bytes), 2 = MPEG-2 (14 bytes + stuffing). Default 2. */
  mpeg?: 1 | 2;
  /** MPEG-2 pack_stuffing_length (0..7). Ignored for MPEG-1. */
  stuffing?: number;
}

/** Builds a pack header (`00 00 01 BA`). */
export function packHeader(opts: PackHeaderOptions = {}): Uint8Array {
  const mpeg = opts.mpeg ?? 2;
  if (mpeg === 1) {
    return new Uint8Array([0x00, 0x00, 0x01, 0xba, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }
  const stuffing = opts.stuffing ?? 0;
  const header = new Uint8Array(14 + stuffing);
  header.set([0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x00, 0x00, 0x3f, 0xe0 | (stuffing & 0x07)]);
  return header;
}

/** Builds a system header (`00 00 01 BB`) with `bodyLength` body bytes. */
export function systemHeader(bodyLength: number): Uint8Array {
  const out = new Uint8Array(6 + bodyLength);
  out[0] = 0x00;
  out[1] = 0x00;
  out[2] = 0x01;
  out[3] = 0xbb;
  out[4] = (bodyLength >> 8) & 0xff;
  out[5] = bodyLength & 0xff;
  return out;
}

/** Builds a program-end code (`00 00 01 B9`). */
export function programEnd(): Uint8Array {
  return new Uint8Array([0x00, 0x00, 0x01, 0xb9]);
}

export interface PesOptions {
  ptsTicks?: number;
  dtsTicks?: number;
  /** Extra PES_header_data bytes (appended after PTS/DTS). */
  headerData?: Uint8Array;
}

/**
 * Builds an MPEG-2 style PES packet: `00 00 01 <stream_id>`, PES_packet_length
 * counting the stream_id byte, flags, header-data length and payload.
 */
export function pesPacket(streamId: number, payload: Uint8Array, opts: PesOptions = {}): Uint8Array {
  const extra: number[] = [];
  let flags = 0x80;
  if (opts.ptsTicks !== undefined && opts.dtsTicks !== undefined) {
    flags |= 0x30;
    extra.push(...encodePts33(opts.ptsTicks), ...encodePts33(opts.dtsTicks));
  } else if (opts.ptsTicks !== undefined) {
    flags |= 0x20;
    extra.push(...encodePts33(opts.ptsTicks));
  }
  if (opts.headerData !== undefined) {
    for (const byte of opts.headerData) extra.push(byte);
  }
  const headerDataLength = extra.length;
  const pesPacketLength = 3 + headerDataLength + payload.length;
  const header = new Uint8Array(9 + headerDataLength);
  header.set([0x00, 0x00, 0x01, streamId, (pesPacketLength >> 8) & 0xff, pesPacketLength & 0xff, flags, 0x00, headerDataLength]);
  header.set(extra, 9);
  return concat(header, payload);
}

/**
 * Builds an MPEG-1 video PES packet: the 2-byte optional header
 * (`'01'` + STD_buffer_scale + STD_buffer_size) then an optional PTS field.
 */
export function pesPacketMpeg1(streamId: number, payload: Uint8Array, opts: PesOptions = {}): Uint8Array {
  const optional = [0x40 | (1 << 5) | 0, 0x00]; // '01' + scale=1 + size=0
  let ptsBytes: number[] = [];
  if (opts.ptsTicks !== undefined) ptsBytes = encodePts33(opts.ptsTicks);
  const pesPacketLength = 2 + ptsBytes.length + payload.length;
  const header = new Uint8Array(6 + optional.length + ptsBytes.length);
  header.set([0x00, 0x00, 0x01, streamId, (pesPacketLength >> 8) & 0xff, pesPacketLength & 0xff]);
  header.set(optional, 6);
  header.set(ptsBytes, 8);
  return concat(header, payload);
}

/** Builds a PES packet with no optional header (payload right after the length). */
export function pesPacketNoOptional(streamId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + payload.length);
  out.set([0x00, 0x00, 0x01, streamId, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  out.set(payload, 6);
  return out;
}

/** Prefixes a NALU with its Annex-B start code. */
export function annexBNalu(nalu: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x00, 0x00, 0x00, 0x01]), nalu);
}

/** H.264 parameter sets / slices (matching the HLS TS fixture bytes). */
export const SPS = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0x95, 0xa8, 0x14, 0x01, 0x6e, 0x90]);
export const PPS = new Uint8Array([0x68, 0xce, 0x06, 0xe2]);
export const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x00]);
const DELTA = new Uint8Array([0x41, 0x9a, 0x22, 0x10]);

/** Annex-B H.264 key access unit: SPS + PPS + AUD + IDR. */
export function idrAccessUnit(): Uint8Array {
  return concat(annexBNalu(SPS), annexBNalu(PPS), annexBNalu(new Uint8Array([0x09, 0xf0])), annexBNalu(IDR));
}

/** Annex-B H.264 delta access unit (a single non-IDR slice). */
export function deltaAccessUnit(): Uint8Array {
  return concat(annexBNalu(DELTA));
}

/** Synthetic HEVC parameter sets (hand-computed, matching the media-utils tests). */
export const HEVC_VPS = new Uint8Array([
  0x40, 0x01, 0x00, 0x01, 0xff, 0xff, 0x01, 0x60, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xb0, 0x5d,
]);
export const HEVC_SPS = new Uint8Array([
  0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xb0, 0x5d, 0xa0, 0x88, 0x45, 0x80,
]);
export const HEVC_PPS = new Uint8Array([0x44, 0x01, 0x00, 0x00, 0x00]);
export const HEVC_IDR = new Uint8Array([0x26, 0x01, 0x88, 0x84, 0x00, 0x00]); // IDR_W_RADL (type 19)
const HEVC_DELTA = new Uint8Array([0x02, 0x01, 0x9a, 0x22, 0x10]); // TRAIL_R (type 1)

/** Annex-B HEVC key access unit: VPS + SPS + PPS + IDR. */
export function hevcAccessUnit(): Uint8Array {
  return concat(annexBNalu(HEVC_VPS), annexBNalu(HEVC_SPS), annexBNalu(HEVC_PPS), annexBNalu(HEVC_IDR));
}

/** Annex-B HEVC delta access unit. */
export function hevcDeltaAccessUnit(): Uint8Array {
  return concat(annexBNalu(HEVC_DELTA));
}

/**
 * Builds a valid 7-byte-header ADTS frame (MPEG-4, AAC LC, 44100 Hz, stereo)
 * around `payload`.
 */
export function adtsFrame(payload: Uint8Array): Uint8Array {
  const frameLength = 7 + payload.length;
  const header = new Uint8Array(7);
  header[0] = 0xff;
  header[1] = 0xf1; // sync + MPEG-4 + no CRC
  header[2] = (2 << 6) | (4 << 2) | 0; // profile=2 (AAC LC), sampleRateIndex=4, chan>>2=0
  header[3] = ((2 & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 0x07) << 5) | 0x1f;
  header[6] = 0xfc;
  return concat(header, payload);
}

/** Collects every event a demuxer emits until `flush()` is called. */
export function collect(demuxer: PsDemuxer): DemuxerEvent[] {
  const events: DemuxerEvent[] = [];
  demuxer.onEvent((event) => events.push(event));
  return events;
}

/** Reads a big-endian u32 (for asserting AVCC framing). */
export function readU32BE(data: Uint8Array): number {
  return ((((data[0] as number) << 24) | ((data[1] as number) << 16) | ((data[2] as number) << 8) | (data[3] as number)) >>> 0);
}

export type MetaEvent = Extract<DemuxerEvent, { type: 'metadata' }>;
export type SeqEvent = Extract<DemuxerEvent, { type: 'sequence-header' }>;
export type AudioConfigEvent = Extract<DemuxerEvent, { type: 'audio-config' }>;
export type VideoEvent = Extract<DemuxerEvent, { type: 'video' }>;
export type AudioEvent = Extract<DemuxerEvent, { type: 'audio' }>;
export type ErrorEvent = Extract<DemuxerEvent, { type: 'error' }>;

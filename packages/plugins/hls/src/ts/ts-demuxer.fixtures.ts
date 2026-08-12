import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import { TsDemuxer } from './ts-demuxer.js';

/**
 * Synthetic MPEG-TS builders used by the TsDemuxer unit tests: TS packets,
 * PSI sections, PES headers and test access units.
 */

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

export function tsPacket(pid: number, payload: Uint8Array, pusi = false): Uint8Array {
  const out = new Uint8Array(188);
  out[0] = 0x47;
  out[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  out[2] = pid & 0xff;
  out[3] = 0x10; // payload only, continuity counter 0
  out.set(payload, 4);
  return out;
}

/**
 * Builds a TS packet whose payload field carries exactly `payload` bytes,
 * padding the rest of the 188-byte packet with an adaptation field — the
 * pattern a real muxer uses when a PES ends mid-packet (the padding must not
 * leak into the demuxed ES).
 */
export function tsPacketPadded(pid: number, payload: Uint8Array, pusi = false): Uint8Array {
  if (payload.length === 184) return tsPacket(pid, payload, pusi);
  const out = new Uint8Array(188);
  out[0] = 0x47;
  out[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  out[2] = pid & 0xff;
  out[3] = 0x30; // adaptation_field_control 0b11, continuity counter 0
  out[4] = 184 - payload.length - 1; // stuffing length
  out.set(payload, 5 + out[4]);
  return out;
}

export function psiSection(tableId: number, body: number[]): Uint8Array {
  const sectionLength = body.length + 4;
  const out = new Uint8Array(3 + body.length + 4);
  out[0] = tableId;
  out[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
  out[2] = sectionLength & 0xff;
  out.set(body, 3);
  return out;
}

export function patSection(pmtPid: number): Uint8Array {
  return psiSection(0x00, [
    0x00, 0x01,
    0xc1, 0x00, 0x00,
    0x00, 0x01,
    (0xe000 | pmtPid) >> 8, (0xe000 | pmtPid) & 0xff,
  ]);
}

export function pmtSection(videoPid: number, audioPid: number): Uint8Array {
  return psiSection(0x02, [
    0x00, 0x01,
    0xc1, 0x00, 0x00,
    0xe0, 0x00,
    0xf0, 0x00,
    0x1b, (0xe000 | videoPid) >> 8, (0xe000 | videoPid) & 0xff, 0xf0, 0x00,
    0x0f, (0xe000 | audioPid) >> 8, (0xe000 | audioPid) & 0xff, 0xf0, 0x00,
  ]);
}

/** A PMT whose only streams are AC-3 (0x81) and MPEG-1 video (0x01). */
export function unrecognizedPmtSection(): Uint8Array {
  return psiSection(0x02, [
    0x00, 0x01,
    0xc1, 0x00, 0x00,
    0xe0, 0x00,
    0xf0, 0x00,
    0x81, (0xe000 | 0x110) >> 8, (0xe000 | 0x110) & 0xff, 0xf0, 0x00,
    0x01, (0xe000 | 0x120) >> 8, (0xe000 | 0x120) & 0xff, 0xf0, 0x00,
  ]);
}

export function psiPackets(section: Uint8Array, pid: number): Uint8Array {
  return tsPacket(pid, concat(new Uint8Array([0x00]), section), true);
}

function tsBytes(value: number, marker: number): number[] {
  return [
    0x01 | (marker << 4) | ((Math.floor(value / 0x40000000) & 7) << 1),
    Math.floor(value / 0x400000) & 0xff,
    0x01 | ((Math.floor(value / 0x8000) & 0x7f) << 1),
    Math.floor(value / 0x80) & 0xff,
    0x01 | ((value & 0x7f) << 1),
  ];
}

export function pesHeader(streamId: number, pts?: number, dts?: number): Uint8Array {
  const hasPts = pts !== undefined;
  const hasDts = dts !== undefined;
  const ptsDtsFlags = hasPts ? (hasDts ? 0x30 : 0x20) : 0;
  const optional: number[] = [];
  if (hasPts) optional.push(...tsBytes(pts as number, 2));
  if (hasDts) optional.push(...tsBytes(dts as number, 1));
  const out = new Uint8Array(9 + optional.length);
  out[0] = 0;
  out[1] = 0;
  out[2] = 1;
  out[3] = streamId;
  out[4] = 0;
  out[5] = 0;
  out[6] = 0x80 | ptsDtsFlags;
  out[7] = 0;
  out[8] = optional.length;
  out.set(optional, 9);
  return out;
}

export function pesPacket(pid: number, streamId: number, esData: Uint8Array, pts?: number, dts?: number): Uint8Array {
  return tsPacket(pid, concat(pesHeader(streamId, pts, dts), esData), true);
}

export function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

export const SPS = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0x95, 0xa8, 0x14, 0x01, 0x6e, 0x90]);
export const PPS = new Uint8Array([0x68, 0xce, 0x06, 0xe2]);
export const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x00]);
const DELTA = new Uint8Array([0x41, 0x9a, 0x22, 0x10]);

export function annexBNalu(nalu: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x00, 0x00, 0x00, 0x01]), nalu);
}

export function idrAccessUnit(): Uint8Array {
  return concat(annexBNalu(SPS), annexBNalu(PPS), annexBNalu(new Uint8Array([0x09, 0xf0])), annexBNalu(IDR));
}

export function deltaAccessUnit(): Uint8Array {
  return concat(annexBNalu(DELTA));
}

export function adtsFrame(frameLength = 17): Uint8Array {
  const out = new Uint8Array(frameLength);
  out[0] = 0xff;
  out[1] = 0xf1;
  out[2] = (1 << 6) | (4 << 2);
  out[3] = (2 << 6) | ((frameLength >> 11) & 0x03);
  out[4] = (frameLength >> 3) & 0xff;
  out[5] = ((frameLength & 0x07) << 5) | 0x1f;
  out[6] = 0xfc;
  return out;
}

export const VIDEO_PID = 0x101;
export const AUDIO_PID = 0x102;
export const PMT_PID = 0x100;

export function buildSegment(opts: { videoPts?: number; videoPts2?: number; audioPts?: number } = {}): Uint8Array {
  const first = pesPacket(VIDEO_PID, 0xe0, idrAccessUnit(), opts.videoPts ?? 90000);
  const second = pesPacket(VIDEO_PID, 0xe0, deltaAccessUnit(), opts.videoPts2 ?? 180000);
  const audio = pesPacket(AUDIO_PID, 0xc0, adtsFrame(), opts.audioPts ?? 90000);
  return concat(
    psiPackets(patSection(PMT_PID), 0),
    psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID),
    first,
    second,
    audio,
  );
}

export function collect(demuxer: TsDemuxer): DemuxerEvent[] {
  const events: DemuxerEvent[] = [];
  demuxer.onEvent((event) => events.push(event));
  return events;
}

export type VideoEvent = Extract<DemuxerEvent, { type: 'video' }>;
export type SeqEvent = Extract<DemuxerEvent, { type: 'sequence-header' }>;
export type AudioEvent = Extract<DemuxerEvent, { type: 'audio' }>;
export type MetaEvent = Extract<DemuxerEvent, { type: 'metadata' }>;

export function readU32BE(data: Uint8Array): number {
  return (
    (((data[0] as number) << 24) |
      ((data[1] as number) << 16) |
      ((data[2] as number) << 8) |
      (data[3] as number)) >>>
      0
  );
}

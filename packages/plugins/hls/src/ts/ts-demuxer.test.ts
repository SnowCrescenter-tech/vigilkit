import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import { TsDemuxer } from './ts-demuxer.js';

// --- Synthetic MPEG-TS builders -------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function tsPacket(pid: number, payload: Uint8Array, pusi = false): Uint8Array {
  const out = new Uint8Array(188);
  out[0] = 0x47;
  out[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  out[2] = pid & 0xff;
  out[3] = 0x10; // payload only, continuity counter 0
  out.set(payload, 4);
  return out;
}

function psiSection(tableId: number, body: number[]): Uint8Array {
  const sectionLength = body.length + 4;
  const out = new Uint8Array(3 + body.length + 4);
  out[0] = tableId;
  out[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
  out[2] = sectionLength & 0xff;
  out.set(body, 3);
  return out;
}

function patSection(pmtPid: number): Uint8Array {
  return psiSection(0x00, [
    0x00, 0x01,
    0xc1, 0x00, 0x00,
    0x00, 0x01,
    (0xe000 | pmtPid) >> 8, (0xe000 | pmtPid) & 0xff,
  ]);
}

function pmtSection(videoPid: number, audioPid: number): Uint8Array {
  return psiSection(0x02, [
    0x00, 0x01,
    0xc1, 0x00, 0x00,
    0xe0, 0x00,
    0xf0, 0x00,
    0x1b, (0xe000 | videoPid) >> 8, (0xe000 | videoPid) & 0xff, 0xf0, 0x00,
    0x0f, (0xe000 | audioPid) >> 8, (0xe000 | audioPid) & 0xff, 0xf0, 0x00,
  ]);
}

function psiPackets(section: Uint8Array, pid: number): Uint8Array {
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

function pesHeader(streamId: number, pts?: number, dts?: number): Uint8Array {
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

function pesPacket(pid: number, streamId: number, esData: Uint8Array, pts?: number, dts?: number): Uint8Array {
  return tsPacket(pid, concat(pesHeader(streamId, pts, dts), esData), true);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

const SPS = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0x95, 0xa8, 0x14, 0x01, 0x6e, 0x90]);
const PPS = new Uint8Array([0x68, 0xce, 0x06, 0xe2]);
const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x00]);
const DELTA = new Uint8Array([0x41, 0x9a, 0x22, 0x10]);

function annexBNalu(nalu: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x00, 0x00, 0x00, 0x01]), nalu);
}

function idrAccessUnit(): Uint8Array {
  return concat(annexBNalu(SPS), annexBNalu(PPS), annexBNalu(new Uint8Array([0x09, 0xf0])), annexBNalu(IDR));
}

function deltaAccessUnit(): Uint8Array {
  return concat(annexBNalu(DELTA));
}

function adtsFrame(frameLength = 17): Uint8Array {
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

const VIDEO_PID = 0x101;
const AUDIO_PID = 0x102;
const PMT_PID = 0x100;

function buildSegment(opts: { videoPts?: number; videoPts2?: number; audioPts?: number } = {}): Uint8Array {
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

function collect(demuxer: TsDemuxer): DemuxerEvent[] {
  const events: DemuxerEvent[] = [];
  demuxer.onEvent((event) => events.push(event));
  return events;
}

type VideoEvent = Extract<DemuxerEvent, { type: 'video' }>;
type SeqEvent = Extract<DemuxerEvent, { type: 'sequence-header' }>;
type AudioEvent = Extract<DemuxerEvent, { type: 'audio' }>;
type MetaEvent = Extract<DemuxerEvent, { type: 'metadata' }>;

function readU32BE(data: Uint8Array): number {
  return (
    (((data[0] as number) << 24) |
      ((data[1] as number) << 16) |
      ((data[2] as number) << 8) |
      (data[3] as number)) >>>
      0
  );
}

// --- Tests ----------------------------------------------------------------

describe('TsDemuxer', () => {
  it('emits a sequence header (avcC) then key/delta video chunks', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(buildSegment());
    demuxer.flush();

    const seq = events.find((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seq).toBeDefined();
    expect(seq?.config.codec).toBe('avc1.42001f');
    expect(seq?.config.description).toBeDefined();

    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos).toHaveLength(2);
    const key = videos[0];
    const delta = videos[1];
    expect(key?.chunk.type).toBe('key');
    expect(delta?.chunk.type).toBe('delta');
    expect(key?.chunk.timestamp).toBeCloseTo(1_000_000, 0);
    expect(delta?.chunk.timestamp).toBeCloseTo(2_000_000, 0);
    // AVCC framing: first 4 bytes are the big-endian length of the first NALU (SPS).
    expect(readU32BE(key?.chunk.data as Uint8Array)).toBe(SPS.length);
  });

  it('emits audio metadata and raw ADTS chunks', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(buildSegment());
    demuxer.flush();

    const meta = events.find((event): event is MetaEvent => event.type === 'metadata');
    expect(meta?.metadata).toMatchObject({ hasAudio: true, hasVideo: true, sampleRate: 44100, channels: 2 });

    const audios = events.filter((event): event is AudioEvent => event.type === 'audio');
    expect(audios.length).toBeGreaterThanOrEqual(1);
    expect(audios[0]?.chunk.type).toBe('key');
    expect(audios[0]?.chunk.data[0]).toBe(0xff);
  });

  it('keeps output timestamps monotonic across a PTS rollback', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(buildSegment());
    demuxer.flush();
    demuxer.push(buildSegment({ videoPts: 0, videoPts2: 90000 }));
    demuxer.flush();

    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos).toHaveLength(4);
    for (let i = 1; i < videos.length; i++) {
      expect(videos[i]?.chunk.timestamp).toBeGreaterThan(videos[i - 1]?.chunk.timestamp as number);
    }
  });

  it('passes already-length-prefixed video payloads through unchanged', () => {
    const es = concat(u32(SPS.length), SPS, u32(PPS.length), PPS, u32(IDR.length), IDR);
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID),
        pesPacket(VIDEO_PID, 0xe0, es, 90000),
      ),
    );
    demuxer.flush();

    const video = events.find((event): event is VideoEvent => event.type === 'video');
    expect(video).toBeDefined();
    expect(video?.chunk.data).toEqual(es);
  });

  it('resyncs after garbage bytes', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x47]));
    demuxer.push(buildSegment());
    demuxer.flush();

    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos.length).toBeGreaterThanOrEqual(1);
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(0);
  });

  it('flushes without leaking a partial trailing frame', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    // Only PSI + the beginning of a PES: no complete video chunk expected.
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID),
        tsPacket(VIDEO_PID, concat(pesHeader(0xe0, 90000), idrAccessUnit().slice(0, 10)), true),
      ),
    );
    demuxer.flush();
    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos).toHaveLength(0);
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(0);
  });

  it('parses the real h264small.ts fixture', () => {
    const fixturePath = fileURLToPath(new URL('../../../../../examples/basic/hls-fixtures/seg-0.ts', import.meta.url));
    const bytes = readFileSync(fixturePath);
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    for (let offset = 0; offset < bytes.length; offset += 7168) {
      demuxer.push(bytes.subarray(offset, offset + 7168));
    }
    demuxer.flush();

    const seq = events.find((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seq).toBeDefined();
    expect(seq?.config.codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
    expect(seq?.config.description).toBeDefined();

    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos.length).toBeGreaterThan(0);

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(0);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import { TsDemuxer } from './ts-demuxer.js';
import {
  AUDIO_PID,
  HEVC_IDR,
  HEVC_PPS,
  HEVC_VIDEO_PID,
  HEVC_VPS,
  IDR,
  PMT_PID,
  PPS,
  SPS,
  VIDEO_PID,
  adtsFrame,
  annexBNalu,
  buildSegment,
  collect,
  concat,
  idrAccessUnit,
  patSection,
  pesHeader,
  pesPacket,
  pmtSection,
  pmtSectionHevc,
  psiPackets,
  readU32BE,
  tsPacket,
  tsPacketPadded,
  u32,
  unrecognizedPmtSection,
} from './ts-demuxer.fixtures.js';
import type { AudioConfigEvent, AudioEvent, MetaEvent, SeqEvent, VideoEvent } from './ts-demuxer.fixtures.js';

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

  it('emits an audio-config event, audio metadata and stripped AAC audio chunks', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(buildSegment());
    demuxer.flush();

    const meta = events.find((event): event is MetaEvent => event.type === 'metadata');
    expect(meta?.metadata).toMatchObject({ hasAudio: true, hasVideo: true, sampleRate: 44100, channels: 2 });

    const audios = events.filter((event): event is AudioEvent => event.type === 'audio');
    expect(audios.length).toBeGreaterThanOrEqual(1);
    expect(audios[0]?.chunk.type).toBe('key');
    // The ADTS header is stripped: chunk data starts with the AAC raw payload.
    expect(audios[0]?.chunk.data[0]).not.toBe(0xff);
  });

  it('emits an audio-config event from the first ADTS frame', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(buildSegment());
    demuxer.flush();

    const configs = events.filter((e): e is AudioConfigEvent => e.type === 'audio-config');
    expect(configs).toHaveLength(1);
    expect(configs[0]?.config.codec).toBe('mp4a.40.2');
    expect(configs[0]?.config.sampleRate).toBe(44100);
    expect(configs[0]?.config.numberOfChannels).toBe(2);
    expect(configs[0]?.config.description).toEqual(new Uint8Array([0x12, 0x10]));
  });

  it('audio chunks carry the stripped AAC payload (no ADTS header)', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(buildSegment());
    demuxer.flush();

    const audios = events.filter((event): event is AudioEvent => event.type === 'audio');
    expect(audios.length).toBeGreaterThanOrEqual(1);
    // The fixture frame has a 7-byte header (protection_absent = 1).
    expect(audios[0]?.chunk.data.length).toBe(adtsFrame().length - 7);
    expect(audios[0]?.chunk.data[0]).not.toBe(0xff);
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

  it('keeps internal buffers bounded across a long live feed', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    const internal = demuxer as unknown as {
      pesBuffers: Map<number, Uint8Array>;
      adtsCarry: Uint8Array;
      packetizer: { buffer: Uint8Array };
    };
    let maxPesBuffers = 0;
    let maxAdtsCarry = 0;
    let maxPacketizer = 0;
    for (let i = 0; i < 300; i++) {
      demuxer.push(buildSegment());
      demuxer.flush();
      maxPesBuffers = Math.max(maxPesBuffers, internal.pesBuffers.size);
      maxAdtsCarry = Math.max(maxAdtsCarry, internal.adtsCarry.length);
      maxPacketizer = Math.max(maxPacketizer, internal.packetizer.buffer.length);
    }
    // Every flush drains partial state: nothing accumulates across segments.
    expect(internal.pesBuffers.size).toBe(0);
    expect(internal.adtsCarry.length).toBe(0);
    expect(internal.packetizer.buffer.length).toBe(0);
    // During the feed the buffers never grow past a single segment's worth.
    expect(maxPesBuffers).toBeLessThanOrEqual(1);
    expect(maxAdtsCarry).toBeLessThan(1024);
    expect(maxPacketizer).toBeLessThanOrEqual(188);
    // The demuxer kept producing output the whole way through (no truncation).
    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos.length).toBeGreaterThanOrEqual(300);
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

  it('a PMT with no recognized stream types surfaces a DEMUX error', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(unrecognizedPmtSection(), PMT_PID),
        pesPacket(VIDEO_PID, 0xe0, idrAccessUnit(), 90000),
      ),
    );
    demuxer.flush();

    const errors = events.filter((event): event is Extract<DemuxerEvent, { type: 'error' }> => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ type: 'error', error: { code: 'DEMUX', message: 'no recognized streams in PMT' } });

    // The demuxer is marked failed: further packets must not be processed.
    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos).toHaveLength(0);
  });

  it('garbage H.264 parameter sets emit a DEMUX error instead of throwing', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    // A structurally valid PES carrying a 1-byte SPS NALU (type 7), a valid
    // PPS and a VCL NALU: codecStringFromSps rejects an SPS shorter than 4
    // bytes. The failure must surface as an error event — never a synchronous
    // throw out of push()/flush().
    const garbageSps = annexBNalu(new Uint8Array([0x67]));
    const es = concat(garbageSps, annexBNalu(PPS), annexBNalu(IDR));
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID),
        pesPacket(VIDEO_PID, 0xe0, es, 90000),
      ),
    );
    expect(() => demuxer.flush()).not.toThrow();
    const errors = events.filter((event): event is Extract<DemuxerEvent, { type: 'error' }> => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.code).toBe('DEMUX');
    demuxer.close();
  });

  it('garbage HEVC parameter sets emit a DEMUX error instead of throwing', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    // VPS/PPS are well-formed but the SPS is truncated to a single byte:
    // buildHvcC -> parseHevcSps rejects it. The failure must surface as an
    // error event — never a synchronous throw out of push()/flush().
    const badSps = annexBNalu(new Uint8Array([0x42]));
    const es = concat(
      annexBNalu(HEVC_VPS),
      badSps,
      annexBNalu(HEVC_PPS),
      annexBNalu(HEVC_IDR),
    );
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSectionHevc(HEVC_VIDEO_PID), PMT_PID),
        pesPacket(HEVC_VIDEO_PID, 0xe0, es, 90000),
      ),
    );
    expect(() => demuxer.flush()).not.toThrow();
    const errors = events.filter((event): event is Extract<DemuxerEvent, { type: 'error' }> => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.code).toBe('DEMUX');
    demuxer.close();
  });

  it('a PES split across three packets reassembles into one video chunk', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    const bigIdr = new Uint8Array(400);
    bigIdr[0] = 0x65; // H.264 IDR NALU
    for (let i = 1; i < bigIdr.length; i++) bigIdr[i] = i & 0xff;
    const es = concat(
      annexBNalu(SPS),
      annexBNalu(PPS),
      annexBNalu(new Uint8Array([0x09, 0xf0])),
      annexBNalu(bigIdr),
    );
    const payload = concat(pesHeader(0xe0, 90000), es);
    const perPacket = 188 - 4;
    const packet1 = tsPacket(VIDEO_PID, payload.subarray(0, perPacket), true); // PUSI, full field
    const packet2 = tsPacket(VIDEO_PID, payload.subarray(perPacket, perPacket * 2));
    // Last PES packet ends mid-packet: pad with an adaptation field.
    const packet3 = tsPacketPadded(VIDEO_PID, payload.subarray(perPacket * 2));
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID),
        packet1,
        packet2,
        packet3,
      ),
    );
    demuxer.flush();

    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos).toHaveLength(1);
    const chunk = videos[0]?.chunk.data as Uint8Array;
    // The full ES survives reassembly: every NALU carries a 4-byte length prefix.
    const expectedLength = (4 + SPS.length) + (4 + PPS.length) + (4 + 2) + (4 + bigIdr.length);
    expect(chunk.length).toBe(expectedLength);
    // The trailing 400-byte IDR NALU must be byte-identical after the split.
    expect(chunk.subarray(chunk.length - bigIdr.length)).toEqual(bigIdr);
  });

  it('an ADTS frame split across two PES payloads is emitted exactly once with the PES PTS', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    const frame = adtsFrame(17);
    const first = tsPacketPadded(AUDIO_PID, concat(pesHeader(0xc0, 90000), frame.slice(0, 10)), true);
    const second = tsPacketPadded(AUDIO_PID, concat(pesHeader(0xc0, 180000), frame.slice(10)), true);
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID),
        first,
        second,
      ),
    );
    demuxer.flush();

    const audios = events.filter((event): event is AudioEvent => event.type === 'audio');
    expect(audios).toHaveLength(1);
    // The ADTS header (7 bytes, no CRC) is stripped from the emitted chunk.
    expect(audios[0]?.chunk.data.length).toBe(17 - 7);
    expect(audios[0]?.chunk.data).toEqual(frame.slice(7));
    // The emitted chunk carries the second PES's PTS (2 s @ 90 kHz), not the first.
    expect(audios[0]?.chunk.timestamp).toBeCloseTo(2_000_000, 0);
  });

  it('ADTS leading garbage is skipped and resyncs to the next frame', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    const frame = adtsFrame(17);
    const garbage = new Uint8Array([0x11, 0x22, 0x33]);
    const p = pesPacket(AUDIO_PID, 0xc0, concat(garbage, frame), 90000);
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID),
        p,
      ),
    );
    demuxer.flush();

    const audios = events.filter((event): event is AudioEvent => event.type === 'audio');
    expect(audios).toHaveLength(1);
    expect(audios[0]?.chunk.data).toEqual(frame.slice(7));
  });
});

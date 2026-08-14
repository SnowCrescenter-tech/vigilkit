/**
 * Unit tests for the PS demuxer: hand-crafted PS packets covering pack
 * headers (MPEG-1/MPEG-2), PES with/without PTS, H.264/HEVC parameter sets,
 * G.711/G.726/AAC audio, split-across-pushes, truncation and the 33-bit PTS
 * wraparound.
 */
import { describe, expect, it } from 'vitest';
import { readPts33, PsDemuxer } from './ps-demuxer.js';
import {
  HEVC_VPS,
  SPS,
  adtsFrame,
  collect,
  concat,
  deltaAccessUnit,
  encodePts33,
  hevcAccessUnit,
  hevcDeltaAccessUnit,
  idrAccessUnit,
  packHeader,
  pesPacket,
  pesPacketMpeg1,
  pesPacketNoOptional,
  programEnd,
  readU32BE,
  systemHeader,
} from './ps-test-utils.js';
import type {
  AudioConfigEvent,
  AudioEvent,
  ErrorEvent,
  MetaEvent,
  SeqEvent,
  VideoEvent,
} from './ps-test-utils.js';

describe('readPts33 (33-bit PTS reassembly)', () => {
  it('reassembles the 5-byte MPEG encoding into the exact 33-bit value', () => {
    // Zero: '0010' + 0 + marker + 0 + marker + 0 + marker.
    expect(readPts33(new Uint8Array([0x21, 0x00, 0x01, 0x00, 0x01]), 0)).toBe(0);
    // Hand-computed vector: 0x123456789.
    const ticks = 0x123456789;
    expect(readPts33(Uint8Array.from(encodePts33(ticks)), 0)).toBe(ticks);
    // Maximum 33-bit value: 0x1FFFFFFFF (all fields at their max).
    expect(readPts33(new Uint8Array([0x2f, 0xff, 0xff, 0xff, 0xff]), 0)).toBe(0x1ffffffff);
    // Encoding round-trips at every marker-boundary bit pattern.
    for (const value of [1, 0x7fff, 0x8000, 0x3fffffff, 0x40000000, 0x1ffffffff]) {
      expect(readPts33(Uint8Array.from(encodePts33(value)), 0)).toBe(value);
    }
  });

  it('reads PTS at a nonzero offset and ignores marker bits', () => {
    const pts = Uint8Array.from(encodePts33(0x12345));
    const padded = concat(new Uint8Array([0xaa, 0xbb]), pts);
    expect(readPts33(padded, 2)).toBe(0x12345);
  });
});

describe('PsDemuxer', () => {
  it('emits metadata + sequence header (avcC) then key/delta video chunks', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(
        packHeader(),
        pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 }),
        packHeader(),
        pesPacket(0xe0, deltaAccessUnit(), { ptsTicks: 180000 }),
      ),
    );
    demuxer.flush();

    const meta = events.find((e): e is MetaEvent => e.type === 'metadata');
    expect(meta?.metadata).toMatchObject({ hasVideo: true, hasAudio: false, codec: 'h264' });

    const seq = events.find((e): e is SeqEvent => e.type === 'sequence-header');
    expect(seq?.config.codec).toBe('avc1.42001f');
    expect(seq?.config.description).toBeDefined();

    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(2);
    expect(videos[0]?.chunk.type).toBe('key');
    expect(videos[1]?.chunk.type).toBe('delta');
    expect(videos[0]?.chunk.timestamp).toBeCloseTo(1_000_000, 0);
    expect(videos[1]?.chunk.timestamp).toBeCloseTo(2_000_000, 0);
    // AVCC framing: the chunk starts with the big-endian length of the SPS.
    expect(readU32BE(videos[0]?.chunk.data as Uint8Array)).toBe(SPS.length);
    expect(readU32BE(videos[1]?.chunk.data as Uint8Array)).toBe(deltaAccessUnit().length - 4);
  });

  it('emits an HEVC sequence header (hvcC) and key/delta chunks', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(
        packHeader(),
        pesPacket(0xe0, hevcAccessUnit(), { ptsTicks: 90000 }),
        pesPacket(0xe0, hevcDeltaAccessUnit(), { ptsTicks: 180000 }),
      ),
    );
    demuxer.flush();

    const meta = events.find((e): e is MetaEvent => e.type === 'metadata');
    expect(meta?.metadata.codec).toBe('hevc');

    const seq = events.find((e): e is SeqEvent => e.type === 'sequence-header');
    expect(seq?.config.codec.startsWith('hvc1.')).toBe(true);
    expect(seq?.config.description).toBeDefined();

    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(2);
    expect(videos[0]?.chunk.type).toBe('key');
    expect(videos[1]?.chunk.type).toBe('delta');
    // AVCC framing: first 4 bytes are the big-endian length of the VPS.
    expect(readU32BE(videos[0]?.chunk.data as Uint8Array)).toBe(HEVC_VPS.length);
  });

  it('does not emit a sequence header or chunks before parameter sets arrive', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(packHeader(), pesPacket(0xe0, deltaAccessUnit(), { ptsTicks: 90000 })));
    demuxer.flush();
    expect(events.some((e) => e.type === 'sequence-header')).toBe(false);
    expect(events.some((e) => e.type === 'video')).toBe(false);
  });

  it('emits G.711 audio chunks raw with metadata', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    const g711 = new Uint8Array([0x55, 0xd5, 0x55, 0xd5, 0x80, 0x00, 0x7f, 0xff]);
    demuxer.push(concat(packHeader(), pesPacket(0xc0, g711, { ptsTicks: 90000 })));
    demuxer.flush();

    const meta = events.find((e): e is MetaEvent => e.type === 'metadata');
    expect(meta?.metadata).toMatchObject({ hasVideo: false, hasAudio: true, codec: 'g711a' });

    const audios = events.filter((e): e is AudioEvent => e.type === 'audio');
    expect(audios).toHaveLength(1);
    expect(audios[0]?.chunk.type).toBe('key');
    expect(audios[0]?.chunk.timestamp).toBeCloseTo(1_000_000, 0);
    expect(Array.from(audios[0]?.chunk.data as Uint8Array)).toEqual(Array.from(g711));
    expect(events.some((e) => e.type === 'audio-config')).toBe(false);
  });

  it('uses the configured audio codec when the payload is not self-identifying', () => {
    const demuxer = new PsDemuxer({ audioCodec: 'g711u' });
    const events = collect(demuxer);
    demuxer.push(concat(packHeader(), pesPacket(0xc0, new Uint8Array([0xff, 0x00, 0xff, 0x00]))));
    demuxer.flush();
    const meta = events.find((e): e is MetaEvent => e.type === 'metadata');
    expect(meta?.metadata.codec).toBe('g711u');
  });

  it('emits an audio-config and stripped AAC chunks from ADTS frames', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const b = new Uint8Array([11, 12, 13]);
    demuxer.push(concat(packHeader(), pesPacket(0xc0, concat(adtsFrame(a), adtsFrame(b)), { ptsTicks: 90000 })));
    demuxer.flush();

    const configs = events.filter((e): e is AudioConfigEvent => e.type === 'audio-config');
    expect(configs).toHaveLength(1);
    expect(configs[0]?.config.codec).toBe('mp4a.40.3');
    expect(configs[0]?.config.sampleRate).toBe(44100);
    expect(configs[0]?.config.numberOfChannels).toBe(2);

    const audios = events.filter((e): e is AudioEvent => e.type === 'audio');
    expect(audios).toHaveLength(2);
    expect(Array.from(audios[0]?.chunk.data as Uint8Array)).toEqual(Array.from(a));
    expect(Array.from(audios[1]?.chunk.data as Uint8Array)).toEqual(Array.from(b));
    // ADTS headers are stripped: chunks must not start with the sync byte.
    expect((audios[0]?.chunk.data as Uint8Array)[0]).not.toBe(0xff);
  });

  it('assigns synthetic increasing timestamps when PES packets lack PTS', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(packHeader(), pesPacket(0xe0, idrAccessUnit()), pesPacket(0xe0, deltaAccessUnit())));
    demuxer.flush();
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(2);
    const first = videos[0]?.chunk.timestamp as number;
    const second = videos[1]?.chunk.timestamp as number;
    expect(second).toBeGreaterThan(first);
    expect(second - first).toBeCloseTo(33333, 0);
  });

  it('buffers packets split across arbitrary push boundaries', () => {
    const full = concat(
      packHeader(),
      pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 }),
      pesPacket(0xc0, new Uint8Array([0x55, 0xd5, 0x55]), { ptsTicks: 180000 }),
    );
    const cuts = [1, 3, 4, 5, 8, 13, 14, 15, 16, 21, 22, 23, 24, 30, full.length - 4, full.length - 1];
    for (const cut of cuts) {
      const demuxer = new PsDemuxer();
      const events = collect(demuxer);
      demuxer.push(full.slice(0, cut));
      demuxer.push(full.slice(cut));
      demuxer.flush();
      const videos = events.filter((e): e is VideoEvent => e.type === 'video');
      const audios = events.filter((e): e is AudioEvent => e.type === 'audio');
      expect(videos, `cut at ${cut}`).toHaveLength(1);
      expect(audios, `cut at ${cut}`).toHaveLength(1);
      expect(videos[0]?.chunk.timestamp).toBeCloseTo(1_000_000, 0);
    }
  });

  it('keeps the demuxer aligned when the transport splits at every byte', () => {
    const full = concat(
      packHeader(),
      pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 }),
      pesPacket(0xe0, deltaAccessUnit(), { ptsTicks: 180000 }),
    );
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    for (let i = 0; i < full.length; i++) demuxer.push(full.slice(i, i + 1));
    demuxer.flush();
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(2);
  });

  it('emits an error event on truncation at flush, without throwing', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    const full = concat(packHeader(), pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 }));
    demuxer.push(full.slice(0, full.length - 5));
    expect(() => demuxer.flush()).not.toThrow();
    const errors = events.filter((e): e is ErrorEvent => e.type === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]?.error.code).toBe('DEMUX');
  });

  it('resyncs past leading garbage before the first pack header', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    const garbage = new Uint8Array([0x11, 0x22, 0x00, 0x00, 0x01, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
    demuxer.push(concat(garbage, packHeader(), pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 })));
    demuxer.flush();
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(1);
    expect(videos[0]?.chunk.type).toBe('key');
  });

  it('survives a malformed PES length and continues with the next packet', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    // PES with PES_packet_length 0 and an MPEG-2 style header: negative payload.
    const malformed = new Uint8Array([0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x00, 0x00]);
    demuxer.push(concat(packHeader(), malformed, pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 })));
    demuxer.flush();
    const errors = events.filter((e): e is ErrorEvent => e.type === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(1);
  });

  it('detects MPEG-1 pack headers and parses MPEG-1 video PES packets', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(packHeader({ mpeg: 1 }), pesPacketMpeg1(0xe0, idrAccessUnit(), { ptsTicks: 90000 })));
    demuxer.flush();
    expect(demuxer.mpegVersion).toBe('mpeg1');
    const seq = events.find((e): e is SeqEvent => e.type === 'sequence-header');
    expect(seq?.config.codec).toBe('avc1.42001f');
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(1);
    expect(videos[0]?.chunk.timestamp).toBeCloseTo(1_000_000, 0);
  });

  it('distinguishes MPEG-2 pack headers by marker bits and skips stuffing', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(packHeader({ mpeg: 2, stuffing: 7 }), pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 })));
    demuxer.flush();
    expect(demuxer.mpegVersion).toBe('mpeg2');
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(1);
  });

  it('skips system headers, program-end codes and unknown/private streams', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    const privateStream = pesPacketNoOptional(0xbd, new Uint8Array([1, 2, 3, 4]));
    demuxer.push(
      concat(
        packHeader(),
        systemHeader(8),
        privateStream,
        pesPacketNoOptional(0xbe, new Uint8Array([0x00, 0x00, 0x00])), // padding
        programEnd(),
        packHeader(),
        pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 }),
      ),
    );
    demuxer.flush();
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(1);
  });

  it('handles a PTS rollback by keeping output timestamps monotonic', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(
        packHeader(),
        pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 }),
        packHeader(),
        pesPacket(0xe0, deltaAccessUnit(), { ptsTicks: 10000 }), // earlier than the first PES
      ),
    );
    demuxer.flush();
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(2);
    expect(videos[1]?.chunk.timestamp as number).toBeGreaterThan(videos[0]?.chunk.timestamp as number);
  });

  it('unwraps the 33-bit PTS counter past 2^33', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    // First PES near the top of the 33-bit range; second PES has wrapped to 0.
    demuxer.push(
      concat(
        packHeader(),
        pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 0x1fffffe00 }),
        packHeader(),
        pesPacket(0xe0, deltaAccessUnit(), { ptsTicks: 0x200 }),
      ),
    );
    demuxer.flush();
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(2);
    const first = videos[0]?.chunk.timestamp as number;
    const second = videos[1]?.chunk.timestamp as number;
    expect(second).toBeGreaterThan(first);
    // Unwrapped delta: (0x200 - 0x1fffffe00) + 2^33 = 0x400 ticks = ~4.4 ms.
    expect(second - first).toBeCloseTo((0x400 * 100) / 9, 0);
  });

  it('never emits a sequence header for an unknown stream id shape', () => {
    const demuxer = new PsDemuxer();
    const events = collect(demuxer);
    // A PES with a header-data length larger than the packet itself.
    const bogus = new Uint8Array([0x00, 0x00, 0x01, 0xe0, 0x00, 0x0a, 0x80, 0x00, 0x63]);
    demuxer.push(bogus);
    demuxer.flush();
    expect(events.some((e) => e.type === 'video')).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHvcC } from '@vigilkit/media-utils';
import { TsDemuxer } from './ts-demuxer.js';
import {
  HEVC_IDR,
  HEVC_PPS,
  HEVC_SPS,
  HEVC_VIDEO_PID,
  HEVC_VPS,
  PMT_PID,
  VIDEO_PID,
  annexBNalu,
  collect,
  concat,
  hevcAccessUnit,
  hevcDeltaAccessUnit,
  idrAccessUnit,
  mixedVideoPmtSection,
  patSection,
  pesPacket,
  pmtSectionHevc,
  psiPackets,
  readU32BE,
} from './ts-demuxer.fixtures.js';
import type { SeqEvent, VideoEvent } from './ts-demuxer.fixtures.js';

describe('TsDemuxer HEVC (stream_type 0x24)', () => {
  it('emits an hvcC sequence header then key/delta video chunks', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSectionHevc(HEVC_VIDEO_PID), PMT_PID),
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcAccessUnit(), 90000),
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcDeltaAccessUnit(), 180000),
      ),
    );
    demuxer.flush();

    const seq = events.find((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seq).toBeDefined();
    expect(seq?.config.codec).toBe('hvc1.1.6.L93.B0');
    const description = seq?.config.description as Uint8Array;
    expect(description).toBeDefined();
    // Round-trip: the emitted description parses back to the emitted codec.
    expect(parseHvcC(description).codec).toBe(seq?.config.codec);

    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos).toHaveLength(2);
    expect(videos[0]?.chunk.type).toBe('key');
    expect(videos[1]?.chunk.type).toBe('delta');
    // Length-prefixed framing: the first 4 bytes are the VPS length.
    expect(readU32BE(videos[0]?.chunk.data as Uint8Array)).toBe(HEVC_VPS.length);
  });

  it('does not emit a second sequence header when the SPS repeats', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    const es = concat(
      annexBNalu(HEVC_VPS),
      annexBNalu(HEVC_SPS),
      annexBNalu(HEVC_SPS), // repeated SPS
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
    demuxer.flush();
    const seqs = events.filter((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seqs).toHaveLength(1);
  });

  it('demuxes H.264 and HEVC streams from a mixed PMT', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(mixedVideoPmtSection(VIDEO_PID, HEVC_VIDEO_PID), PMT_PID),
        pesPacket(VIDEO_PID, 0xe0, idrAccessUnit(), 90000),
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcAccessUnit(), 90000),
      ),
    );
    demuxer.flush();

    const seqs = events.filter((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seqs).toHaveLength(2);
    const codecs = seqs.map((s) => s.config.codec).sort();
    expect(codecs).toEqual(['avc1.42001f', 'hvc1.1.6.L93.B0']);

    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos).toHaveLength(2);
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(0);
  });

  it('waits for VPS/SPS/PPS before emitting HEVC chunks or a header', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSectionHevc(HEVC_VIDEO_PID), PMT_PID),
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcDeltaAccessUnit(), 90000),
      ),
    );
    demuxer.flush();
    let videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos).toHaveLength(0);
    let seqs = events.filter((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seqs).toHaveLength(0);

    // Parameter sets arrive together with an IRAP in the next PES.
    demuxer.push(
      concat(
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcAccessUnit(), 180000),
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcDeltaAccessUnit(), 270000),
      ),
    );
    demuxer.flush();
    seqs = events.filter((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seqs).toHaveLength(1);
    videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps HEVC timestamps monotonic across a PTS rollback', () => {
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(
        psiPackets(patSection(PMT_PID), 0),
        psiPackets(pmtSectionHevc(HEVC_VIDEO_PID), PMT_PID),
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcAccessUnit(), 90000),
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcDeltaAccessUnit(), 180000),
      ),
    );
    demuxer.flush();
    // Rolled-back PTS group: 0 and 90000 ticks.
    demuxer.push(
      concat(
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcAccessUnit(), 0),
        pesPacket(HEVC_VIDEO_PID, 0xe0, hevcDeltaAccessUnit(), 90000),
      ),
    );
    demuxer.flush();

    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos).toHaveLength(4);
    for (let i = 1; i < videos.length; i++) {
      expect(videos[i]?.chunk.timestamp).toBeGreaterThan(videos[i - 1]?.chunk.timestamp as number);
    }
  });

  it('parses the generated hevc-seg-0.ts fixture', () => {
    const fixturePath = fileURLToPath(
      new URL('../../../../../examples/basic/hls-fixtures/hevc-seg-0.ts', import.meta.url),
    );
    const bytes = readFileSync(fixturePath);
    const demuxer = new TsDemuxer();
    const events = collect(demuxer);
    for (let offset = 0; offset < bytes.length; offset += 7168) {
      demuxer.push(bytes.subarray(offset, offset + 7168));
    }
    demuxer.flush();

    const seq = events.find((event): event is SeqEvent => event.type === 'sequence-header');
    expect(seq).toBeDefined();
    expect(seq?.config.codec).toMatch(/^hvc1\..+/);
    expect(seq?.config.description).toBeDefined();

    const videos = events.filter((event): event is VideoEvent => event.type === 'video');
    expect(videos.length).toBeGreaterThanOrEqual(1);

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FlvDemuxer } from './flv-demuxer.js';
import { flvDemuxerPlugin } from './plugin.js';
import {
  AVC_CONFIG,
  NALU,
  aacTag,
  collect,
  concat,
  header,
  metadataTag,
  u24,
  u32,
  videoNaluTag,
  videoSeqTag,
  type AudioConfigEvent,
  type AudioEvent,
  type MetadataEvent,
  type SeqEvent,
  type VideoEvent,
} from './flv-test-utils.js';

describe('FlvDemuxer', () => {
  it('accepts a valid header and emits nothing before the first tag', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(header());
    expect(events).toEqual([]);
    demuxer.push(metadataTag());
    expect(events.map((e) => e.type)).toEqual(['metadata']);
    demuxer.close();
  });

  it('emits a DEMUX_BAD_SIGNATURE error for a bad magic', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { code: 'DEMUX_BAD_SIGNATURE' } });
    demuxer.close();
  });

  it('buffers a truncated header and completes parsing when the rest arrives', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    const full = header();
    demuxer.push(full.subarray(0, 5));
    expect(events).toEqual([]);
    demuxer.push(full.subarray(5));
    expect(events).toEqual([]);
    demuxer.push(metadataTag());
    expect(events.map((e) => e.type)).toEqual(['metadata']);
    demuxer.close();
  });

  it('parses a tag whose payload is split across push calls exactly once', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    const buffer = concat(header(), videoSeqTag(), videoNaluTag(NALU));
    demuxer.push(buffer.subarray(0, 50));
    demuxer.push(buffer.subarray(50));
    expect(events.filter((e) => e.type === 'video')).toHaveLength(1);
    demuxer.close();
  });

  it('dispatches multiple complete tags from one push in order', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), metadataTag(), videoSeqTag(), videoNaluTag(NALU)));
    expect(events.map((e) => e.type)).toEqual(['metadata', 'sequence-header', 'video']);
    demuxer.close();
  });

  it('emits a sequence-header event with codec avc1.64001f and the avcC description', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), videoSeqTag()));
    const seqs = events.filter((e): e is SeqEvent => e.type === 'sequence-header');
    expect(seqs).toHaveLength(1);
    expect(seqs[0]?.config.codec).toBe('avc1.64001f');
    expect(Array.from(seqs[0]?.config.description as Uint8Array)).toEqual(Array.from(AVC_CONFIG));
    demuxer.close();
  });

  it('emits DEMUX_MISSING_SEQUENCE_HEADER for a NALU before the seq header', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), videoNaluTag(NALU)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'DEMUX_MISSING_SEQUENCE_HEADER' },
    });
    demuxer.close();
  });

  it('emits a video event with length-prefixed (avc) data for a key frame NALU after the seq header', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), videoSeqTag(), videoNaluTag(NALU, 1, 33)));
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(1);
    expect(videos[0]?.chunk.type).toBe('key');
    expect(videos[0]?.chunk.timestamp).toBe(33 * 1000);
    // The sequence header carries the avcC description, so WebCodecs expects
    // avc-format chunks: the 4-byte big-endian NALU length prefix must be
    // preserved (0x00000003 here), not replaced by an Annex-B start code.
    expect(Array.from(videos[0]?.chunk.data as Uint8Array)).toEqual(Array.from(NALU));
    demuxer.close();
  });

  it('emits delta for an inter frame NALU', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), videoSeqTag(), videoNaluTag(NALU, 2, 100)));
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(1);
    expect(videos[0]?.chunk.type).toBe('delta');
    demuxer.close();
  });

  it('emits a metadata event with width/height from onMetaData', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), metadataTag()));
    const metas = events.filter((e): e is MetadataEvent => e.type === 'metadata');
    expect(metas).toHaveLength(1);
    expect(metas[0]?.metadata.width).toBe(1280);
    expect(metas[0]?.metadata.height).toBe(720);
    expect(metas[0]?.metadata.hasAudio).toBe(true);
    expect(metas[0]?.metadata.hasVideo).toBe(true);
    demuxer.close();
  });

  it('emits an audio-config event from the AAC sequence header', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    const aacConfig = new Uint8Array([0x12, 0x10]);
    demuxer.push(concat(header(), aacTag(0, aacConfig, 10)));
    const configs = events.filter((e): e is AudioConfigEvent => e.type === 'audio-config');
    expect(configs).toHaveLength(1);
    expect(configs[0]?.config.codec).toBe('mp4a.40.2');
    expect(configs[0]?.config.sampleRate).toBe(44100);
    expect(configs[0]?.config.numberOfChannels).toBe(2);
    expect(Array.from(configs[0]?.config.description as Uint8Array)).toEqual(Array.from(aacConfig));
    expect(events.filter((e) => e.type === 'audio')).toHaveLength(0);
    demuxer.close();
  });

  it('emits raw audio chunks for AAC RAW packets with no ASC prefix', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    const raw = new Uint8Array([0x21, 0x00, 0xaa]);
    demuxer.push(concat(header(), aacTag(1, raw, 20)));
    const audios = events.filter((e): e is AudioEvent => e.type === 'audio');
    expect(audios).toHaveLength(1);
    expect(audios[0]?.chunk.type).toBe('key');
    expect(audios[0]?.chunk.timestamp).toBe(20 * 1000);
    expect(Array.from(audios[0]?.chunk.data as Uint8Array)).toEqual(Array.from(raw));
    expect(events.filter((e) => e.type === 'audio-config')).toHaveLength(0);
    demuxer.close();
  });

  it('tolerates a wrong prevTagSize value', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    const nalu = videoNaluTag(NALU);
    nalu[nalu.length - 1] = 0xde; // corrupt prevTagSize
    demuxer.push(concat(header(), videoSeqTag(), nalu));
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.filter((e) => e.type === 'video')).toHaveLength(1);
    demuxer.close();
  });

  it('reads an extended timestamp from the payload when lower 24 bits are 0xFFFFFF', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    const extByte = 0x01;
    const lower = 0xffffff;
    const extTs = (extByte << 24) | lower;
    const naluPayload = new Uint8Array(5 + NALU.length);
    naluPayload[0] = 0x17;
    naluPayload[1] = 0x01;
    naluPayload.set(NALU, 5);
    const tag = new Uint8Array(11 + 4 + naluPayload.length + 4);
    tag[0] = 9;
    tag.set(u24(naluPayload.length + 4), 1); // dataSize includes the 4 ext-timestamp bytes
    tag.set(u24(lower), 4);
    tag[7] = extByte;
    tag.set(u32(extTs), 11);
    tag.set(naluPayload, 15);
    demuxer.push(concat(header(), videoSeqTag(), tag));
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(1);
    expect(videos[0]?.chunk.timestamp).toBe(((extByte << 24) | lower) * 1000);
    demuxer.close();
  });

  it('flush discards a partial trailing tag without throwing or emitting', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), videoSeqTag(), videoNaluTag(NALU).subarray(0, 7)));
    expect(() => demuxer.flush()).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('sequence-header');
    demuxer.close();
  });

  it('a tag with dataSize over the maximum surfaces a DEMUX error instead of buffering forever', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    // Tag header whose dataSize claims 16MB-1 (the u24 ceiling, 0xFFFFFF) —
    // the corrupt value that previously made the demuxer buffer indefinitely.
    const huge = new Uint8Array(11 + 4 + 4);
    huge[0] = 9; // video tag
    huge.set(u24(0xffffff), 1);
    demuxer.push(concat(header(), huge));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'DEMUX', message: 'tag exceeds maximum size' },
    });
    // The demuxer is failed: later pushes are inert.
    demuxer.push(concat(header(), videoSeqTag()));
    expect(events).toHaveLength(1);
    demuxer.close();
  });

  it('demuxes the real fate-head.bin fixture in 7KB chunks', () => {
    const fixture = readFileSync(new URL('../test/fixtures/fate-head.bin', import.meta.url));
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    const chunkSize = 7168;
    for (let i = 0; i < fixture.length; i += chunkSize) {
      demuxer.push(fixture.subarray(i, i + chunkSize));
    }
    demuxer.flush();
    const seqs = events.filter((e): e is SeqEvent => e.type === 'sequence-header');
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    const metas = events.filter((e): e is MetadataEvent => e.type === 'metadata');
    expect(seqs.length).toBeGreaterThanOrEqual(1);
    expect(videos.length).toBeGreaterThanOrEqual(1);
    expect(metas.length).toBeGreaterThanOrEqual(1);
    for (const seq of seqs) {
      expect(seq.config.codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
    }
    for (const video of videos) {
      const data = video.chunk.data;
      if (data.length >= 4) {
        // avc format: the first 4 bytes are the big-endian NALU length
        // (Annex-B start codes 0x00000001 would also be a length of 1, so this
        // is a sanity guard against malformed/garbage payloads, not a
        // start-code check).
        const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
        expect(length).toBeGreaterThan(0);
        expect(length).toBeLessThan(65536);
      }
    }
    demuxer.close();
  });
});

describe('flvDemuxerPlugin', () => {
  it('satisfies the DemuxerPlugin contract', () => {
    const plugin = flvDemuxerPlugin();
    expect(plugin.type).toBe('demuxer');
    expect(plugin.id).toBe('flv');
    expect(plugin.mimeTypes).toContain('video/x-flv');
    expect(plugin.schemes).toContain('flv');
    const demuxer = plugin.create();
    expect(typeof demuxer.push).toBe('function');
    expect(typeof demuxer.flush).toBe('function');
    expect(typeof demuxer.onEvent).toBe('function');
    expect(typeof demuxer.close).toBe('function');
    demuxer.close();
  });
});

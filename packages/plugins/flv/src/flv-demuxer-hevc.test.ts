import { describe, expect, it } from 'vitest';
import { FlvDemuxer } from './flv-demuxer.js';
import {
  HEVC_HVCC,
  HEVC_NALUS,
  collect,
  concat,
  header,
  hevcCodedFramesTag,
  hevcSeqTag,
  legacyHevcTag,
  type SeqEvent,
  type VideoEvent,
} from './flv-test-utils.js';

describe('FlvDemuxer Enhanced-RTMP HEVC', () => {
  it('emits a sequence-header with the hvc1 codec string from a box-wrapped SequenceStart', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), hevcSeqTag(HEVC_HVCC)));
    const seqs = events.filter((e): e is SeqEvent => e.type === 'sequence-header');
    expect(seqs).toHaveLength(1);
    expect(seqs[0]?.config.codec).toBe('hvc1.1.6.L93.B0');
    expect(Array.from(seqs[0]?.config.description as Uint8Array)).toEqual(Array.from(HEVC_HVCC));
    demuxer.close();
  });

  it('parses a raw (unboxed) hvcC SequenceStart payload', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), hevcSeqTag(HEVC_HVCC, 0, false)));
    const seqs = events.filter((e): e is SeqEvent => e.type === 'sequence-header');
    expect(seqs).toHaveLength(1);
    expect(seqs[0]?.config.codec).toBe('hvc1.1.6.L93.B0');
    demuxer.close();
  });

  it('emits key and delta video chunks with the tag timestamp and length-prefixed NALUs', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(
      concat(header(), hevcSeqTag(HEVC_HVCC), hevcCodedFramesTag(HEVC_NALUS, 1, 33), hevcCodedFramesTag(HEVC_NALUS, 2, 66)),
    );
    const videos = events.filter((e): e is VideoEvent => e.type === 'video');
    expect(videos).toHaveLength(2);
    expect(videos[0]?.chunk.type).toBe('key');
    expect(videos[0]?.chunk.timestamp).toBe(33 * 1000);
    expect(Array.from(videos[0]?.chunk.data as Uint8Array)).toEqual(Array.from(HEVC_NALUS));
    expect(videos[1]?.chunk.type).toBe('delta');
    expect(videos[1]?.chunk.timestamp).toBe(66 * 1000);
    demuxer.close();
  });

  it('emits DEMUX_MISSING_SEQUENCE_HEADER for coded frames before the sequence header', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), hevcCodedFramesTag(HEVC_NALUS)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'DEMUX_MISSING_SEQUENCE_HEADER' },
    });
    demuxer.close();
  });

  it('buffers an HEVC tag split across push calls and emits it exactly once', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    const buffer = concat(header(), hevcSeqTag(HEVC_HVCC), hevcCodedFramesTag(HEVC_NALUS));
    demuxer.push(buffer.subarray(0, 50));
    demuxer.push(buffer.subarray(50));
    expect(events.filter((e) => e.type === 'video')).toHaveLength(1);
    demuxer.close();
  });

  it('reports a DEMUX error for legacy codecId 12 without the Enhanced-RTMP header', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), legacyHevcTag()));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'DEMUX' },
    });
    demuxer.close();
  });

  it('ignores a SequenceEnd (packetType 2) tag without an error', () => {
    const demuxer = new FlvDemuxer();
    const events = collect(demuxer);
    demuxer.push(concat(header(), hevcSeqTag(HEVC_HVCC), hevcCodedFramesTag(HEVC_NALUS, 1, 10, 2)));
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'video')).toHaveLength(0);
    demuxer.close();
  });
});

import { describe, expect, it } from 'vitest';
import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import { buildAvcC, codecStringFromSps } from '@vigilkit/media-utils';
import type { EncodedFrameMessage } from './whep-encoded.js';
import { EncodedMediaAssembler } from './whep-encoded.js';
import { parseSdpMedia } from './whep-sdp.js';

type SeqEvent = Extract<DemuxerEvent, { type: 'sequence-header' }>;
type AudioConfigEvent = Extract<DemuxerEvent, { type: 'audio-config' }>;
type VideoEvent = Extract<DemuxerEvent, { type: 'video' }>;
type AudioEvent = Extract<DemuxerEvent, { type: 'audio' }>;

// Realistic H.264 parameter sets (same shapes as the HLS fixtures): SPS is
// baseline profile, level 3.1 → codec avc1.42001f.
const SPS = [0x67, 0x42, 0x00, 0x1f, 0x95, 0xa8, 0x14, 0x01, 0x6e, 0x90];
const PPS = [0x68, 0xce, 0x06, 0xe2];
const IDR = [0x65, 0x88, 0x84, 0x00, 0x00]; // NAL type 5 (CodedSliceIdr)
const P_SLICE = [0x41, 0x9a, 0x22, 0x00, 0x02]; // NAL type 1 (CodedSliceNonIdr)
const SEI = [0x06, 0x05]; // NAL type 6
const AUD = [0x09, 0xf0]; // NAL type 9

/** Annex-B (start-code) framing — the format Chromium delivers per access unit. */
function annexB(...nalus: number[][]): ArrayBuffer {
  const parts: Uint8Array[] = [];
  for (const nalu of nalus) {
    parts.push(Uint8Array.from([0, 0, 0, 1]), Uint8Array.from(nalu));
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out.buffer;
}

/** AVCC (4-byte big-endian length) framing — the design-doc assumption. */
function avcc(...nalus: number[][]): ArrayBuffer {
  const bytes: number[] = [];
  for (const nalu of nalus) {
    bytes.push((nalu.length >>> 24) & 0xff, (nalu.length >>> 16) & 0xff, (nalu.length >>> 8) & 0xff, nalu.length & 0xff);
    bytes.push(...nalu);
  }
  return Uint8Array.from(bytes).buffer;
}

function videoMsg(data: ArrayBuffer, overrides: Partial<EncodedFrameMessage> = {}): EncodedFrameMessage {
  return {
    kind: 'video',
    type: 'delta',
    metadata: { rtpTimestamp: 90000, payloadType: 96, mimeType: 'video/H264' },
    data,
    ...overrides,
  };
}

function audioMsg(data: ArrayBuffer = Uint8Array.from([0xfc, 0x01, 0x02, 0x03]).buffer, rtpTimestamp = 48000): EncodedFrameMessage {
  return { kind: 'audio', metadata: { rtpTimestamp, payloadType: 111, mimeType: 'audio/opus' }, data };
}

function videoChunks(events: DemuxerEvent[]): VideoEvent['chunk'][] {
  return events.filter((event): event is VideoEvent => event.type === 'video').map((event) => event.chunk);
}

function audioChunks(events: DemuxerEvent[]): AudioEvent['chunk'][] {
  return events.filter((event): event is AudioEvent => event.type === 'audio').map((event) => event.chunk);
}

function seqHeaders(events: DemuxerEvent[]): SeqEvent[] {
  return events.filter((event): event is SeqEvent => event.type === 'sequence-header');
}

describe('EncodedMediaAssembler video', () => {
  it('emits a sequence-header from the SDP-provided config immediately on construction', () => {
    const events: DemuxerEvent[] = [];
    const sps = Uint8Array.from(SPS);
    const pps = Uint8Array.from(PPS);
    const expected = buildAvcC(sps, pps, 4);
    new EncodedMediaAssembler((event) => events.push(event), {
      videoConfigFromSdp: { codec: codecStringFromSps(sps), description: expected },
    });

    expect(events).toHaveLength(1);
    const seq = events[0] as SeqEvent;
    expect(seq.type).toBe('sequence-header');
    expect(seq.config.codec).toBe('avc1.42001f');
    expect(Array.from(seq.config.description as Uint8Array)).toEqual(Array.from(expected));
  });

  it('builds config from in-band SPS/PPS on a keyframe and emits an AVCC chunk without them', () => {
    const events: DemuxerEvent[] = [];
    const assembler = new EncodedMediaAssembler((event) => events.push(event));
    assembler.handleEncodedMessage(videoMsg(annexB(SPS, PPS, IDR), { type: 'key', metadata: { rtpTimestamp: 90000 } }));

    expect(events.map((event) => event.type)).toEqual(['sequence-header', 'video']);
    const seq = seqHeaders(events)[0];
    expect(seq?.config.codec).toBe('avc1.42001f');
    const description = seq?.config.description as Uint8Array;
    expect(description[5]).toBe(0xe1); // one SPS
    expect(description[7]).toBe(SPS.length); // SPS length byte

    const chunk = videoChunks(events)[0];
    expect(chunk?.type).toBe('key');
    // round(90000 RTP ticks × 1e6 / 90000) = 1_000_000 µs, exact.
    expect(chunk?.timestamp).toBe(1_000_000);
    // Chunk carries only the IDR, re-framed as AVCC (SPS/PPS moved into the config).
    expect(Array.from(chunk?.data ?? [])).toEqual([0, 0, 0, IDR.length, ...IDR]);
  });

  it('emits a delta chunk with a delta type and does not re-emit the config', () => {
    const events: DemuxerEvent[] = [];
    const assembler = new EncodedMediaAssembler((event) => events.push(event));
    assembler.handleEncodedMessage(videoMsg(annexB(SPS, PPS, IDR), { type: 'key', metadata: { rtpTimestamp: 90000 } }));
    assembler.handleEncodedMessage(videoMsg(annexB(P_SLICE), { type: 'delta', metadata: { rtpTimestamp: 180000 } }));

    expect(events.map((event) => event.type)).toEqual(['sequence-header', 'video', 'video']);
    expect(seqHeaders(events)).toHaveLength(1);
    const chunks = videoChunks(events);
    expect(chunks[1]?.type).toBe('delta');
    expect(chunks[1]?.timestamp).toBe(2_000_000);
    expect(Array.from(chunks[1]?.data ?? [])).toEqual([0, 0, 0, P_SLICE.length, ...P_SLICE]);
  });

  it('does not emit a video chunk for an access unit without VCL NALUs (SPS/PPS/SEI only)', () => {
    const events: DemuxerEvent[] = [];
    const assembler = new EncodedMediaAssembler((event) => events.push(event));
    assembler.handleEncodedMessage(videoMsg(annexB(SPS, PPS, SEI, AUD), { type: 'key' }));
    expect(events).toHaveLength(0);
  });

  it('is a no-op for empty frame data', () => {
    const events: DemuxerEvent[] = [];
    const assembler = new EncodedMediaAssembler((event) => events.push(event));
    assembler.handleEncodedMessage(videoMsg(new ArrayBuffer(0)));
    assembler.handleEncodedMessage(audioMsg(new ArrayBuffer(0)));
    expect(events).toHaveLength(0);
  });

  it('emits the config only once when SPS/PPS repeat across keyframes', () => {
    const events: DemuxerEvent[] = [];
    const assembler = new EncodedMediaAssembler((event) => events.push(event));
    assembler.handleEncodedMessage(videoMsg(annexB(SPS, PPS, IDR), { type: 'key' }));
    assembler.handleEncodedMessage(videoMsg(annexB(SPS, PPS, IDR), { type: 'key', metadata: { rtpTimestamp: 180000 } }));
    expect(seqHeaders(events)).toHaveLength(1);
  });

  it('accepts length-prefixed (AVCC) frame data in addition to Annex-B', () => {
    const events: DemuxerEvent[] = [];
    const assembler = new EncodedMediaAssembler((event) => events.push(event));
    assembler.handleEncodedMessage(videoMsg(avcc(SPS, PPS, IDR), { type: 'key', metadata: { rtpTimestamp: 90000 } }));
    expect(events.map((event) => event.type)).toEqual(['sequence-header', 'video']);
    const chunk = videoChunks(events)[0];
    expect(chunk?.type).toBe('key');
    expect(Array.from(chunk?.data ?? [])).toEqual([0, 0, 0, IDR.length, ...IDR]);
  });

  it('updates the config when in-band SPS/PPS differ from the SDP-provided one', () => {
    const events: DemuxerEvent[] = [];
    // SDP advertises a different (high) profile → codec avc1.64001f.
    const sdpSps = Uint8Array.from([0x67, 0x64, 0x00, 0x1f, 0x95, 0x01, 0x00]);
    const sdpPps = Uint8Array.from(PPS);
    const assembler = new EncodedMediaAssembler((event) => events.push(event), {
      videoConfigFromSdp: { codec: codecStringFromSps(sdpSps), description: buildAvcC(sdpSps, sdpPps, 4) },
    });
    expect(seqHeaders(events)).toHaveLength(1);
    expect(seqHeaders(events)[0]?.config.codec).toBe('avc1.64001f');

    // In-band SPS/PPS carry the baseline profile → config changes → re-emit.
    assembler.handleEncodedMessage(videoMsg(annexB(SPS, PPS, IDR), { type: 'key' }));
    const headers = seqHeaders(events);
    expect(headers).toHaveLength(2);
    expect(headers[1]?.config.codec).toBe('avc1.42001f');
  });

  it('uses the frame `type` of key only when no IDR NAL is present', () => {
    const events: DemuxerEvent[] = [];
    const assembler = new EncodedMediaAssembler((event) => events.push(event));
    assembler.handleEncodedMessage(videoMsg(annexB(SPS, PPS, IDR), { type: 'delta', metadata: { rtpTimestamp: 90000 } }));
    // A delta-typed frame that still contains an IDR NAL is a keyframe.
    expect(videoChunks(events)[0]?.type).toBe('key');
  });
});

describe('EncodedMediaAssembler audio', () => {
  it('emits audio-config once (Opus 48kHz stereo) and audio chunks with a 48kHz→µs timestamp', () => {
    const events: DemuxerEvent[] = [];
    const assembler = new EncodedMediaAssembler((event) => events.push(event));
    assembler.handleEncodedMessage(audioMsg(undefined, 48000));
    assembler.handleEncodedMessage(audioMsg(undefined, 96000));

    expect(events.map((event) => event.type)).toEqual(['audio-config', 'audio', 'audio']);
    const config = (events[0] as AudioConfigEvent).config;
    expect(config.codec).toBe('opus');
    expect(config.sampleRate).toBe(48000);
    expect(config.numberOfChannels).toBe(2);
    const chunks = audioChunks(events);
    expect(chunks[0]?.timestamp).toBe(1_000_000);
    expect(chunks[1]?.timestamp).toBe(2_000_000);
    expect(Array.from(chunks[0]?.data ?? [])).toEqual([0xfc, 0x01, 0x02, 0x03]);
  });

  it('honours the SDP-provided audio config (rtpmap opus/24000/1) over the defaults', () => {
    const events: DemuxerEvent[] = [];
    const assembler = new EncodedMediaAssembler((event) => events.push(event), {
      audioConfigFromSdp: { codec: 'opus', sampleRate: 24000, numberOfChannels: 1 },
    });
    assembler.handleEncodedMessage(audioMsg());
    const config = (events[0] as AudioConfigEvent).config;
    expect(config.sampleRate).toBe(24000);
    expect(config.numberOfChannels).toBe(1);
  });
});

describe('parseSdpMedia', () => {
  it('parses video (H264/90000 + sprop-parameter-sets) and audio (opus/48000/2) media sections', () => {
    const spsB64 = Buffer.from(SPS).toString('base64');
    const ppsB64 = Buffer.from(PPS).toString('base64');
    const sdp = [
      'v=0',
      'o=- 2 2 IN IP4 127.0.0.1',
      's=-',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 H264/90000',
      `a=fmtp:96 packetization-mode=1; sprop-parameter-sets=${spsB64},${ppsB64}`,
      'a=mid:0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=mid:1',
      '',
    ].join('\r\n');

    const media = parseSdpMedia(sdp);
    expect(media).toHaveLength(2);
    const video = media[0];
    expect(video?.kind).toBe('video');
    expect(video?.codec).toBe('H264');
    expect(video?.payloadType).toBe(96);
    expect(video?.sampleRate).toBe(90000);
    expect(video?.spsB64).toBe(spsB64);
    expect(video?.ppsB64).toBe(ppsB64);
    const audio = media[1];
    expect(audio?.kind).toBe('audio');
    expect(audio?.codec).toBe('opus');
    expect(audio?.payloadType).toBe(111);
    expect(audio?.sampleRate).toBe(48000);
    expect(audio?.channels).toBe(2);
  });

  it('skips media sections without a payload type and sections that are not audio/video', () => {
    const sdp = [
      'v=0',
      'o=- 2 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=mid:0',
      'm=application 9 UDP/TLS/RTP/SAVPF 127',
      'a=rtpmap:127 webrtc-datachannel/1000',
      '',
    ].join('\r\n');
    expect(parseSdpMedia(sdp)).toEqual([]);
  });
});

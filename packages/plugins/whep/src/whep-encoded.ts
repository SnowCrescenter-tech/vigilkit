import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import { buildAvcC, codecStringFromSps, isAnnexB, splitAnnexBNalus } from '@vigilkit/media-utils';

/**
 * Main-thread assembler for the WHEP insertable-streams encoded path.
 *
 * A worker `RTCRtpScriptTransform` forwards each inbound `RTCEncodedVideoFrame`
 * / `RTCEncodedAudioFrame` to this thread as `{ kind, type?, metadata, data }`.
 * Per the verified API surface, an inbound video frame is ONE complete access
 * unit (Chromium's depacketizer reassembles FU-A fragments and groups packets
 * by RTP timestamp before the receive transform) whose data is Annex-B
 * (a series of start-code NAL units, with SPS/PPS prepended to the first IDR).
 * Both Annex-B and length-prefixed input are accepted here.
 *
 * The assembler turns access units into the SDK `DemuxerEvent` stream the
 * engine already consumes: a `sequence-header` (avcC `description`, once),
 * `video` chunks re-framed as AVCC (SPS/PPS stripped into the config), an
 * `audio-config`, and `audio` chunks carrying raw Opus packets.
 */

export const VIDEO_CLOCK_RATE = 90000;
export const OPUS_CLOCK_RATE = 48000;
const OPUS_DEFAULT_SAMPLE_RATE = 48000;
const OPUS_DEFAULT_CHANNELS = 2;

/** Structured-clone snapshot of `RTCEncodedVideoFrame.getMetadata()`. */
export interface EncodedFrameMetadata {
  payloadType?: number;
  rtpTimestamp?: number;
  timestamp?: number;
  synchronizationSource?: number;
  contributingSources?: number[];
  mimeType?: string;
  frameId?: number;
  dependencies?: number[];
  width?: number;
  height?: number;
  spatialIndex?: number;
  temporalIndex?: number;
  sequenceNumber?: number;
}

/** Message posted by the transform worker for one encoded frame. */
export interface EncodedFrameMessage {
  kind: 'video' | 'audio';
  /** Present on video frames only (the `RTCEncodedVideoFrame.type`). */
  type?: 'key' | 'delta' | 'empty';
  metadata: EncodedFrameMetadata;
  data: ArrayBuffer | ArrayBufferView;
}

/** A decoder-ready H.264 config derived from an SPS/PPS pair. */
export interface EncodedMediaConfig {
  codec: string;
  description: Uint8Array;
}

export interface EncodedAssemblerOptions {
  /** SDP sprop-parameter-sets: emitted as a sequence-header on construction. */
  videoConfigFromSdp?: EncodedMediaConfig;
  /** SDP rtpmap for Opus: overrides the 48kHz/stereo defaults. */
  audioConfigFromSdp?: AudioDecoderConfig;
}

type Listener = (event: DemuxerEvent) => void;

/**
 * Splits frame data into NAL unit payloads whether it is Annex-B (start-code
 * framed, the Chromium receive-transform reality) or AVCC (4-byte BE length
 * prefixed). NAL unit payloads include their header byte.
 */
export function splitNalus(data: Uint8Array): Uint8Array[] {
  if (isAnnexB(data)) return splitAnnexBNalus(data);
  const nalus: Uint8Array[] = [];
  let pos = 0;
  while (pos + 4 <= data.length) {
    const length = readU32(data, pos);
    if (length === 0 || pos + 4 + length > data.length) break;
    nalus.push(data.slice(pos + 4, pos + 4 + length));
    pos += 4 + length;
  }
  return nalus;
}

/** Re-frames NAL unit payloads as AVCC (4-byte big-endian length prefix). */
export function rebuildAvcc(nalus: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const nalu of nalus) total += 4 + nalu.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const nalu of nalus) {
    out[pos] = (nalu.length >>> 24) & 0xff;
    out[pos + 1] = (nalu.length >>> 16) & 0xff;
    out[pos + 2] = (nalu.length >>> 8) & 0xff;
    out[pos + 3] = nalu.length & 0xff;
    out.set(nalu, pos + 4);
    pos += 4 + nalu.length;
  }
  return out;
}

/** Converts an RTP-clock timestamp to microseconds (exact, rounded). */
export function rtpTimestampToUs(rtpTimestamp: number, clockRate: number): number {
  return Math.round((rtpTimestamp * 1e6) / clockRate);
}

/**
 * The raw RTP-clock value carried by the frame metadata. Chromium always
 * populates `rtpTimestamp` (the RTP clock value, e.g. 90 kHz for video);
 * `timestamp` is only present under a runtime feature and — in Chromium's
 * current implementation — mirrors the raw value, so treating either as the
 * RTP clock keeps the conversion exact in both shapes.
 */
function rtpClock(metadata: EncodedFrameMetadata): number {
  return metadata.rtpTimestamp ?? metadata.timestamp ?? 0;
}

function naluType(nalu: Uint8Array): number {
  return (nalu[0] as number) & 0x1f;
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    ((((data[offset] as number) << 24) |
      ((data[offset + 1] as number) << 16) |
      ((data[offset + 2] as number) << 8) |
      (data[offset + 3] as number)) >>>
      0)
  );
}

function toUint8(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function configsEqual(a: EncodedMediaConfig | null, b: EncodedMediaConfig): boolean {
  if (a === null || a.codec !== b.codec || a.description.length !== b.description.length) return false;
  for (let i = 0; i < a.description.length; i++) {
    if (a.description[i] !== b.description[i]) return false;
  }
  return true;
}

/**
 * Turns worker transform messages into demuxer events. Stateful across
 * frames: emits each config exactly once (or when the parameter sets change).
 */
export class EncodedMediaAssembler {
  private videoConfig: EncodedMediaConfig | null;
  private audioConfigEmitted = false;
  private readonly options: EncodedAssemblerOptions;
  private readonly emit: Listener;

  constructor(emit: Listener, opts: EncodedAssemblerOptions = {}) {
    this.emit = emit;
    this.options = opts;
    this.videoConfig = opts.videoConfigFromSdp ?? null;
    if (this.videoConfig !== null) {
      this.emit({ type: 'sequence-header', config: this.videoConfig });
    }
  }

  handleEncodedMessage(message: EncodedFrameMessage): void {
    switch (message.kind) {
      case 'audio':
        this.handleAudio(message);
        return;
      case 'video':
        this.handleVideo(message);
        return;
    }
  }

  private handleVideo(message: EncodedFrameMessage): void {
    const data = toUint8(message.data);
    if (data.length === 0) return;
    const nalus = splitNalus(data);
    if (nalus.length === 0) return;

    let sps: Uint8Array | null = null;
    let pps: Uint8Array | null = null;
    let hasVcl = false;
    let hasIdr = false;
    for (const nalu of nalus) {
      const type = naluType(nalu);
      if (type === 7) sps = nalu;
      else if (type === 8) pps = nalu;
      else if (type >= 1 && type <= 5) {
        hasVcl = true;
        if (type === 5) hasIdr = true;
      }
    }
    // SPS/PPS/SEI-only access units (and AUD) carry no picture: no chunk.
    if (!hasVcl) return;

    if (sps !== null && pps !== null) {
      const candidate: EncodedMediaConfig = {
        codec: codecStringFromSps(sps),
        description: buildAvcC(sps, pps, 4),
      };
      if (!configsEqual(this.videoConfig, candidate)) {
        this.videoConfig = candidate;
        this.emit({ type: 'sequence-header', config: candidate });
      }
    }
    if (this.videoConfig === null) return; // no decoder config yet: drop the frame

    // Chunk = the access unit's NALUs minus SPS/PPS (the config carries them),
    // re-framed as AVCC for the engine's avc-format decoder.
    const vclNalus = nalus.filter((nalu) => {
      const type = naluType(nalu);
      return type >= 1 && type <= 5;
    });
    const chunkData = rebuildAvcc(vclNalus);
    const type: 'key' | 'delta' = message.type === 'key' || hasIdr ? 'key' : 'delta';
    const timestamp = rtpTimestampToUs(rtpClock(message.metadata), VIDEO_CLOCK_RATE);
    this.emit({ type: 'video', chunk: { type, timestamp, data: chunkData } });
  }

  private handleAudio(message: EncodedFrameMessage): void {
    const data = toUint8(message.data);
    if (data.length === 0) return;
    if (!this.audioConfigEmitted) {
      this.audioConfigEmitted = true;
      const config =
        this.options.audioConfigFromSdp ?? {
          codec: 'opus',
          sampleRate: OPUS_DEFAULT_SAMPLE_RATE,
          numberOfChannels: OPUS_DEFAULT_CHANNELS,
        };
      this.emit({ type: 'audio-config', config });
    }
    const timestamp = rtpTimestampToUs(rtpClock(message.metadata), OPUS_CLOCK_RATE);
    this.emit({ type: 'audio', chunk: { type: 'key', timestamp, data } });
  }
}

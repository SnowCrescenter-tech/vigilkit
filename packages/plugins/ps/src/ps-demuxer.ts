/**
 * MPEG Program Stream (PS) demuxer for GB/T 28181 media channels
 * (ISO/IEC 13818-1 part 1: Systems).
 *
 * A PS stream is a sequence of start-code-delimited packets:
 *
 *   - pack header   `00 00 01 BA` (MPEG-2: fixed 14 bytes + stuffing, or
 *                    MPEG-1: 12 bytes) — detected by marker bits in byte 4
 *                    (`10xxxxxx` → MPEG-2, `0010xxxx` → MPEG-1)
 *   - system header `00 00 01 BB` (skipped)
 *   - PES packets   `00 00 01 <stream_id>` where 0xE0..0xEF are video and
 *                    0xC0..0xDF are audio
 *   - program end   `00 00 01 B9`
 *
 * The demuxer buffers partial packets across `push()` calls (a transport may
 * split anywhere), resyncs to the next start code on malformed input, and
 * never throws: structural failures surface as `error` events.
 *
 * Video PES payloads carry Annex-B H.264/HEVC elementary streams. The demuxer
 * emits a `sequence-header` (avcC / hvcC built from the parameter sets via
 * `@vigilkit/media-utils`) and then `video` chunks re-framed as length-
 * prefixed AVCC — the format the avcC/hvcC `description` promises WebCodecs.
 * Audio PES payloads (G.711 A/μ-law, G.726, or AAC) are emitted raw as
 * `audio` chunks; AAC over ADTS additionally yields one `audio-config`.
 */
import {
  MediaFormatError,
  adtsToConfig,
  buildAvcC,
  buildHvcC,
  codecStringFromHvcC,
  codecStringFromSps,
  splitAnnexBNalus,
  stripAdts,
} from '@vigilkit/media-utils';
import type { Demuxer, DemuxerEvent } from '@vigilkit/plugin-sdk';

/** PS stream_id values (ISO/IEC 13818-1 §2.4.3.6). */
export const PS_STREAM_ID = {
  PROGRAM_STREAM_MAP: 0xbc,
  PRIVATE_STREAM_1: 0xbd,
  PADDING_STREAM: 0xbe,
  PRIVATE_STREAM_2: 0xbf,
  AUDIO_MIN: 0xc0,
  AUDIO_MAX: 0xdf,
  VIDEO_MIN: 0xe0,
  VIDEO_MAX: 0xef,
  PROGRAM_END: 0xb9,
} as const;

/** Audio codecs a GB/T 28181 PS audio stream (0xC0+) can carry. */
export type PsAudioCodec = 'g711a' | 'g711u' | 'g726' | 'aac';

export interface PsDemuxerOptions {
  /**
   * Audio codec for streams whose payload does not self-identify (anything
   * without an ADTS syncword). Defaults to 'g711a', the most common GB/T
   * 28181 audio codec. Callers that know the codec from the SDP answer
   * (`a=rtpmap`) should pass it explicitly.
   */
  audioCodec?: PsAudioCodec;
}

type Listener = (event: DemuxerEvent) => void;

type VideoCodec = 'h264' | 'hevc';

interface VideoStreamState {
  sps: Uint8Array | null;
  pps: Uint8Array | null;
  vps: Uint8Array | null;
  seqEmitted: boolean;
}

interface AdtsHeader {
  profile: number;
  sampleRateIndex: number;
  sampleRate: number;
  channels: number;
  frameLength: number;
  isAdts: boolean;
}

/** MPEG-2 PTS/DTS 33-bit counter modulus. */
const PTS_MOD = 0x200000000; // 2^33
const SYNTHETIC_FRAME_US = 33333;

/** stream_ids that carry no optional PES header fields (ISO 13818-1 §2.4.3.6). */
const NO_OPTIONAL_HEADER = new Set<number>([
  0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xff,
]);

const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * Extracts a 33-bit PTS/DTS value from its 5-byte MPEG encoding:
 * `'0010' PTS[32..30] m PTS[29..15] m PTS[14..0] m` with marker bits `m`.
 */
export function readPts33(data: Uint8Array, offset: number): number {
  const b0 = data[offset] as number;
  const b1 = data[offset + 1] as number;
  const b2 = data[offset + 2] as number;
  const b3 = data[offset + 3] as number;
  const b4 = data[offset + 4] as number;
  return (
    ((b0 & 0x0e) >>> 1) * 0x40000000 +
    b1 * 0x400000 +
    (b2 & 0xfe) * 0x4000 +
    b3 * 0x80 +
    ((b4 & 0xfe) >>> 1)
  );
}

interface ParsedPes {
  streamId: number;
  /** Header length in bytes; the ES payload starts at `6 + (headerLength - 6)`. */
  headerLength: number;
  /** Payload length in bytes, or -1 when the declared length is inconsistent. */
  payloadLength: number;
  ptsTicks?: number;
  dtsTicks?: number;
}

type PesHeaderResult = { ok: true; pes: ParsedPes } | { ok: false; needMore: boolean };

/**
 * Parses a PES packet header starting at `data[0]` (assumes `data.length >= 9`).
 *
 * Three layouts are recognized, in order:
 *   1. MPEG-2 PES — byte 6 carries the `10` marker bits (`0x80..0xBF`).
 *   2. MPEG-1 video PES — byte 6 carries the `01` optional-header marker.
 *   3. No optional header (MPEG-1 audio and padding-like stream_ids).
 *
 * `PES_packet_length` counts the bytes following the length field, so the
 * payload length is `PES_packet_length - (headerLength - 6)`.
 */
function parsePesHeader(data: Uint8Array, packFormat: 'mpeg1' | 'mpeg2' | null): PesHeaderResult {
  const streamId = data[3] as number;
  const pesPacketLength = ((data[4] as number) << 8) | (data[5] as number);

  if (NO_OPTIONAL_HEADER.has(streamId)) {
    return { ok: true, pes: { streamId, headerLength: 6, payloadLength: pesPacketLength } };
  }

  const b6 = data[6] as number;

  // MPEG-2 PES: '10' marker bits, flags in byte 6, PES_header_data_length in byte 8.
  if (packFormat !== 'mpeg1' && (b6 & 0xc0) === 0x80) {
    const ptsDtsFlags = (b6 >> 4) & 0x03;
    const headerDataLength = data[8] as number;
    const headerLength = 9 + headerDataLength;
    // The PTS/DTS fields must fit inside the declared optional-header region;
    // a header too short for the flags it claims is malformed, not "waiting".
    const minHeaderLength = 9 + (ptsDtsFlags === 3 ? 10 : ptsDtsFlags === 2 ? 5 : 0);
    if (headerLength < minHeaderLength) {
      return { ok: false, needMore: false };
    }
    if (data.length < headerLength) {
      return { ok: false, needMore: true };
    }
    let offset = 9;
    let ptsTicks: number | undefined;
    let dtsTicks: number | undefined;
    if (ptsDtsFlags === 2 || ptsDtsFlags === 3) {
      ptsTicks = readPts33(data, offset);
      offset += 5;
    }
    if (ptsDtsFlags === 3) {
      dtsTicks = readPts33(data, offset);
    }
    return {
      ok: true,
      pes: { streamId, headerLength, payloadLength: pesPacketLength - 3 - headerDataLength, ptsTicks, dtsTicks },
    };
  }

  // MPEG-1 video PES: '01' marker + STD_buffer_scale/size (2 bytes, at 6..7),
  // then an optional PTS ('0010' prefix) / PTS+DTS ('0011' prefix) field at 8.
  if ((b6 & 0xc0) === 0x40 && streamId >= PS_STREAM_ID.VIDEO_MIN && streamId <= PS_STREAM_ID.VIDEO_MAX) {
    if (data.length < 9) {
      return { ok: false, needMore: true };
    }
    const prefix = (data[8] as number) >> 4;
    const ptsDts = prefix === 2 ? 2 : prefix === 3 ? 3 : 0;
    const headerLength = 8 + (ptsDts === 3 ? 10 : ptsDts === 2 ? 5 : 0);
    if (data.length < headerLength) {
      return { ok: false, needMore: true };
    }
    let ptsTicks: number | undefined;
    let dtsTicks: number | undefined;
    if (ptsDts === 2 || ptsDts === 3) {
      ptsTicks = readPts33(data, 8);
      if (ptsDts === 3) dtsTicks = readPts33(data, 13);
    }
    return {
      ok: true,
      pes: { streamId, headerLength, payloadLength: pesPacketLength - (headerLength - 6), ptsTicks, dtsTicks },
    };
  }

  // No optional header: payload follows the 6-byte prefix immediately.
  return { ok: true, pes: { streamId, headerLength: 6, payloadLength: pesPacketLength } };
}

/** Parses a 7-byte ADTS header (mirrors the HLS plugin's parser). */
function parseAdtsHeader(data: Uint8Array): AdtsHeader {
  const fail: AdtsHeader = { profile: 0, sampleRateIndex: 0, sampleRate: 0, channels: 0, frameLength: 0, isAdts: false };
  if (data.length < 7 || (data[0] as number) !== 0xff || ((data[1] as number) & 0xf0) !== 0xf0) {
    return fail;
  }
  const profile = ((data[2] as number) >> 6) & 0x03;
  const sampleRateIndex = ((data[2] as number) >> 2) & 0x0f;
  const channels = (((data[2] as number) & 0x01) << 2) | (((data[3] as number) >> 6) & 0x03);
  const frameLength =
    (((data[3] as number) & 0x03) << 11) |
    ((data[4] as number) << 3) |
    (((data[5] as number) >> 5) & 0x07);
  return {
    isAdts: true,
    profile,
    sampleRateIndex,
    sampleRate: SAMPLE_RATES[sampleRateIndex] ?? 0,
    channels,
    frameLength,
  };
}

/**
 * Detects H.264 vs HEVC from the parameter-set NALUs of a video PES.
 *
 * Only definitive markers decide: H.264 SPS/PPS (types 7/8) or HEVC VPS/SPS
 * (types 32/33). An H.264 slice byte like `0x41` reads as HEVC type 32 too,
 * so type 32 counts only when the H.264 interpretation (type 0) is a value
 * no real stream starts with. When nothing is definitive, `null` is returned
 * and the caller falls back to H.264 (the GB/T 28181 default).
 */
function detectVideoCodec(nalus: Uint8Array[]): VideoCodec | null {
  for (const nalu of nalus) {
    if (nalu.length === 0) continue;
    const h264Type = (nalu[0] as number) & 0x1f;
    if (h264Type === 7 || h264Type === 8) return 'h264'; // SPS / PPS
    const hevcType = ((nalu[0] as number) >> 1) & 0x3f;
    if (hevcType === 33) return 'hevc'; // SPS
    if (hevcType === 32 && h264Type === 0) return 'hevc'; // VPS
  }
  return null;
}

/** Re-frames NALUs as AVCC (4-byte big-endian length prefixes). */
function rebuildAvcc(nalus: Uint8Array[]): Uint8Array {
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

/**
 * PS demuxer implementing the SDK `Demuxer` contract. Robust by design:
 * pushes are buffered until packet boundaries, malformed input is skipped by
 * resyncing to the next start code, and no input can make it throw.
 */
export class PsDemuxer implements Demuxer {
  private readonly listeners = new Set<Listener>();
  private readonly options: PsDemuxerOptions;
  private buffer = new Uint8Array(0);
  private cursor = 0;
  /** Non-null while we are waiting for the rest of a recognized packet. */
  private pendingStart: number | null = null;
  private packFormat: 'mpeg1' | 'mpeg2' | null = null;
  private readonly videoCodec = new Map<number, VideoCodec>();
  private readonly videoState = new Map<number, VideoStreamState>();
  private readonly audioCodec = new Map<number, PsAudioCodec>();
  private hasVideoStream = false;
  private hasAudioStream = false;
  private videoMetaEmitted = false;
  private audioMetaEmitted = false;
  private audioConfigEmitted = false;
  private adtsCarry = new Uint8Array(0);
  private lastRawTicks: number | null = null;
  private wrapOffsetTicks = 0;
  private lastEmittedPtsUs: number | null = null;
  private ptsOffsetUs = 0;

  constructor(options: PsDemuxerOptions = {}) {
    this.options = options;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const rest = this.buffer.subarray(this.cursor);
    const next = new Uint8Array(rest.length + chunk.length);
    next.set(rest, 0);
    next.set(chunk, rest.length);
    this.buffer = next;
    this.cursor = 0;
    this.pendingStart = null;
    this.parse();
  }

  flush(): void {
    this.parse();
    if (this.pendingStart !== null) {
      // A packet start was recognized but its declared end never arrived.
      this.reportError('truncated PS packet at end of stream');
    }
    this.buffer = new Uint8Array(0);
    this.cursor = 0;
    this.pendingStart = null;
    this.adtsCarry = new Uint8Array(0);
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.buffer = new Uint8Array(0);
    this.cursor = 0;
    this.pendingStart = null;
    this.packFormat = null;
    this.videoCodec.clear();
    this.videoState.clear();
    this.audioCodec.clear();
    this.hasVideoStream = false;
    this.hasAudioStream = false;
    this.videoMetaEmitted = false;
    this.audioMetaEmitted = false;
    this.audioConfigEmitted = false;
    this.adtsCarry = new Uint8Array(0);
    this.lastRawTicks = null;
    this.wrapOffsetTicks = 0;
    this.lastEmittedPtsUs = null;
    this.ptsOffsetUs = 0;
  }

  /** The pack-header format last observed ('mpeg2' | 'mpeg1' | null). */
  get mpegVersion(): 'mpeg1' | 'mpeg2' | null {
    return this.packFormat;
  }

  private parse(): void {
    for (;;) {
      const start = this.findNextStartCode();
      if (start === -1) {
        // No start code in the buffered bytes: keep only the trailing partial
        // prefix (up to 3 bytes) so a `00 00 01` split across pushes still
        // matches, then wait for more data.
        this.pendingStart = null;
        this.retainTail(3);
        return;
      }
      const id = this.buffer[start + 3] as number;
      switch (id) {
        case 0xba: {
          if (!this.parsePack(start)) return;
          break;
        }
        case 0xbb: // system header — skip by declared length
        case 0xbc: {
          // program_stream_map — skip by declared length
          if (this.buffer.length < start + 6) {
            this.resyncPast(start);
            break;
          }
          const length = ((this.buffer[start + 4] as number) << 8) | (this.buffer[start + 5] as number);
          if (this.buffer.length < start + 6 + length) {
            // Ignored structure with an incomplete declared body: resync
            // instead of waiting. A garbage start code can claim a length the
            // real stream never satisfies, which would stall the demuxer.
            this.resyncPast(start);
            break;
          }
          this.cursor = start + 6 + length;
          break;
        }
        case 0xb9: // program end code
          this.cursor = start + 4;
          break;
        default: {
          const isVideo = id >= PS_STREAM_ID.VIDEO_MIN && id <= PS_STREAM_ID.VIDEO_MAX;
          const isAudio = id >= PS_STREAM_ID.AUDIO_MIN && id <= PS_STREAM_ID.AUDIO_MAX;
          if (isVideo || isAudio) {
            if (!this.parsePes(start)) return;
          } else {
            // Unknown or private stream with a declared length: skip it when
            // complete, otherwise resync (never wait on ignored structures).
            if (this.buffer.length < start + 6) {
              this.resyncPast(start);
              break;
            }
            const length = ((this.buffer[start + 4] as number) << 8) | (this.buffer[start + 5] as number);
            if (this.buffer.length < start + 6 + length) {
              this.resyncPast(start);
              break;
            }
            this.cursor = start + 6 + length;
          }
          break;
        }
      }
    }
  }

  /** Scans the buffer for the next `00 00 01` start code at or after `cursor`. */
  private findNextStartCode(): number {
    const buf = this.buffer;
    for (let i = this.cursor; i + 4 <= buf.length; i++) {
      if ((buf[i] as number) === 0 && (buf[i + 1] as number) === 0 && (buf[i + 2] as number) === 1) {
        return i;
      }
    }
    return -1;
  }

  /** Keeps `tailLength` trailing bytes (a partial start-code prefix) and waits. */
  private retainTail(tailLength: number): void {
    const keep = Math.min(tailLength, this.buffer.length);
    this.buffer = this.buffer.subarray(this.buffer.length - keep);
    this.cursor = 0;
  }

  /** Keeps everything from `start` (a recognized packet start) and waits. */
  private retainFrom(start: number): void {
    this.buffer = this.buffer.subarray(start);
    this.cursor = 0;
    this.pendingStart = start;
  }

  /** Skips one byte past an incomplete ignored structure and keeps scanning. */
  private resyncPast(start: number): void {
    this.cursor = start + 1;
  }

  /**
   * Parses the pack header at `start`. MPEG-2 pack headers are a fixed 14
   * bytes plus 0..7 stuffing bytes (`pack_stuffing_length` in the low 3 bits
   * of byte 13); MPEG-1 pack headers are a fixed 12 bytes.
   */
  private parsePack(start: number): boolean {
    if (this.buffer.length < start + 12) {
      this.retainFrom(start);
      return false;
    }
    const b4 = this.buffer[start + 4] as number;
    if ((b4 & 0xc0) === 0x40) {
      // MPEG-2: '10' marker bits.
      if (this.buffer.length < start + 14) {
        this.retainFrom(start);
        return false;
      }
      const stuffing = (this.buffer[start + 13] as number) & 0x07;
      const end = start + 14 + stuffing;
      if (this.buffer.length < end) {
        this.retainFrom(start);
        return false;
      }
      this.packFormat = 'mpeg2';
      this.cursor = end;
      return true;
    }
    if ((b4 & 0xf0) === 0x20) {
      // MPEG-1: '0010' marker nibble.
      this.packFormat = 'mpeg1';
      this.cursor = start + 12;
      return true;
    }
    // A `00 00 01 BA` that is neither MPEG-1 nor MPEG-2: skip a byte and
    // keep scanning (the bytes may be media data that happened to contain
    // the sequence).
    this.reportError('invalid PS pack header marker bits');
    this.cursor = start + 1;
    return true;
  }

  private parsePes(start: number): boolean {
    if (this.buffer.length < start + 9) {
      this.retainFrom(start);
      return false;
    }
    const result = parsePesHeader(this.buffer.subarray(start), this.packFormat);
    if (!result.ok) {
      if (result.needMore) {
        this.retainFrom(start);
        return false;
      }
      // A self-inconsistent header (e.g. flags claiming a PTS that cannot fit
      // the declared header length): resync past the packet.
      this.reportError('malformed PES header');
      this.cursor = start + 1;
      return true;
    }
    const { pes } = result;
    if (pes.payloadLength < 0) {
      // Declared length inconsistent with the header (e.g. 0 for an MPEG-2
      // PES that claims a header). Resync past the packet.
      this.reportError('invalid PES packet length');
      this.cursor = start + 1;
      return true;
    }
    const end = start + pes.headerLength + pes.payloadLength;
    if (this.buffer.length < end) {
      this.retainFrom(start);
      return false;
    }
    const payload = this.buffer.subarray(start + pes.headerLength, end);
    const ptsUs =
      pes.ptsTicks !== undefined ? this.adjustedPtsUs((this.resolveWrapTicks(pes.ptsTicks) * 100) / 9) : undefined;
    const id = pes.streamId;
    if (id >= PS_STREAM_ID.VIDEO_MIN && id <= PS_STREAM_ID.VIDEO_MAX) {
      this.processVideo(id, payload, ptsUs);
    } else {
      this.processAudio(id, payload, ptsUs);
    }
    this.cursor = end;
    return true;
  }

  private processVideo(streamId: number, payload: Uint8Array, ptsUs: number | undefined): void {
    const nalus = splitAnnexBNalus(payload).filter((nalu) => nalu.length > 0 && (nalu[0] as number) !== 0xff);
    if (nalus.length === 0) return;

    let codec = this.videoCodec.get(streamId);
    if (codec === undefined) {
      codec = detectVideoCodec(nalus) ?? 'h264';
      this.videoCodec.set(streamId, codec);
      this.hasVideoStream = true;
      if (!this.videoMetaEmitted) {
        this.videoMetaEmitted = true;
        this.emit({
          type: 'metadata',
          metadata: { hasVideo: true, hasAudio: this.hasAudioStream, codec },
        });
      }
    }

    let state = this.videoState.get(streamId);
    if (state === undefined) {
      state = { sps: null, pps: null, vps: null, seqEmitted: false };
      this.videoState.set(streamId, state);
    }
    for (const nalu of nalus) {
      if (codec === 'hevc') {
        const type = ((nalu[0] as number) >> 1) & 0x3f;
        if (type === 32) state.vps = nalu.slice();
        else if (type === 33) state.sps = nalu.slice();
        else if (type === 34) state.pps = nalu.slice();
      } else {
        const type = (nalu[0] as number) & 0x1f;
        if (type === 7) state.sps = nalu.slice();
        else if (type === 8) state.pps = nalu.slice();
      }
    }

    if (!state.seqEmitted) {
      try {
        if (codec === 'hevc') {
          if (state.vps !== null && state.sps !== null && state.pps !== null) {
            const description = buildHvcC({ vps: state.vps, sps: state.sps, pps: state.pps, lengthSizeMinusOne: 3 });
            state.seqEmitted = true;
            this.emit({ type: 'sequence-header', config: { codec: codecStringFromHvcC(description), description } });
          }
        } else if (state.sps !== null && state.pps !== null) {
          state.seqEmitted = true;
          this.emit({
            type: 'sequence-header',
            config: { codec: codecStringFromSps(state.sps), description: buildAvcC(state.sps, state.pps, 4) },
          });
        }
      } catch (error) {
        if (error instanceof MediaFormatError) {
          this.reportError(error.message);
        } else {
          throw error;
        }
      }
    }
    if (!state.seqEmitted) return;

    let hasVcl = false;
    let isKey = false;
    for (const nalu of nalus) {
      if (codec === 'hevc') {
        const type = ((nalu[0] as number) >> 1) & 0x3f;
        if (type <= 9 || (type >= 16 && type <= 31)) {
          hasVcl = true;
          if (type >= 16) isKey = true; // IRAP: BLA/IDR/CRA
        }
      } else {
        const type = (nalu[0] as number) & 0x1f;
        if (type >= 1 && type <= 5) {
          hasVcl = true;
          if (type === 5) isKey = true;
        }
      }
    }
    if (!hasVcl) return;

    // The avcC/hvcC description promises length-prefixed (AVCC) chunks, so
    // re-frame the Annex-B PES payload to match (same as TsDemuxer).
    this.emit({
      type: 'video',
      chunk: { type: isKey ? 'key' : 'delta', timestamp: this.adjustedPtsUs(ptsUs), data: rebuildAvcc(nalus) },
    });
  }

  private processAudio(streamId: number, payload: Uint8Array, ptsUs: number | undefined): void {
    let codec = this.audioCodec.get(streamId);
    if (codec === undefined) {
      codec = this.detectAudioCodec(payload);
      this.audioCodec.set(streamId, codec);
      this.hasAudioStream = true;
      if (!this.audioMetaEmitted) {
        this.audioMetaEmitted = true;
        this.emit({
          type: 'metadata',
          metadata: { hasVideo: this.hasVideoStream, hasAudio: true, codec },
        });
      }
    }
    const timestamp = this.adjustedPtsUs(ptsUs);

    if (codec === 'aac') {
      this.processAac(payload, timestamp);
      return;
    }
    // G.711 A/μ-law and G.726 need no decoder config: raw payload chunks.
    this.emit({ type: 'audio', chunk: { type: 'key', timestamp, data: payload.slice() } });
  }

  private processAac(payload: Uint8Array, timestamp: number): void {
    const next = new Uint8Array(this.adtsCarry.length + payload.length);
    next.set(this.adtsCarry, 0);
    next.set(payload, this.adtsCarry.length);
    this.adtsCarry = next;
    for (;;) {
      if (this.adtsCarry.length === 0) break;
      const header = parseAdtsHeader(this.adtsCarry);
      if (!header.isAdts || header.sampleRate === 0) {
        // Leading garbage: resync one byte at a time toward the next syncword.
        this.adtsCarry = this.adtsCarry.slice(1);
        continue;
      }
      if (this.adtsCarry.length < header.frameLength) break;
      let raw: Uint8Array;
      try {
        raw = stripAdts(this.adtsCarry);
      } catch (error) {
        if (error instanceof MediaFormatError) {
          this.adtsCarry = this.adtsCarry.slice(1);
          continue;
        }
        throw error;
      }
      this.adtsCarry = this.adtsCarry.slice(header.frameLength);
      if (!this.audioConfigEmitted) {
        this.audioConfigEmitted = true;
        this.emit({
          type: 'audio-config',
          config: adtsToConfig({
            profile: header.profile,
            sampleRateIndex: header.sampleRateIndex,
            sampleRate: header.sampleRate,
            channels: header.channels,
          }),
        });
      }
      this.emit({ type: 'audio', chunk: { type: 'key', timestamp, data: raw } });
    }
  }

  /** Sniffs AAC (ADTS syncword) — otherwise the configured/default codec. */
  private detectAudioCodec(payload: Uint8Array): PsAudioCodec {
    if (payload.length >= 2 && (payload[0] as number) === 0xff && ((payload[1] as number) & 0xf0) === 0xf0) {
      return 'aac';
    }
    return this.options.audioCodec ?? 'g711a';
  }

  /**
   * Resolves a raw 33-bit PTS against the wrap boundary: when the counter
   * rolls past 2^33 the raw value drops by nearly the whole modulus, which
   * must be unwrapped so output timestamps stay monotonic.
   */
  private resolveWrapTicks(rawTicks: number): number {
    const last = this.lastRawTicks;
    if (last !== null) {
      const delta = rawTicks - last;
      if (delta < -(PTS_MOD / 2)) this.wrapOffsetTicks += PTS_MOD;
      else if (delta > PTS_MOD / 2) this.wrapOffsetTicks -= PTS_MOD;
    }
    this.lastRawTicks = rawTicks;
    return rawTicks + this.wrapOffsetTicks;
  }

  /** Keeps emitted timestamps monotonic (PTS rollbacks get a discontinuity offset). */
  private adjustedPtsUs(ptsUs: number | undefined): number {
    const last = this.lastEmittedPtsUs;
    const pts = ptsUs ?? (last ?? -SYNTHETIC_FRAME_US) + SYNTHETIC_FRAME_US;
    if (last !== null && pts < last) {
      this.ptsOffsetUs += last - pts + SYNTHETIC_FRAME_US;
    }
    const out = pts + this.ptsOffsetUs;
    this.lastEmittedPtsUs = out;
    return out;
  }

  private reportError(message: string): void {
    this.emit({ type: 'error', error: { code: 'DEMUX', message } });
  }

  private emit(event: DemuxerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

import type { Demuxer, DemuxerEvent } from '@vigilkit/plugin-sdk';
import {
  buildAvcC,
  codecStringFromSps,
  isAnnexB,
  splitAnnexBNalus,
} from '@vigilkit/media-utils';
import { parseAdtsHeader } from './adts.js';
import { TsPacketizer, parsePacket } from './packet.js';
import { parsePesHeader } from './pes.js';
import { SectionAssembler, parsePat, parsePmt } from './psi.js';

const PAT_PID = 0;
const STREAM_VIDEO_H264 = 0x1b;
const STREAM_VIDEO_HEVC = 0x24;
const STREAM_AUDIO_AAC = 0x0f;
const SYNTHETIC_FRAME_US = 33333;

type Listener = (event: DemuxerEvent) => void;

/**
 * MPEG-TS demuxer (H.264/HEVC video + AAC audio). Emits the SDK
 * `DemuxerEvent` union: metadata / sequence-header / video / audio / error.
 * H.264 is delivered as AVCC length-prefixed chunks with an avcC `description`
 * (the WebCodecs 'avc' format). Audio is demuxed but not decoded.
 */
export class TsDemuxer implements Demuxer {
  private readonly listeners = new Set<Listener>();
  private readonly packetizer = new TsPacketizer();
  private readonly patAssembler = new SectionAssembler();
  private pmtAssembler: SectionAssembler | null = null;
  private pmtPid: number | null = null;
  private readonly streamTypeByPid = new Map<number, number>();
  private readonly pesBuffers = new Map<number, Uint8Array>();
  private adtsCarry = new Uint8Array(0);
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private hasSeqHeader = false;
  private audioMetaEmitted = false;
  private hasVideoStream = false;
  private hasAudioStream = false;
  private lastEmittedPtsUs: number | null = null;
  private ptsOffsetUs = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.packetizer.push(chunk, (packet) => this.processPacket(packet));
  }

  flush(): void {
    this.packetizer.flush();
    for (const [pid, buffer] of this.pesBuffers) {
      const streamType = this.streamTypeByPid.get(pid);
      if (buffer.length > 0 && streamType !== undefined) this.finalizePes(pid, buffer, streamType);
    }
    this.pesBuffers.clear();
    this.adtsCarry = new Uint8Array(0);
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.flush();
    this.pmtAssembler = null;
    this.pmtPid = null;
    this.streamTypeByPid.clear();
    this.sps = null;
    this.pps = null;
    this.hasSeqHeader = false;
    this.audioMetaEmitted = false;
    this.hasVideoStream = false;
    this.hasAudioStream = false;
    this.lastEmittedPtsUs = null;
    this.ptsOffsetUs = 0;
  }

  private processPacket(packet: Uint8Array): void {
    const parsed = parsePacket(packet);
    if (parsed === null || parsed.payload.length === 0) return;
    const { pid, payload, payloadUnitStart } = parsed;

    if (pid === PAT_PID) {
      const section = this.patAssembler.push(payload, payloadUnitStart);
      if (section !== null) {
        const entries = parsePat(section);
        const first = entries[0];
        if (first !== undefined) {
          this.pmtPid = first.pmtPid;
          this.pmtAssembler = new SectionAssembler();
        }
      }
      return;
    }
    if (this.pmtPid !== null && pid === this.pmtPid && this.pmtAssembler !== null) {
      const section = this.pmtAssembler.push(payload, payloadUnitStart);
      if (section !== null) this.handlePmt(section);
      return;
    }
    const streamType = this.streamTypeByPid.get(pid);
    if (streamType === undefined) return;
    this.feedPes(pid, payload, payloadUnitStart, streamType);
  }

  private handlePmt(section: Uint8Array): void {
    for (const entry of parsePmt(section)) {
      if (entry.streamType === STREAM_VIDEO_H264 || entry.streamType === STREAM_VIDEO_HEVC) {
        this.streamTypeByPid.set(entry.pid, entry.streamType);
        this.hasVideoStream = true;
      } else if (entry.streamType === STREAM_AUDIO_AAC) {
        this.streamTypeByPid.set(entry.pid, entry.streamType);
        this.hasAudioStream = true;
      }
    }
  }

  private feedPes(pid: number, payload: Uint8Array, payloadUnitStart: boolean, streamType: number): void {
    const prev = this.pesBuffers.get(pid);
    if (payloadUnitStart) {
      if (prev !== undefined && prev.length > 0) {
        this.finalizePes(pid, prev, streamType);
      }
      this.pesBuffers.set(pid, payload.slice());
      return;
    }
    const current = prev ?? new Uint8Array(0);
    const next = new Uint8Array(current.length + payload.length);
    next.set(current, 0);
    next.set(payload, current.length);
    this.pesBuffers.set(pid, next);
  }

  private finalizePes(pid: number, buffer: Uint8Array, streamType: number): void {
    const header = parsePesHeader(buffer);
    if (header === null) return;
    const esData = buffer.subarray(header.headerLength);
    if (esData.length === 0) return;
    if (streamType === STREAM_VIDEO_H264 || streamType === STREAM_VIDEO_HEVC) {
      this.processVideoPes(esData, header.ptsUs, streamType);
    } else if (streamType === STREAM_AUDIO_AAC) {
      this.processAudioPes(esData, header.ptsUs);
    }
    this.pesBuffers.delete(pid);
  }

  private processVideoPes(esData: Uint8Array, ptsUs: number | undefined, streamType: number): void {
    const nalus = splitNalus(esData);
    let hasVcl = false;
    let isKey = false;
    for (const nalu of nalus) {
      const type = (nalu[0] as number) & 0x1f;
      if (type === 7) this.sps = nalu.slice();
      else if (type === 8) this.pps = nalu.slice();
      else if (type >= 1 && type <= 5) {
        hasVcl = true;
        if (type === 5) isKey = true;
      }
    }
    if (!hasVcl) return;

    if (!this.hasSeqHeader) {
      if (streamType === STREAM_VIDEO_HEVC) {
        this.hasSeqHeader = true;
        this.emit({ type: 'sequence-header', config: { codec: 'hvc1' } });
      } else if (this.sps !== null && this.pps !== null) {
        this.hasSeqHeader = true;
        this.emit({
          type: 'sequence-header',
          config: {
            codec: codecStringFromSps(this.sps),
            description: buildAvcC(this.sps, this.pps, 4),
          },
        });
      }
    }
    if (!this.hasSeqHeader) return;

    const data = rebuildAvcc(nalus);
    this.emit({
      type: 'video',
      chunk: { type: isKey ? 'key' : 'delta', timestamp: this.adjustedPts(ptsUs), data },
    });
  }

  private processAudioPes(esData: Uint8Array, ptsUs: number | undefined): void {
    const next = new Uint8Array(this.adtsCarry.length + esData.length);
    next.set(this.adtsCarry, 0);
    next.set(esData, this.adtsCarry.length);
    this.adtsCarry = next;
    const timestamp = this.adjustedPts(ptsUs);
    for (;;) {
      if (this.adtsCarry.length === 0) break;
      const header = parseAdtsHeader(this.adtsCarry);
      if (!header.isAdts) {
        // Skip one byte of leading garbage and resync toward the next frame.
        this.adtsCarry = this.adtsCarry.slice(1);
        continue;
      }
      if (this.adtsCarry.length < header.frameLength) break;
      const raw = this.adtsCarry.slice(0, header.frameLength);
      this.adtsCarry = this.adtsCarry.slice(header.frameLength);
      if (!this.audioMetaEmitted) {
        this.audioMetaEmitted = true;
        this.emit({
          type: 'metadata',
          metadata: {
            hasAudio: true,
            hasVideo: this.hasVideoStream,
            sampleRate: header.sampleRate,
            channels: header.channels,
          },
        });
      }
      this.emit({ type: 'audio', chunk: { type: 'key', timestamp, data: raw } });
    }
  }

  /** Applies a PTS discontinuity offset so output timestamps stay monotonic. */
  private adjustedPts(rawPtsUs: number | undefined): number {
    const last = this.lastEmittedPtsUs;
    const ptsUs = rawPtsUs ?? (last ?? -SYNTHETIC_FRAME_US) + SYNTHETIC_FRAME_US;
    if (last !== null && ptsUs < last) {
      this.ptsOffsetUs += last - ptsUs + SYNTHETIC_FRAME_US;
    }
    const out = ptsUs + this.ptsOffsetUs;
    this.lastEmittedPtsUs = out;
    return out;
  }

  private emit(event: DemuxerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Splits ES data into NALUs whether Annex-B or 4-byte length prefixed. */
function splitNalus(data: Uint8Array): Uint8Array[] {
  const nalus = isAnnexB(data) ? splitAnnexBNalus(data) : splitByLengthPrefix(data);
  return nalus.filter((nalu) => nalu.length > 0 && (nalu[0] as number) !== 0xff);
}

function splitByLengthPrefix(data: Uint8Array): Uint8Array[] {
  if (data.length < 4) return [];
  const firstLength = readU32(data, 0);
  if (firstLength === 0 || firstLength > data.length - 4) return [];
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

/** Re-frames NALUs as AVCC (4-byte BE length prefix) — drops TS stuffing bytes. */
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

function readU32(data: Uint8Array, offset: number): number {
  return (
    ((((data[offset] as number) << 24) |
      ((data[offset + 1] as number) << 16) |
      ((data[offset + 2] as number) << 8) |
      (data[offset + 3] as number)) >>>
      0)
  );
}

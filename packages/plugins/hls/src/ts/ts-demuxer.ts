import type { Demuxer, DemuxerEvent } from '@vigilkit/plugin-sdk';
import { MediaFormatError, adtsToConfig, buildAvcC, buildHvcC, codecStringFromSps, parseHvcC, stripAdts } from '@vigilkit/media-utils';
import { parseAdtsHeader } from './adts.js';
import { rebuildAvcc, splitNalus } from './es.js';
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
 * Video is delivered as length-prefixed chunks with an avcC or hvcC
 * `description` (the WebCodecs 'avc'/'hvc1' format). Audio is demuxed but
 * not decoded.
 */
export class TsDemuxer implements Demuxer {
  private readonly listeners = new Set<Listener>();
  private readonly packetizer = new TsPacketizer({
    onError: (message) => this.failDemux(message),
  });
  private readonly patAssembler = new SectionAssembler();
  private pmtAssembler: SectionAssembler | null = null;
  private pmtPid: number | null = null;
  private readonly streamTypeByPid = new Map<number, number>();
  private readonly pesBuffers = new Map<number, Uint8Array>();
  private adtsCarry = new Uint8Array(0);
  // Parameter sets (shared; each PES re-scans its own codec's NALUs before
  // the sequence-header decision, so cross-codec clobbering is harmless).
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private vps: Uint8Array | null = null;
  private hasSeqHeader = false;
  private hasHevcSeqHeader = false;
  private audioConfigEmitted = false;
  private audioMetaEmitted = false;
  private hasVideoStream = false;
  private hasAudioStream = false;
  private failed = false;
  private lastEmittedPtsUs: number | null = null;
  private ptsOffsetUs = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.packetizer.push(chunk, (packet) => this.processPacket(packet));
  }

  flush(): void {
    this.packetizer.flush();
    if (this.failed) return;
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
    this.sps = this.pps = this.vps = null;
    this.hasSeqHeader = this.hasHevcSeqHeader = false;
    this.audioConfigEmitted = this.audioMetaEmitted = false;
    this.hasVideoStream = this.hasAudioStream = false;
    this.failed = false;
    this.lastEmittedPtsUs = null;
    this.ptsOffsetUs = 0;
  }

  private processPacket(packet: Uint8Array): void {
    if (this.failed) return;
    const parsed = parsePacket(packet);
    if (parsed === null || parsed.payload.length === 0) return;
    const { pid, payload, payloadUnitStart } = parsed;

    if (pid === PAT_PID) {
      const section = this.patAssembler.push(payload, payloadUnitStart);
      const first = section !== null ? parsePat(section)[0] : undefined;
      if (first !== undefined) {
        this.pmtPid = first.pmtPid;
        this.pmtAssembler = new SectionAssembler();
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
    let recognized = false;
    for (const entry of parsePmt(section)) {
      if (entry.streamType === STREAM_VIDEO_H264 || entry.streamType === STREAM_VIDEO_HEVC || entry.streamType === STREAM_AUDIO_AAC) {
        this.streamTypeByPid.set(entry.pid, entry.streamType);
        if (entry.streamType === STREAM_AUDIO_AAC) this.hasAudioStream = true;
        else this.hasVideoStream = true;
        recognized = true;
      }
    }
    if (recognized) {
      // Continuity checking applies only to the PES streams; PSI PIDs (PAT/
      // PMT) are retransmitted with muxer-specific cadence.
      this.packetizer.setTrackedPids(new Set(this.streamTypeByPid.keys()));
    } else {
      // A PMT with no recognizable stream (no H.264/HEVC/AAC) would otherwise
      // leave the demuxer emitting nothing forever — a silent black screen.
      // Surface it as a hard DEMUX failure and stop processing further packets.
      this.failDemux('no recognized streams in PMT');
    }
  }

  /** Marks the demuxer failed and emits a DEMUX error (at most once). */
  private failDemux(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.emit({ type: 'error', error: { code: 'DEMUX', message } });
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
    if (streamType !== STREAM_AUDIO_AAC) this.processVideoPes(esData, header.ptsUs, streamType);
    else this.processAudioPes(esData, header.ptsUs);
    this.pesBuffers.delete(pid);
  }

  private processVideoPes(esData: Uint8Array, ptsUs: number | undefined, streamType: number): void {
    const nalus = splitNalus(esData);
    let hasVcl = false;
    let isKey = false;
    for (const nalu of nalus) {
      if (streamType === STREAM_VIDEO_HEVC) {
        // HEVC NAL units carry a two-byte header; type = (b0 >> 1) & 0x3F.
        const type = ((nalu[0] as number) >> 1) & 0x3f;
        if (type === 32) this.vps = nalu.slice();
        else if (type === 33) this.sps = nalu.slice();
        else if (type === 34) this.pps = nalu.slice();
        else if (type <= 9 || (type >= 16 && type <= 31)) {
          hasVcl = true;
          if (type >= 16) isKey = true; // IRAP: BLA/IDR/CRA
        }
      } else {
        const type = (nalu[0] as number) & 0x1f;
        if (type === 7) this.sps = nalu.slice();
        else if (type === 8) this.pps = nalu.slice();
        else if (type >= 1 && type <= 5) {
          hasVcl = true;
          if (type === 5) isKey = true;
        }
      }
    }
    if (!hasVcl) return;

    try {
      if (streamType === STREAM_VIDEO_HEVC) {
        if (!this.hasHevcSeqHeader && this.vps !== null && this.sps !== null && this.pps !== null) {
          const description = buildHvcC({ vps: this.vps, sps: this.sps, pps: this.pps, lengthSizeMinusOne: 3 });
          this.hasHevcSeqHeader = true;
          this.emit({ type: 'sequence-header', config: { codec: parseHvcC(description).codec, description } });
        }
        if (!this.hasHevcSeqHeader) return;
      } else if (!this.hasSeqHeader) {
        if (this.sps === null || this.pps === null) return;
        this.hasSeqHeader = true;
        this.emit({
          type: 'sequence-header',
          config: { codec: codecStringFromSps(this.sps), description: buildAvcC(this.sps, this.pps, 4) },
        });
      }
    } catch (error) {
      // A parameter-set NALU can carry the right NAL type yet contain garbage
      // the config builders reject (e.g. an SPS shorter than 4 bytes, which
      // codecStringFromSps / parseHevcSps refuse). Surface it as a DEMUX error
      // event instead of leaking a synchronous throw out of push()/flush().
      if (error instanceof MediaFormatError) {
        this.failDemux(error.message);
        return;
      }
      throw error;
    }

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
      let payload: Uint8Array;
      try {
        payload = stripAdts(this.adtsCarry);
      } catch (error) {
        // stripAdts can reject a frame parseAdtsHeader accepted (a declared
        // frameLength at or below the header length). Skip one byte and
        // resync rather than leaking a format error out of push().
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
      // Chunks carry the stripped AAC payload (no ADTS header); the
      // audio-config event above provides the decoder configuration.
      this.emit({ type: 'audio', chunk: { type: 'key', timestamp, data: payload } });
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

import type { Demuxer, DemuxerEvent, StreamMetadata } from '@vigilkit/plugin-sdk';
import { parseAvcC } from './avc.js';
import { parseScriptData } from './amf0.js';
import { ByteReader } from './byte-reader.js';
import {
  AvcFrameType,
  AvcPacketType,
  HEADER_SIZE,
  PREV_TAG_SIZE,
  SoundFormat,
  TAG_HEADER_SIZE,
  TagType,
  VideoCodec,
} from './flv-types.js';

const FLV_MAGIC_0 = 0x46; // 'F'
const FLV_MAGIC_1 = 0x4c; // 'L'
const FLV_MAGIC_2 = 0x56; // 'V'
const EXT_TIMESTAMP_MARKER = 0xffffff;
const EXT_TIMESTAMP_SIZE = 4;

type Listener = (event: DemuxerEvent) => void;

/**
 * Incremental FLV demuxer (H.264/AAC) implementing the SDK `Demuxer` contract.
 * Bytes are buffered internally so a tag split across any number of `push()`
 * calls is emitted exactly once. Framing uses tag `dataSize` only; the
 * 4-byte `prevTagSize` after each tag is skipped without validating its value.
 */
export class FlvDemuxer implements Demuxer {
  private queue = new Uint8Array(0);
  private cursor = 0;
  private headerParsed = false;
  private flags = 0;
  private hasSeqHeader = false;
  private failed = false;
  private readonly listeners = new Set<Listener>();

  push(chunk: Uint8Array): void {
    if (this.failed || chunk.length === 0) {
      return;
    }
    // Copy so callers may reuse the chunk buffer.
    const rest = this.queue.subarray(this.cursor);
    const next = new Uint8Array(rest.length + chunk.length);
    next.set(rest, 0);
    next.set(chunk, rest.length);
    this.queue = next;
    this.cursor = 0;
    this.parse();
  }

  /** Emits any remaining complete tags and silently discards a partial tail. */
  flush(): void {
    if (this.failed) {
      return;
    }
    this.parse();
    this.queue = new Uint8Array(0);
    this.cursor = 0;
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resets all parsing state for reuse. */
  close(): void {
    this.queue = new Uint8Array(0);
    this.cursor = 0;
    this.headerParsed = false;
    this.flags = 0;
    this.hasSeqHeader = false;
    this.failed = false;
  }

  private parse(): void {
    if (this.failed) {
      return;
    }
    if (!this.headerParsed) {
      if (this.queue.length < HEADER_SIZE) {
        return;
      }
      if (!this.hasValidSignature()) {
        this.emitError('DEMUX_BAD_SIGNATURE', 'invalid FLV signature');
        this.failed = true;
        return;
      }
      this.flags = this.queue[4] as number;
      const dataOffset = readU32At(this.queue, 5);
      this.headerParsed = true;
      // The FLV header is followed by PreviousTagSize0 (4 bytes, always 0).
      this.cursor = dataOffset + PREV_TAG_SIZE;
      if (this.cursor > this.queue.length) {
        return;
      }
    }
    while (this.queue.length - this.cursor >= TAG_HEADER_SIZE) {
      if (!this.parseNextTag()) {
        return;
      }
    }
  }

  /** Parses one tag at `cursor`. Returns false when more bytes are needed. */
  private parseNextTag(): boolean {
    const q = this.queue;
    const start = this.cursor;
    const tagType = q[start] as number;
    const dataSize = readU24At(q, start + 1);
    const tsLower = readU24At(q, start + 4);
    let timestampMs = (q[start + 7] as number) * 0x1000000 + tsLower;
    let contentOffset = 0;
    if (tsLower === EXT_TIMESTAMP_MARKER) {
      // Extended timestamps live in the first 4 bytes of the tag payload.
      if (q.length - start < TAG_HEADER_SIZE + EXT_TIMESTAMP_SIZE) {
        return false;
      }
      const ext = new ByteReader(q.subarray(start + TAG_HEADER_SIZE));
      timestampMs = ext.readU32();
      contentOffset = EXT_TIMESTAMP_SIZE;
    }
    const tagEnd = start + TAG_HEADER_SIZE + dataSize;
    if (q.length < tagEnd + PREV_TAG_SIZE) {
      return false;
    }
    const tagData = q.subarray(start + TAG_HEADER_SIZE + contentOffset, tagEnd);
    this.cursor = tagEnd + PREV_TAG_SIZE;
    this.processTag(tagType, tagData, timestampMs);
    return true;
  }

  private processTag(tagType: number, data: Uint8Array, timestampMs: number): void {
    if (tagType === TagType.SCRIPT) {
      this.processScript(data);
    } else if (tagType === TagType.VIDEO) {
      this.processVideo(data, timestampMs);
    } else if (tagType === TagType.AUDIO) {
      this.processAudio(data, timestampMs);
    }
  }

  private processScript(data: Uint8Array): void {
    const meta = parseScriptData(data);
    const metadata: StreamMetadata = {
      hasAudio: (this.flags & 4) !== 0,
      hasVideo: (this.flags & 1) !== 0,
    };
    if (typeof meta.width === 'number') {
      metadata.width = meta.width;
    }
    if (typeof meta.height === 'number') {
      metadata.height = meta.height;
    }
    if (typeof meta.framerate === 'number') {
      metadata.framerate = meta.framerate;
    }
    if (typeof meta.duration === 'number') {
      metadata.duration = meta.duration;
    }
    this.emit({ type: 'metadata', metadata });
  }

  private processVideo(data: Uint8Array, timestampMs: number): void {
    if (data.length < 5) {
      return;
    }
    const frameType = (data[0] as number) >> 4;
    const codecId = (data[0] as number) & 0x0f;
    if (codecId !== VideoCodec.AVC) {
      return;
    }
    const packetType = data[1] as number;
    if (packetType === AvcPacketType.SEQ) {
      this.hasSeqHeader = true;
      this.emit({ type: 'sequence-header', config: parseAvcC(data.subarray(5)) });
      return;
    }
    if (packetType === AvcPacketType.NALU) {
      if (!this.hasSeqHeader) {
        this.emitError(
          'DEMUX_MISSING_SEQUENCE_HEADER',
          'received AVC NALU before the sequence header',
        );
        return;
      }
      this.emit({
        type: 'video',
        chunk: {
          type: frameType === AvcFrameType.KEY ? 'key' : 'delta',
          timestamp: timestampMs * 1000,
          // The sequence header config carries the avcC `description`, which
          // tells WebCodecs to expect avc format (4-byte big-endian
          // length-prefixed NALUs), so pass the raw length-prefixed payload
          // through unchanged — never Annex-B converted.
          data: data.subarray(5),
        },
      });
    }
  }

  private processAudio(data: Uint8Array, timestampMs: number): void {
    if (data.length < 2) {
      return;
    }
    const soundFormat = (data[0] as number) >> 4;
    if (soundFormat !== SoundFormat.AAC) {
      return;
    }
    // v0.1: AAC is demuxed but not decoded — emit both seq headers and raw
    // packets as 'audio' events.
    this.emit({
      type: 'audio',
      chunk: { type: 'key', timestamp: timestampMs * 1000, data: data.subarray(2) },
    });
  }

  private hasValidSignature(): boolean {
    return (
      this.queue[0] === FLV_MAGIC_0 &&
      this.queue[1] === FLV_MAGIC_1 &&
      this.queue[2] === FLV_MAGIC_2
    );
  }

  private emitError(
    code: 'DEMUX' | 'DEMUX_BAD_SIGNATURE' | 'DEMUX_MISSING_SEQUENCE_HEADER',
    message: string,
  ): void {
    this.emit({ type: 'error', error: { code, message } });
  }

  private emit(event: DemuxerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function readU24At(data: Uint8Array, offset: number): number {
  return (
    (data[offset] as number) * 65536 +
    (data[offset + 1] as number) * 256 +
    (data[offset + 2] as number)
  );
}

function readU32At(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] as number) * 16777216 +
      (data[offset + 1] as number) * 65536 +
      (data[offset + 2] as number) * 256 +
      (data[offset + 3] as number)) >>>
    0
  );
}

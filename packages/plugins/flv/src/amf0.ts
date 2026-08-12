import { ByteReader, MediaFormatError } from '@vigilkit/media-utils';
import { demuxError } from './errors.js';

/**
 * AMF0 parsing needs two primitives the shared media-utils ByteReader
 * deliberately omits: `readF64` (AMF0 numbers are big-endian doubles) and
 * `peekU8` (to recognize the optional end-of-object marker without consuming
 * it). They live here because only AMF0 uses them.
 */
class AmfReader extends ByteReader {
  private readonly buf: Uint8Array;

  constructor(data: Uint8Array) {
    super(data);
    this.buf = data;
  }

  readF64(): number {
    const bytes = this.readBytes(8);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, false);
  }

  peekU8(offset = 0): number {
    return this.buf[this.position + offset] as number;
  }
}

const AMF_NUMBER = 0x00;
const AMF_BOOLEAN = 0x01;
const AMF_STRING = 0x02;
const AMF_NULL = 0x05;
const AMF_ECMA_ARRAY = 0x08;
const AMF_END_OF_OBJECT = 0x09;
const AMF_STRICT_ARRAY = 0x0a;
const ON_META_DATA = 'onMetaData';

/** Sentinel returned when a value uses a marker we do not handle. */
const AMF_SKIP: unique symbol = Symbol('amf-skip');

function readUtf8(reader: AmfReader, length: number): string {
  return new TextDecoder().decode(reader.readBytes(length));
}

/**
 * Some muxers terminate arrays with `00 00 09`; ffmpeg omits it. We consume
 * the marker only when it is exactly present so the next sibling stays aligned.
 */
function skipEndMarker(reader: AmfReader): void {
  if (
    reader.remaining >= 3 &&
    reader.peekU8(0) === 0x00 &&
    reader.peekU8(1) === 0x00 &&
    reader.peekU8(2) === AMF_END_OF_OBJECT
  ) {
    reader.skip(3);
  }
}

function readAmfValue(reader: AmfReader): unknown {
  if (reader.eof()) {
    return AMF_SKIP;
  }
  const marker = reader.readU8();
  switch (marker) {
    case AMF_NUMBER:
      return reader.readF64();
    case AMF_BOOLEAN:
      return reader.readU8() !== 0;
    case AMF_STRING: {
      const length = reader.readU16();
      return readUtf8(reader, length);
    }
    case AMF_NULL:
      return null;
    case AMF_ECMA_ARRAY: {
      const count = reader.readU32();
      const result: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        if (reader.eof()) {
          break;
        }
        const nameLength = reader.readU16();
        const name = readUtf8(reader, nameLength);
        const value = readAmfValue(reader);
        if (value === AMF_SKIP) {
          break;
        }
        result[name] = value;
      }
      skipEndMarker(reader);
      return result;
    }
    case AMF_STRICT_ARRAY: {
      const count = reader.readU32();
      const result: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const value = readAmfValue(reader);
        if (value === AMF_SKIP) {
          break;
        }
        result.push(value);
      }
      skipEndMarker(reader);
      return result;
    }
    default:
      // Unknown marker: skip the value gracefully. The ECMA loop breaks out of
      // the entry walk; we never throw for a data-level marker we cannot size.
      return AMF_SKIP;
  }
}

/**
 * Parses FLV script data: a leading `onMetaData` string followed by a value
 * (typically an ECMA array). Returns the metadata record, or `{}` when the
 * script is not `onMetaData`. Throws a `DemuxError` only when the script's own
 * header (the leading name string) is malformed.
 */
export function parseScriptData(data: Uint8Array): Record<string, unknown> {
  const reader = new AmfReader(data);
  try {
    const name = readAmfValue(reader);
    if (typeof name !== 'string') {
      throw demuxError('DEMUX', 'malformed script data: expected a name string');
    }
    if (name !== ON_META_DATA) {
      return {};
    }
    const value = readAmfValue(reader);
    if (value === AMF_SKIP || value === null || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    // The only object our parser can produce is the ECMA-array record above, so
    // this narrowing cast is sound; TS cannot express "plain record" otherwise.
    return value as Record<string, unknown>;
  } catch (error) {
    // media-utils ByteReader throws MediaFormatError on overruns; the FLV
    // package's public error type for malformed script data is DemuxError.
    if (error instanceof MediaFormatError) {
      throw demuxError('DEMUX', error.message);
    }
    throw error;
  }
}

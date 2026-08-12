import { demuxError } from './errors.js';

/**
 * Sequential big-endian reader over a `Uint8Array`.
 * Every read advances the internal position. Reading or skipping past the end
 * of the buffer throws a `DemuxError` with code 'DEMUX' rather than returning
 * a partial value — the caller uses `remaining`/`eof()` to avoid surprises.
 */
export class ByteReader {
  private readonly data: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** Current read offset. */
  get position(): number {
    return this.pos;
  }

  /** Number of unread bytes. */
  get remaining(): number {
    return this.data.length - this.pos;
  }

  /** True when every byte has been consumed. */
  eof(): boolean {
    return this.pos >= this.data.length;
  }

  readU8(): number {
    this.require(1);
    const value = this.data[this.pos] as number;
    this.pos += 1;
    return value;
  }

  readU16(): number {
    this.require(2);
    const value = (this.data[this.pos] as number) * 256 + (this.data[this.pos + 1] as number);
    this.pos += 2;
    return value;
  }

  readU24(): number {
    this.require(3);
    const value =
      (this.data[this.pos] as number) * 65536 +
      (this.data[this.pos + 1] as number) * 256 +
      (this.data[this.pos + 2] as number);
    this.pos += 3;
    return value;
  }

  readU32(): number {
    this.require(4);
    const value =
      ((this.data[this.pos] as number) * 16777216 +
        (this.data[this.pos + 1] as number) * 65536 +
        (this.data[this.pos + 2] as number) * 256 +
        (this.data[this.pos + 3] as number)) >>>
      0;
    this.pos += 4;
    return value;
  }

  /** Reads a big-endian IEEE-754 double (AMF0 number). */
  readF64(): number {
    this.require(8);
    const view = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i++) {
      view.setUint8(i, this.data[this.pos + i] as number);
    }
    this.pos += 8;
    return view.getFloat64(0, false);
  }

  /** Returns `length` raw bytes as a view into the underlying buffer and advances. */
  readBytes(length: number): Uint8Array {
    this.require(length);
    const bytes = this.data.subarray(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }

  /** Returns the byte at `offset` ahead of the current position without advancing. */
  peekU8(offset = 0): number {
    this.require(offset + 1);
    return this.data[this.pos + offset] as number;
  }

  /** Advances `length` bytes. */
  skip(length: number): void {
    this.require(length);
    this.pos += length;
  }

  private require(length: number): void {
    if (this.pos + length > this.data.length) {
      throw demuxError(
        'DEMUX',
        `out of bounds: need ${length} bytes at ${this.pos}, have ${this.data.length}`,
      );
    }
  }
}

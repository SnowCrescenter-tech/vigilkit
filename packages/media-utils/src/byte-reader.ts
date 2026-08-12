import { formatError } from './errors.js';

/**
 * Sequential big-endian reader over a `Uint8Array`.
 * Every read advances the internal position. Reading or skipping past the end
 * of the buffer throws a `MediaFormatError` rather than returning a partial
 * value — callers use `remaining`/`eof()` to avoid surprises.
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

  /**
   * Returns `length` raw bytes as a fresh copy and advances the position.
   * Callers own the returned buffer.
   */
  readBytes(length: number): Uint8Array {
    this.require(length);
    const bytes = this.data.slice(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }

  /** Advances `length` bytes without reading them. */
  skip(length: number): void {
    this.require(length);
    this.pos += length;
  }

  private require(length: number): void {
    if (this.pos + length > this.data.length) {
      throw formatError(
        `out of bounds: need ${length} bytes at ${this.pos}, have ${this.data.length}`,
      );
    }
  }
}

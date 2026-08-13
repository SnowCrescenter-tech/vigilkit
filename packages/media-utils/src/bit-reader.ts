import { formatError } from './errors.js';

/**
 * MSB-first bit reader over a `Uint8Array`.
 *
 * Bits are consumed from the most significant bit of each byte towards the
 * least significant. `readBits(n)` returns an unsigned integer; `readUe` and
 * `readSe` implement the unsigned/signed Exp-Golomb codes shared by H.264 and
 * HEVC. Reading past the end of the buffer throws a `MediaFormatError`.
 */
export class BitReader {
  private readonly data: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** Current bit offset. */
  get bitPosition(): number {
    return this.pos;
  }

  /** True once every bit of the buffer has been consumed. */
  eof(): boolean {
    return this.pos >= this.data.length * 8;
  }

  /**
   * Reads the next `n` bits (0..32) MSB-first as an unsigned integer.
   * Throws a `MediaFormatError` when fewer than `n` bits remain.
   */
  readBits(n: number): number {
    if (n < 0) {
      throw formatError(`bit overrun: negative length ${n}`);
    }
    if (this.pos + n > this.data.length * 8) {
      throw formatError(
        `bit overrun: need ${n} bits at ${this.pos}, have ${this.data.length * 8}`,
      );
    }
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3] as number;
      value = (value << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos += 1;
    }
    return value >>> 0;
  }

  /** Reads a single bit as a boolean. */
  readFlag(): boolean {
    return this.readBits(1) === 1;
  }

  /**
   * Reads an unsigned Exp-Golomb (ue(v)) code value.
   * Throws a `MediaFormatError` on overrun or an absurdly long code.
   */
  readUe(): number {
    let zeros = 0;
    while (this.readBits(1) === 0) {
      zeros += 1;
      if (zeros > 30) {
        throw formatError('exp-Golomb code too long');
      }
    }
    const suffix = zeros > 0 ? this.readBits(zeros) : 0;
    return (1 << zeros) - 1 + suffix;
  }

  /**
   * Reads a signed Exp-Golomb (se(v)) code value.
   * Maps codeNum 0,1,2,3,4,... to 0,1,-1,2,-2,...
   */
  readSe(): number {
    const codeNum = this.readUe();
    if (codeNum === 0) return 0;
    return codeNum & 1 ? (codeNum + 1) / 2 : -(codeNum / 2);
  }

  /** Advances to the next byte boundary (no-op when already aligned). */
  alignToByte(): void {
    this.pos = (this.pos + 7) & ~7;
  }
}

/**
 * Pure-TypeScript MD5 (RFC 1321).
 *
 * Zero third-party dependencies. `crypto.subtle` deliberately does not expose
 * MD5 (insecure for TLS), but digest authentication (RFC 7616) is specified in
 * terms of MD5, so this plugin ships a small, well-tested implementation. It is
 * the only crypto primitive in the package.
 *
 * Reference: https://www.rfc-editor.org/rfc/rfc1321
 */

const SHIFTS = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

// K[i] = floor(abs(sin(i + 1)) * 2^32) for i in 0..63 (RFC 1321 §3.4).
const CONSTANTS = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  CONSTANTS[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

/** Checked table lookup (noUncheckedIndexedAccess-safe). */
function tableValue(table: Uint8Array | Uint32Array, index: number): number {
  const value = table[index];
  if (value === undefined) {
    throw new Error(`md5: constant table index ${index} out of range`);
  }
  return value;
}

function rotateLeft(x: number, shift: number): number {
  return ((x << shift) | (x >>> (32 - shift))) | 0;
}

/** Pads the message per RFC 1321 §3.2 (append 0x80, zeros, 64-bit bit length). */
function padMessage(input: Uint8Array): Uint8Array {
  const length = input.length;
  const paddedLength = (Math.floor((length + 8) / 64) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input, 0);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = length * 8; // exact up to 2^53 in a JS number
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);
  return padded;
}

/**
 * Computes the MD5 digest of the input as a lowercase hex string.
 * Strings are encoded as UTF-8 (matching how digest auth hashes credentials).
 */
export function md5(input: string | Uint8Array): string {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const padded = padMessage(data);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const block = new DataView(padded.buffer, padded.byteOffset + offset, 64);
    const words = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      words[j] = block.getUint32(j * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      b = (b + rotateLeft((a + f + tableValue(CONSTANTS, i) + tableValue(words, g)) | 0, tableValue(SHIFTS, i))) | 0;
      a = temp;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, a0, true);
  view.setUint32(4, b0, true);
  view.setUint32(8, c0, true);
  view.setUint32(12, d0, true);

  let hex = '';
  for (const byte of out) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

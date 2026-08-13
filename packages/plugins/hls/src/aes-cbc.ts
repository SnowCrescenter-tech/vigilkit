/**
 * AES-128-CBC whole-segment decryption for HLS (RFC 8216 §5.2/§5.3.7), built
 * on the Web Crypto API (`globalThis.crypto.subtle` — available in browsers
 * and Node 22) with zero dependencies. Any failure is a `HlsError` so the
 * source can surface it as a DEMUX error (teardown).
 */
import { hlsError } from './errors.js';

const IV_PATTERN = /^0x[0-9a-fA-F]{32}$/;

/**
 * A byte buffer backed by a plain `ArrayBuffer` — what the Web Crypto
 * `BufferSource` parameter accepts (a shared-buffer `Uint8Array` would not).
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Parses a `0x`-prefixed 32-hex-digit `#EXT-X-KEY` IV attribute into 16
 * bytes. A length other than 128 bits is rejected per RFC 8216 §5.2.
 */
export function parseIv(text: string): Bytes {
  if (!IV_PATTERN.test(text)) {
    throw hlsError('DEMUX', `invalid AES-128 IV ${text} (must be 0x + 32 hex digits)`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(text.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return out;
}

/**
 * The default IV for a segment with no explicit `IV` attribute: its media
 * sequence number as a 128-bit big-endian integer (RFC 8216 §5.2).
 */
export function sequenceNumberToIv(sequenceNumber: number): Bytes {
  const out = new Uint8Array(16);
  let remaining = sequenceNumber;
  for (let i = 15; i >= 0; i--) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/**
 * Imports raw key bytes as a non-extractable AES-CBC decrypt key. Web Crypto
 * rejects anything but a 16/24/32-byte raw key, which becomes a DEMUX error
 * naming the offending key URL.
 */
export async function importAesKey(subtle: SubtleCrypto, keyUrl: string, keyBytes: Bytes): Promise<CryptoKey> {
  try {
    return await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  } catch {
    throw hlsError('DEMUX', `cannot import AES-128 key from ${keyUrl} (must be a raw 16/24/32-byte key)`);
  }
}

/**
 * Decrypts one segment. A failure (wrong key, corrupt ciphertext, padding
 * error) surfaces as a DEMUX error naming the segment.
 */
export async function decryptSegment(
  subtle: SubtleCrypto,
  cryptoKey: CryptoKey,
  iv: Bytes,
  ciphertext: Bytes,
  label: string,
): Promise<Bytes> {
  try {
    const plaintext = await subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, ciphertext);
    return new Uint8Array(plaintext);
  } catch {
    throw hlsError('DEMUX', `AES-128 decrypt failed for ${label}`);
  }
}

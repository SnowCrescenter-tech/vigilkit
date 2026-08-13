import { describe, expect, it } from 'vitest';
import type { Bytes } from './aes-cbc.js';
import { decryptSegment, importAesKey, parseIv, sequenceNumberToIv } from './aes-cbc.js';

const subtle = globalThis.crypto.subtle;

describe('parseIv', () => {
  it('parses a 0x-prefixed 32-hex-digit IV into 16 bytes', () => {
    const iv = parseIv('0x0102030405060708090a0b0c0d0e0f10');
    expect([...iv]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('rejects a non-128-bit or non-hex IV', () => {
    expect(() => parseIv('0x1234')).toThrow();
    expect(() => parseIv('nothex')).toThrow();
  });
});

describe('sequenceNumberToIv', () => {
  it('encodes the media sequence as a 128-bit big-endian integer', () => {
    expect([...sequenceNumberToIv(0)]).toEqual(new Array(16).fill(0));
    expect([...sequenceNumberToIv(1)]).toEqual([...new Array(15).fill(0), 1]);
    // 0x123456789 → 11 zero bytes then 01 23 45 67 89.
    expect([...sequenceNumberToIv(0x123456789)]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x23, 0x45, 0x67, 0x89,
    ]);
  });
});

describe('importAesKey + decryptSegment', () => {
  const keyBytes = new Uint8Array([...Array(16).keys()]); // 0..15
  const iv = new Uint8Array(16);

  it('round-trips an AES-128-CBC encrypted segment to the original plaintext', async () => {
    const cryptoKey = await importAesKey(subtle, 'key.bin', keyBytes);
    const plaintext = new Uint8Array([0x47, 0x01, 0x02, 0x03, ...new Array(13).fill(0xab)]);
    const encrypted = await encryptWith(keyBytes, iv, plaintext);
    const decrypted = await decryptSegment(subtle, cryptoKey, iv, encrypted, 'seg-0.ts');
    expect(decrypted).toEqual(plaintext);
  });

  it('rejects a raw key that is not 16/24/32 bytes', async () => {
    await expect(importAesKey(subtle, 'key.bin', new Uint8Array(8))).rejects.toThrow();
  });

  it('fails to decrypt with a wrong key (padding check)', async () => {
    const wrong = await importAesKey(subtle, 'key.bin', keyBytes.slice().reverse());
    const block = new Uint8Array(16);
    for (let i = 0; i < block.length; i++) block[i] = i;
    const encrypted = await encryptWith(keyBytes, iv, block);
    await expect(decryptSegment(subtle, wrong, iv, encrypted, 'seg-0.ts')).rejects.toThrow();
  });
});

/** Encrypts with an encrypt-capable key (decrypt-only keys cannot encrypt). */
async function encryptWith(keyBytes: Bytes, iv: Bytes, plaintext: Bytes): Promise<Bytes> {
  const encryptKey = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, encryptKey, plaintext));
}

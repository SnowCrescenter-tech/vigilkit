import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5 } from './md5.js';

const RFC_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
];

describe('md5 (RFC 1321)', () => {
  it('matches the RFC 1321 test suite', () => {
    for (const [input, expected] of RFC_VECTORS) {
      expect(md5(input)).toBe(expected);
    }
  });

  it('accepts raw bytes and matches the string form', () => {
    expect(md5(new TextEncoder().encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('cross-checks against the platform MD5 for boundary and multi-byte inputs', () => {
    const inputs = ['', 'a', 'ab', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(1000), '海康威视 test 123'];
    for (const input of inputs) {
      const expected = createHash('md5').update(input, 'utf8').digest('hex');
      expect(md5(input)).toBe(expected);
    }
  });
});

/**
 * Unit tests for the GB/T 28181 SIP digest helper (RFC 7616 adapted to the
 * SIP Authorization header). Expected hashes are independent fixtures
 * computed with node:crypto against the same inputs.
 */
import { describe, expect, it } from 'vitest';
import { generateSipAuthorization, parseDigestChallenge } from './digest.js';
import { md5 } from './md5.js';
import { SipError } from './sip.js';

const USERNAME = '34020000001320000001';
const PASSWORD = 'pass123';
const REALM = 'GB28181';
const NONCE = 'c0ffeecafe01';
const URI = 'sip:192.168.1.10:5060';
const METHOD = 'REGISTER';

describe('md5', () => {
  it('matches the RFC 1321 test vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('matches node:crypto for the digest inputs', () => {
    expect(md5(`${USERNAME}:${REALM}:${PASSWORD}`)).toBe('cdddb02e2943745b90713a712e9928de');
    expect(md5(`${METHOD}:${URI}`)).toBe('8e90304515c3a29d3cc238f8be6c0d44');
  });
});

describe('parseDigestChallenge', () => {
  it('parses a GB28181-style WWW-Authenticate challenge', () => {
    const header = 'Digest realm="GB28181", nonce="c0ffeecafe01", algorithm=MD5, qop="auth", stale="false"';
    const challenge = parseDigestChallenge(header);
    expect(challenge.realm).toBe(REALM);
    expect(challenge.nonce).toBe(NONCE);
    expect(challenge.algorithm).toBe('MD5');
    expect(challenge.qop).toBe('auth');
    expect(challenge.stale).toBe(false);
  });

  it('defaults algorithm to MD5 and tolerates missing qop', () => {
    const challenge = parseDigestChallenge('Digest realm="GB28181", nonce="abc"');
    expect(challenge.algorithm).toBe('MD5');
    expect(challenge.qop).toBeUndefined();
  });

  it('throws a typed SipError for a missing or malformed challenge', () => {
    expect(() => parseDigestChallenge(undefined)).toThrow(SipError);
    expect(() => parseDigestChallenge('Basic realm="x"')).toThrow(SipError);
    expect(() => parseDigestChallenge('Digest realm="only-realm"')).toThrow(SipError);
  });
});

describe('generateSipAuthorization', () => {
  it('produces the expected digest response with qop=auth', () => {
    const header = generateSipAuthorization(USERNAME, PASSWORD, METHOD, URI, {
      realm: REALM,
      nonce: NONCE,
      algorithm: 'MD5',
      qop: 'auth',
    }, { cnonce: 'a1b2c3d4e5f60708', nc: '00000001' });

    expect(header).toContain('Digest ');
    expect(header).toContain(`username="${USERNAME}"`);
    expect(header).toContain(`realm="${REALM}"`);
    expect(header).toContain(`nonce="${NONCE}"`);
    expect(header).toContain(`uri="${URI}"`);
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
    expect(header).toContain('cnonce="a1b2c3d4e5f60708"');
    // Independent fixture computed with node:crypto (see digest.test.ts docs).
    expect(header).toContain('response="e53085a4ba4992217b60fbe0c03d090b"');
  });

  it('computes the legacy no-qop response', () => {
    const header = generateSipAuthorization(USERNAME, PASSWORD, METHOD, URI, {
      realm: REALM,
      nonce: NONCE,
      algorithm: 'MD5',
    }, { cnonce: 'a1b2c3d4e5f60708', nc: '00000001' });
    expect(header).toContain('response="8a267cc44aa7df855985019d24064642"');
    expect(header).not.toContain('qop=');
  });

  it('includes opaque when the challenge carries one', () => {
    const header = generateSipAuthorization(USERNAME, PASSWORD, METHOD, URI, {
      realm: REALM,
      nonce: NONCE,
      algorithm: 'MD5',
      opaque: '5ccc069c403ebaf9f0171e9517f40e41',
    });
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('is deterministic for fixed cnonce/nc (round-trip equality)', () => {
    const opts = { cnonce: 'a1b2c3d4e5f60708', nc: '00000001' };
    const a = generateSipAuthorization(USERNAME, PASSWORD, METHOD, URI, { realm: REALM, nonce: NONCE, algorithm: 'MD5', qop: 'auth' }, opts);
    const b = generateSipAuthorization(USERNAME, PASSWORD, METHOD, URI, { realm: REALM, nonce: NONCE, algorithm: 'MD5', qop: 'auth' }, opts);
    expect(a).toBe(b);
  });
});

import { describe, expect, it } from 'vitest';
import { generateAuthorization, parseDigestChallenge } from './digest.js';

const CHALLENGE_HEADER =
  'Digest realm="IP Camera(C4606)", nonce="abc123def456", algorithm=MD5, qop="auth", opaque="opaque-token", stale=false';

describe('parseDigestChallenge', () => {
  it('parses all standard fields', () => {
    const c = parseDigestChallenge(CHALLENGE_HEADER);
    expect(c.realm).toBe('IP Camera(C4606)');
    expect(c.nonce).toBe('abc123def456');
    expect(c.algorithm).toBe('MD5');
    expect(c.qop).toBe('auth');
    expect(c.opaque).toBe('opaque-token');
    expect(c.stale).toBe(false);
  });

  it('defaults algorithm to MD5 when omitted', () => {
    const c = parseDigestChallenge('Digest realm="r", nonce="n"');
    expect(c.algorithm).toBe('MD5');
    expect(c.qop).toBeUndefined();
  });

  it('throws for a non-Digest header', () => {
    expect(() => parseDigestChallenge('Basic realm="r"')).toThrow(/Digest/);
  });

  it('throws when realm or nonce is missing', () => {
    expect(() => parseDigestChallenge('Digest realm="r"')).toThrow(/nonce/);
    expect(() => parseDigestChallenge('Digest nonce="n"')).toThrow(/realm/);
  });
});

describe('generateAuthorization', () => {
  it('produces a valid qop=auth header with deterministic cnonce', () => {
    const challenge = parseDigestChallenge(CHALLENGE_HEADER);
    const header = generateAuthorization('admin', '12345', 'GET', '/ISAPI/System/deviceInfo', challenge, {
      cnonce: '0a4f113b',
    });
    expect(header).toContain('Digest ');
    expect(header).toContain('username="admin"');
    expect(header).toContain('uri="/ISAPI/System/deviceInfo"');
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=');
    expect(header).toContain('cnonce="0a4f113b"');
    expect(header).toContain('response="');
  });

  it('computes the RFC 7616 reference response for qop=auth', () => {
    // Reference vector: username="Mufasa", realm="testrealm@host.com",
    // password="Circle Of Life", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093",
    // cnonce="0a4f113b", nc=00000001, qop=auth,
    // GET /dir/index.html
    const challenge = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    );
    const header = generateAuthorization('Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', challenge, {
      cnonce: '0a4f113b',
      nc: '00000001',
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
  });

  it('computes the no-qop reference response', () => {
    const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"');
    const header = generateAuthorization('Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', challenge, {
      cnonce: '0a4f113b',
    });
    expect(header).toContain('response="670fd8c2df070c60b045671b8b24ff02"');
  });

  it('supports qop=auth-int with an entity body', () => {
    const challenge = parseDigestChallenge('Digest realm="r", nonce="n", qop="auth-int"');
    const header = generateAuthorization('u', 'p', 'POST', '/x', challenge, { entityBody: 'hello', cnonce: 'c0' });
    expect(header).toContain('qop=auth-int');
  });
});

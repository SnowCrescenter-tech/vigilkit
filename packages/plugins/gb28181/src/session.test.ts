/**
 * Unit tests for the GB/T 28181 SIP session state machine: state transitions,
 * INVITE construction, 200-OK answer parsing and digest-auth retry.
 */
import { describe, expect, it } from 'vitest';
import { parseHeaderParams, parseSipMessage, serializeSipMessage, sipHeader } from './sip.js';
import { SipError } from './sip.js';
import { generateSipAuthorization } from './digest.js';
import { Gb28181Session } from './session.js';
import type { Gb28181SessionOptions } from './session.js';

const DEVICE_ID = '34020000001320000001';
const SERVER = '192.168.1.10:5060';
const LOCAL_IP = '192.168.1.20';
const PASSWORD = 'pass123';

function session(overrides: Partial<Gb28181SessionOptions> = {}): Gb28181Session {
  return new Gb28181Session({
    server: SERVER,
    deviceId: DEVICE_ID,
    username: DEVICE_ID,
    password: PASSWORD,
    localIp: LOCAL_IP,
    localPort: 5060,
    transport: 'udp',
    ssrc: 1000000001,
    now: () => new Date(1700000000000),
    ...overrides,
  });
}

const DIGEST_401 = [
  'SIP/2.0 401 Unauthorized',
  'Via: SIP/2.0/UDP 192.168.1.10:5060;branch=z9hG4bK0000',
  'From: <sip:34020000001320000001@192.168.1.10:5060>;tag=tag000000',
  'To: <sip:34020000001320000001@192.168.1.10:5060>;tag=platform0001',
  'Call-ID: x',
  'CSeq: 1 REGISTER',
  'WWW-Authenticate: Digest realm="GB28181", nonce="c0ffeecafe01", algorithm=MD5, qop="auth"',
  'Content-Length: 0',
  '',
].join('\r\n');

const REGISTER_200 = [
  'SIP/2.0 200 OK',
  'Via: SIP/2.0/UDP 192.168.1.20:5060',
  'CSeq: 2 REGISTER',
  'Content-Length: 0',
  '',
].join('\r\n');

/** REGISTER → 401 → retry with digest → 200 OK. */
function registerWithDigest(s: Gb28181Session): void {
  s.handleResponse(serializeSipMessage(s.register()));
  expect(s.challenge).toBeNull();
  s.handleResponse(DIGEST_401);
  expect(s.challenge).not.toBeNull();
  s.handleResponse(serializeSipMessage(s.register(s.challenge ?? undefined)));
  s.handleResponse(REGISTER_200);
  expect(s.isRegistered).toBe(true);
  expect(s.currentState).toBe('IDLE');
}

const INVITE_200_OK = [
  'SIP/2.0 200 OK',
  'Via: SIP/2.0/UDP 192.168.1.20:5060;branch=z9hG4bK0000',
  'From: <sip:34020000001320000001@192.168.1.10:5060>;tag=tag000000',
  'To: <sip:34020000001320000001@192.168.1.10:5060>;tag=platform0001',
  'Call-ID: x',
  'CSeq: 3 INVITE',
  'Content-Type: application/sdp',
  'y=0100000001',
  'Content-Length: 200',
  '',
  'v=0',
  'o=34020000001320000001 0 0 IN IP4 192.168.1.10',
  's=Play',
  'c=IN IP4 192.168.1.10',
  't=0 0',
  'm=video 6100 RTP/AVP 96',
  'a=rtpmap:96 PS/90000',
  'a=sendonly',
  '',
].join('\r\n');

describe('Gb28181Session state machine', () => {
  it('walks IDLE → REGISTERING → IDLE(registered) → INVITING → PLAYING → STOPPING → TERMINATED', () => {
    const s = session();
    expect(s.currentState).toBe('IDLE');
    const register = s.register();
    expect(s.currentState).toBe('REGISTERING');
    expect(serializeSipMessage(register)).toContain('REGISTER sip:192.168.1.10:5060 SIP/2.0');
    s.handleResponse(
      ['SIP/2.0 200 OK', 'Via: SIP/2.0/UDP 192.168.1.20:5060', 'CSeq: 1 REGISTER', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    expect(s.currentState).toBe('IDLE');
    expect(s.isRegistered).toBe(true);

    const invite = s.invite();
    expect(s.currentState).toBe('INVITING');
    s.handleResponse(INVITE_200_OK);
    expect(s.currentState).toBe('PLAYING');
    void invite;
    expect(s.mediaInfo).toMatchObject({
      ip: '192.168.1.10',
      port: 6100,
      // The answer's y= header ('0100000001') is decimal 100000001.
      ssrc: 100000001,
      payloadTypes: [96],
      rtpmap: { 96: 'PS' },
    });

    const bye = s.bye();
    expect(s.currentState).toBe('STOPPING');
    expect(sipHeader(bye, 'CSeq')).toMatch(/BYE$/);
    s.handleResponse(
      ['SIP/2.0 200 OK', 'Via: SIP/2.0/UDP 192.168.1.20:5060', 'CSeq: 2 BYE', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    expect(s.currentState).toBe('TERMINATED');
  });

  it('recovers the SSRC from the answer y= header when the SDP has no a=ssrc', () => {
    const s = session();
    registerWithDigest(s);
    s.handleResponse(serializeSipMessage(s.invite()));
    const answer = INVITE_200_OK.replace('a=sendonly', '').replace('y=0100000001', 'y=0200000002');
    s.handleResponse(answer);
    expect(s.currentState).toBe('PLAYING');
    expect(s.mediaInfo?.ssrc).toBe(200000002);
  });

  it('transitions to ERROR on a 4xx INVITE response', () => {
    const s = session();
    registerWithDigest(s);
    s.handleResponse(serializeSipMessage(s.invite()));
    s.handleResponse(
      ['SIP/2.0 486 Busy Here', 'CSeq: 1 INVITE', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    expect(s.currentState).toBe('ERROR');
    expect(s.lastError).toBe('486 Busy Here');
    expect(s.mediaInfo).toBeNull();
  });

  it('rejects out-of-order transitions with a typed SipError', () => {
    expect(() => session().invite()).toThrow(SipError); // not registered
    const s2 = session();
    s2.handleResponse(serializeSipMessage(s2.register()));
    expect(() => s2.register()).toThrow(SipError); // already registering
    s2.handleResponse(
      ['SIP/2.0 200 OK', 'CSeq: 1 REGISTER', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    expect(s2.currentState).toBe('IDLE');
    expect(() => s2.bye()).toThrow(SipError); // not playing
  });

  it('terminates directly on terminate()', () => {
    const s = session();
    registerWithDigest(s);
    s.handleResponse(serializeSipMessage(s.invite()));
    s.handleResponse(INVITE_200_OK);
    s.terminate();
    expect(s.currentState).toBe('TERMINATED');
  });
});

describe('Gb28181Session message construction', () => {
  it('builds a REGISTER with the GB28181 identity headers', () => {
    const s = session();
    const message = s.register();
    expect(message.startLine).toEqual({ method: 'REGISTER', uri: 'sip:192.168.1.10:5060', version: 'SIP/2.0' });
    expect(sipHeader(message, 'Via')).toMatch(/^SIP\/2\.0\/UDP 192\.168\.1\.20:5060;branch=z9hG4bK[0-9a-f]+;rport$/);
    expect(sipHeader(message, 'From')).toContain(`sip:${DEVICE_ID}@192.168.1.10:5060`);
    expect(sipHeader(message, 'CSeq')).toBe('1 REGISTER');
    expect(sipHeader(message, 'Expires')).toBe('3600');
    expect(sipHeader(message, 'Authorization')).toBeUndefined(); // no challenge yet
    expect(sipHeader(message, 'Content-Length')).toBe('0');
  });

  it('adds the digest Authorization header when retrying with the challenge', () => {
    const s = session();
    s.handleResponse(serializeSipMessage(s.register()));
    s.handleResponse(DIGEST_401);
    const retry = s.register(s.challenge ?? undefined);
    const authorization = sipHeader(retry, 'Authorization') ?? '';
    expect(authorization).toContain('Digest ');
    expect(authorization).toContain('username="34020000001320000001"');
    expect(authorization).toContain('uri="sip:192.168.1.10:5060"');
    expect(authorization).toContain('qop=auth');
    expect(authorization).toContain('response="');
    // The session randomizes cnonce/nc, so recompute the whole header from
    // the exact cnonce/nc the session put on the wire and verify it matches
    // (digest.test.ts holds the independent fixtures).
    const params = new Map(parseHeaderParams(authorization).map((p) => [p.key, p.value]));
    const expected = generateSipAuthorization(DEVICE_ID, PASSWORD, 'REGISTER', 'sip:192.168.1.10:5060', s.challenge ?? { realm: 'GB28181', nonce: 'c0ffeecafe01', algorithm: 'MD5', qop: 'auth' }, {
      cnonce: params.get('cnonce') ?? '',
      nc: params.get('nc') ?? '',
    });
    expect(authorization).toBe(expected);
  });

  it('builds an INVITE with SDP offer, Content-Type and y= SSRC header', () => {
    const s = session();
    registerWithDigest(s);
    const message = s.invite();
    expect(message.startLine).toEqual({
      method: 'INVITE',
      uri: `sip:${DEVICE_ID}@192.168.1.10:5060`,
      version: 'SIP/2.0',
    });
    expect(sipHeader(message, 'Content-Type')).toBe('application/sdp');
    expect(sipHeader(message, 'y')).toBe('1000000001');
    expect(message.body).toContain('m=video 5060 RTP/AVP 96 98');
    expect(message.body).toContain('a=rtpmap:96 PS/90000');
    expect(message.body).toContain('a=ssrc:1000000001');
    // Content-Length matches the UTF-8 body length.
    expect(Number(sipHeader(message, 'Content-Length'))).toBe(new TextEncoder().encode(message.body).length);
    // The serialized INVITE parses back to the same message.
    expect(parseSipMessage(serializeSipMessage(message))).toEqual(message);
  });

  it('overrides the SSRC per invite() call', () => {
    const s = session();
    registerWithDigest(s);
    const message = s.invite(2000000002);
    expect(sipHeader(message, 'y')).toBe('2000000002');
  });

  it('builds a BYE with the dialog To tag from the 200 OK', () => {
    const s = session();
    registerWithDigest(s);
    s.handleResponse(serializeSipMessage(s.invite()));
    s.handleResponse(INVITE_200_OK);
    const bye = s.bye();
    expect(sipHeader(bye, 'To')).toContain(';tag=platform0001');
    expect(sipHeader(bye, 'CSeq')).toBe('1 BYE');
  });

  it('tolerates a 200 OK without an SDP answer (mediaInfo stays null)', () => {
    const s = session();
    registerWithDigest(s);
    s.handleResponse(serializeSipMessage(s.invite()));
    s.handleResponse(
      ['SIP/2.0 200 OK', 'CSeq: 1 INVITE', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    expect(s.currentState).toBe('PLAYING');
    expect(s.mediaInfo).toBeNull();
    expect(s.lastError).toContain('without an SDP answer');
  });

  it('ignores out-of-dialog messages', () => {
    const s = session();
    s.handleResponse(
      ['SIP/2.0 200 OK', 'CSeq: 99 NOTIFY', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    expect(s.currentState).toBe('IDLE');
  });

  it('handleResponse never throws on garbage', () => {
    const s = session();
    expect(() => s.handleResponse('not sip at all')).not.toThrow();
    expect(() => s.handleResponse('')).not.toThrow();
    expect(s.currentState).toBe('IDLE');
  });
});

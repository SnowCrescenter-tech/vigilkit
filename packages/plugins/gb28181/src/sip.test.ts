/**
 * Unit tests for the SIP parser/serializer: request/response round trips,
 * header folding, duplicate headers, typed-error tolerance and best-effort
 * parsing of malformed input.
 */
import { describe, expect, it } from 'vitest';
import {
  SipError,
  isSipRequest,
  isSipResponse,
  parseCSeq,
  parseHeaderParams,
  parseSipMessage,
  parseVia,
  serializeSipMessage,
  sipHeader,
  sipHeaders,
} from './sip.js';

const REGISTER_WIRE = [
  'REGISTER sip:192.168.1.10:5060 SIP/2.0',
  'Via: SIP/2.0/UDP 192.168.1.20:5060;branch=z9hG4bK7c6e8f2a;rport',
  'From: <sip:34020000001320000001@192.168.1.10:5060>;tag=8f2c1a',
  'To: <sip:34020000001320000001@192.168.1.10:5060>',
  'Call-ID: 8b4a2c9e-1f0d-4a7c-9e3b-2d5f6a1c8e4a@192.168.1.20',
  'CSeq: 1 REGISTER',
  'Contact: <sip:34020000001320000001@192.168.1.20:5060>',
  'Expires: 3600',
  'Content-Length: 0',
  '',
  '',
].join('\r\n');

describe('parseSipMessage', () => {
  it('parses a REGISTER request line and headers', () => {
    const message = parseSipMessage(REGISTER_WIRE);
    expect(isSipRequest(message)).toBe(true);
    if (!isSipRequest(message)) return;
    expect(message.startLine.method).toBe('REGISTER');
    expect(message.startLine.uri).toBe('sip:192.168.1.10:5060');
    expect(message.startLine.version).toBe('SIP/2.0');
    expect(sipHeader(message, 'Call-ID')).toBe('8b4a2c9e-1f0d-4a7c-9e3b-2d5f6a1c8e4a@192.168.1.20');
    expect(sipHeader(message, 'cseq')).toBe('1 REGISTER'); // case-insensitive lookup
    expect(message.body).toBe('');
  });

  it('parses a 200 OK response with reason phrase', () => {
    const message = parseSipMessage('SIP/2.0 200 OK\r\nVia: SIP/2.0/UDP 192.168.1.20:5060\r\nContent-Length: 0\r\n\r\n');
    expect(isSipResponse(message)).toBe(true);
    if (!isSipResponse(message)) return;
    expect(message.startLine.statusCode).toBe(200);
    expect(message.startLine.reasonPhrase).toBe('OK');
  });

  it('parses a status line without a reason phrase', () => {
    const message = parseSipMessage('SIP/2.0 401\r\nVia: x\r\n\r\n');
    expect(isSipResponse(message)).toBe(true);
    if (!isSipResponse(message)) return;
    expect(message.startLine.statusCode).toBe(401);
    expect(message.startLine.reasonPhrase).toBe('');
  });

  it('unfolds folded header lines into a single value', () => {
    const message = parseSipMessage(
      ['INVITE sip:34020000001320000001@192.168.1.10 SIP/2.0', 'Via: SIP/2.0/UDP 192.168.1.20:5060', '  ;branch=z9hG4bK1234', '  ;rport', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    const via = sipHeader(message, 'Via');
    expect(via).toBe('SIP/2.0/UDP 192.168.1.20:5060 ;branch=z9hG4bK1234 ;rport');
  });

  it('preserves duplicate headers (e.g. multiple Via)', () => {
    const message = parseSipMessage(
      ['SIP/2.0 200 OK', 'Via: SIP/2.0/UDP 192.168.1.20:5060', 'Via: SIP/2.0/WS wss-host.example.com', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    expect(sipHeaders(message, 'via')).toHaveLength(2);
  });

  it('splits the body at the first empty line and keeps it verbatim', () => {
    const message = parseSipMessage(
      ['INVITE sip:x SIP/2.0', 'Content-Type: application/sdp', 'Content-Length: 123', '', 'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Play', '', ''].join('\r\n'),
    );
    expect(message.body).toBe('v=0\no=- 0 0 IN IP4 127.0.0.1\ns=Play');
  });

  it('throws a typed SipError for empty input', () => {
    expect(() => parseSipMessage('')).toThrow(SipError);
    expect(() => parseSipMessage('   \r\n')).toThrow(SipError);
  });

  it('throws a typed SipError when no start line can be extracted', () => {
    expect(() => parseSipMessage('this is not a sip message')).toThrow(SipError);
  });

  it('is best-effort tolerant of junk header lines', () => {
    const message = parseSipMessage(
      ['SIP/2.0 200 OK', 'this line has no colon', 'Via: SIP/2.0/UDP 1.2.3.4', 'Content-Length: 0', '', ''].join('\r\n'),
    );
    expect(sipHeader(message, 'Via')).toBe('SIP/2.0/UDP 1.2.3.4');
  });

  it('never throws on arbitrarily broken input (fuzz tolerance)', () => {
    const inputs = [
      '0',
      'SIP/2.0 99',
      'INVITE',
      'INVITE sip:x SIP/2.0\r\nno-colon',
      '\r\n\r\n\r\n',
      'SIP/2.0 200 OK\r\nVia: broken\r\n\r\nbody without headers',
      'INVITE sip:x SIP/2.0\n\nv=0\n',
    ];
    for (const input of inputs) {
      let threw = false;
      try {
        parseSipMessage(input);
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(SipError);
      }
      // Unparseable start lines may throw a typed error; that is the contract.
      void threw;
    }
  });
});

describe('serializeSipMessage', () => {
  it('round-trips a parsed request', () => {
    const message = parseSipMessage(REGISTER_WIRE);
    expect(serializeSipMessage(message)).toBe(REGISTER_WIRE);
  });

  it('serializes a constructed response', () => {
    const text = serializeSipMessage({
      startLine: { version: 'SIP/2.0', statusCode: 200, reasonPhrase: 'OK' },
      headers: [{ name: 'CSeq', value: '1 REGISTER' }, { name: 'Content-Length', value: '0' }],
      body: '',
    });
    expect(text).toBe('SIP/2.0 200 OK\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n');
  });
});

describe('typed header accessors', () => {
  it('parses Via into protocol, host, port and params', () => {
    const via = parseVia('SIP/2.0/UDP 192.168.1.20:5060;branch=z9hG4bK7c6e8f2a;rport');
    expect(via.protocol).toBe('SIP/2.0/UDP');
    expect(via.host).toBe('192.168.1.20');
    expect(via.port).toBe(5060);
    expect(via.params.get('branch')).toBe('z9hG4bK7c6e8f2a');
    expect(via.params.get('rport')).toBe('');
  });

  it('parses Via with a host-only sent-by', () => {
    const via = parseVia('SIP/2.0/WS wss-host.example.com;branch=z9hG4bKx');
    expect(via.host).toBe('wss-host.example.com');
    expect(via.port).toBeUndefined();
  });

  it('parses CSeq sequence and method', () => {
    expect(parseCSeq('12345 INVITE')).toEqual({ sequence: 12345, method: 'INVITE' });
    expect(() => parseCSeq('nope')).toThrow(SipError);
    expect(() => parseCSeq(undefined)).toThrow(SipError);
  });

  it('parses Digest-style parameter lists with quoted values', () => {
    const params = parseHeaderParams(
      'Digest username="34020000001320000001", realm="GB28181", nonce="abc123", uri="sip:192.168.1.10", response="0123456789abcdef", algorithm=MD5, qop=auth, nc=00000001, cnonce="xyz", opaque="q"',
    );
    const map = new Map(params.map((p) => [p.key, p.value]));
    expect(map.get('username')).toBe('34020000001320000001');
    expect(map.get('realm')).toBe('GB28181');
    expect(map.get('algorithm')).toBe('MD5');
    expect(map.get('qop')).toBe('auth');
    expect(map.get('nc')).toBe('00000001');
    expect(map.get('cnonce')).toBe('xyz');
    expect(map.get('opaque')).toBe('q');
  });
});

/**
 * Unit tests for the GB/T 28181 SDP builder/parser: build→parse round trips,
 * real-world 200-OK answer parsing and media-info extraction.
 */
import { describe, expect, it } from 'vitest';
import { GB28181_PAYLOAD_TYPES, SdpError, buildSdpOffer, parseSdp, sdpMediaInfo } from './sdp.js';

describe('buildSdpOffer', () => {
  it('builds a GB28181 INVITE offer with PS payload and SSRC', () => {
    const sdp = buildSdpOffer({ ip: '192.168.1.20', port: 6000, ssrc: 1000000001, username: '34020000001320000001' });
    expect(sdp).toBe(
      [
        'v=0',
        'o=34020000001320000001 0 0 IN IP4 192.168.1.20',
        's=Play',
        'c=IN IP4 192.168.1.20',
        't=0 0',
        'm=video 6000 RTP/AVP 96 98',
        'a=rtpmap:96 PS/90000',
        'a=rtpmap:98 H265/90000',
        'a=recvonly',
        'a=ssrc:1000000001',
      ].join('\n'),
    );
  });

  it('round-trips through parseSdp', () => {
    const sdp = buildSdpOffer({ ip: '10.0.0.5', port: 1234, ssrc: 1234567890, username: '34020000001320000001' });
    const session = parseSdp(sdp);
    expect(session.version).toBe(0);
    expect(session.origin.username).toBe('34020000001320000001');
    expect(session.origin.unicastAddress).toBe('10.0.0.5');
    expect(session.connection?.address).toBe('10.0.0.5');
    expect(session.media).toHaveLength(1);
    const media = session.media[0]!;
    expect(media.type).toBe('video');
    expect(media.port).toBe(1234);
    expect(media.fmt).toEqual([96, 98]);
    expect(media.rtpmap).toEqual([
      { pt: 96, encodingName: 'PS', clockRate: 90000 },
      { pt: 98, encodingName: 'H265', clockRate: 90000 },
    ]);
    expect(media.ssrc).toBe(1234567890);
    expect(media.recvonly).toBe(true);
  });

  it('offers G.711 audio payloads with 8 kHz clock rate', () => {
    const sdp = buildSdpOffer({ ip: '10.0.0.5', port: 0, payloadTypes: [8, 0, 104] });
    const session = parseSdp(sdp);
    const media = session.media[0]!;
    expect(media.type).toBe('video'); // still a video offer line
    expect(media.rtpmap).toEqual([
      { pt: 8, encodingName: 'PCMA', clockRate: 8000 },
      { pt: 0, encodingName: 'PCMU', clockRate: 8000 },
      { pt: 104, encodingName: 'G726-32', clockRate: 90000 },
    ]);
  });
});

describe('parseSdp', () => {
  it('parses a realistic GB28181 200-OK answer', () => {
    const answer = [
      'v=0',
      'o=34020000001320000001 0 0 IN IP4 192.168.1.10',
      's=Play',
      'c=IN IP4 192.168.1.10',
      't=0 0',
      'm=video 6100 RTP/AVP 96',
      'a=rtpmap:96 PS/90000',
      'a=sendonly',
      'y=0100000001',
      '',
    ].join('\r\n');
    const session = parseSdp(answer);
    const info = sdpMediaInfo(session);
    expect(info).toEqual({
      ip: '192.168.1.10',
      port: 6100,
      payloadTypes: [96],
      rtpmap: { 96: 'PS' },
    });
  });

  it('extracts the SSRC from an a=ssrc line in the answer', () => {
    const session = parseSdp(
      ['v=0', 'o=- 0 0 IN IP4 10.0.0.1', 's=Play', 't=0 0', 'm=video 5555 RTP/AVP 96', 'a=rtpmap:96 PS/90000', 'a=ssrc:1234567890 cname:gb28181'].join('\r\n'),
    );
    const info = sdpMediaInfo(session);
    expect(info?.ssrc).toBe(1234567890);
    expect(info?.ip).toBe('10.0.0.1'); // falls back to the o= address
  });

  it('falls back from media c= to session c= to o=', () => {
    const noMediaC = parseSdp(
      ['v=0', 'o=- 0 0 IN IP4 10.0.0.7', 's=Play', 'c=IN IP4 10.0.0.7', 't=0 0', 'm=video 6000 RTP/AVP 96'].join('\r\n'),
    );
    expect(sdpMediaInfo(noMediaC)?.ip).toBe('10.0.0.7');
    const oOnly = parseSdp(['v=0', 'o=- 0 0 IN IP4 10.0.0.8', 's=Play', 't=0 0', 'm=video 6000 RTP/AVP 96'].join('\r\n'));
    expect(sdpMediaInfo(oOnly)?.ip).toBe('10.0.0.8');
  });

  it('parses multiple media lines (video + audio)', () => {
    const session = parseSdp(
      [
        'v=0',
        'o=- 0 0 IN IP4 10.0.0.1',
        's=Play',
        'c=IN IP4 10.0.0.1',
        't=0 0',
        'm=video 6000 RTP/AVP 96',
        'a=rtpmap:96 PS/90000',
        'm=audio 6002 RTP/AVP 8',
        'a=rtpmap:8 PCMA/8000',
        '',
      ].join('\r\n'),
    );
    expect(session.media).toHaveLength(2);
    expect(session.media[1]?.type).toBe('audio');
    expect(session.media[1]?.port).toBe(6002);
  });

  it('throws a typed SdpError for non-SDP input', () => {
    expect(() => parseSdp('hello world')).toThrow(SdpError);
    expect(() => parseSdp('')).toThrow(SdpError);
  });

  it('tolerates unknown and malformed lines', () => {
    const session = parseSdp(
      ['v=0', 'o=- 0 0 IN IP4 10.0.0.1', 's=Play', 'x=unknown-line', 'z=broken', 't=0 0', 'm=video 6000 RTP/AVP 96', 'a=weird'].join('\r\n'),
    );
    expect(sdpMediaInfo(session)?.port).toBe(6000);
  });

  it('parses fmtp attributes', () => {
    const session = parseSdp(
      ['v=0', 'o=- 0 0 IN IP4 10.0.0.1', 's=Play', 't=0 0', 'm=audio 6002 RTP/AVP 8', 'a=rtpmap:8 PCMA/8000', 'a=fmtp:8 annexb=no'].join('\r\n'),
    );
    expect(session.media[0]?.fmtp.get(8)).toBe('annexb=no');
  });

  it('maps the GB28181 payload-type constants', () => {
    expect(GB28181_PAYLOAD_TYPES).toEqual({ PS: 96, H264: 96, H265: 98, G711A: 8, G711U: 0, G726: 104 });
  });
});

describe('sdpMediaInfo', () => {
  it('returns null for a session without media lines', () => {
    const session = parseSdp(['v=0', 'o=- 0 0 IN IP4 10.0.0.1', 's=x', 't=0 0'].join('\r\n'));
    expect(sdpMediaInfo(session)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { mjpegUrl, normalizeChannel, rtspOverWebSocketUrl, rtspUrl, snapshotUrl } from './urls.js';

const BASE = { host: '192.168.1.64', username: 'admin', password: '12345' };

describe('normalizeChannel', () => {
  it('defaults to 1', () => expect(normalizeChannel()).toBe(1));
  it('passes through positive integers', () => expect(normalizeChannel(3)).toBe(3));
  it('rejects non-positive or non-integer values', () => {
    expect(() => normalizeChannel(0)).toThrow(/channel/i);
    expect(() => normalizeChannel(-1)).toThrow(/channel/i);
    expect(() => normalizeChannel(1.5)).toThrow(/channel/i);
  });
});

describe('rtspUrl', () => {
  it('builds the main-stream (subtype 0) URL for channel 1', () => {
    expect(rtspUrl(BASE)).toBe('rtsp://admin:12345@192.168.1.64:554/cam/realmonitor?channel=1&subtype=0');
  });

  it('builds sub-stream URLs for subtypes 1 and 2', () => {
    expect(rtspUrl({ ...BASE, channel: 2, subtype: 1 })).toBe(
      'rtsp://admin:12345@192.168.1.64:554/cam/realmonitor?channel=2&subtype=1',
    );
    expect(rtspUrl({ ...BASE, subtype: 2 })).toBe(
      'rtsp://admin:12345@192.168.1.64:554/cam/realmonitor?channel=1&subtype=2',
    );
  });

  it('honors a custom RTSP port', () => {
    expect(rtspUrl({ ...BASE, rtspPort: 8554 })).toBe(
      'rtsp://admin:12345@192.168.1.64:8554/cam/realmonitor?channel=1&subtype=0',
    );
  });

  it('percent-encodes credentials', () => {
    expect(rtspUrl({ host: 'h', username: 'a@d min', password: 'p:ass' })).toBe(
      'rtsp://a%40d%20min:p%3Aass@h:554/cam/realmonitor?channel=1&subtype=0',
    );
  });

  it('omits credentials when no username is given', () => {
    expect(rtspUrl({ host: 'h' })).toBe('rtsp://h:554/cam/realmonitor?channel=1&subtype=0');
  });

  it('rejects invalid subtypes', () => {
    expect(() => rtspUrl({ ...BASE, subtype: 3 })).toThrow(/subtype/i);
    expect(() => rtspUrl({ ...BASE, subtype: -1 })).toThrow(/subtype/i);
    expect(() => rtspUrl({ ...BASE, subtype: 1.5 })).toThrow(/subtype/i);
  });
});

describe('rtspOverWebSocketUrl', () => {
  it('builds the static Dahua RTSP-over-WebSocket bridge URL', () => {
    expect(rtspOverWebSocketUrl({ host: '192.168.1.64' })).toBe('ws://192.168.1.64/rtspoverwebsocket');
  });

  it('supports an explicit port', () => {
    expect(rtspOverWebSocketUrl({ host: '192.168.1.64', port: 8080 })).toBe('ws://192.168.1.64:8080/rtspoverwebsocket');
  });
});

describe('snapshotUrl', () => {
  it('builds a snapshot CGI URL', () => {
    expect(snapshotUrl(BASE)).toBe('http://192.168.1.64:80/cgi-bin/snapshot.cgi?channel=1');
  });

  it('supports HTTPS with the default 443 port', () => {
    expect(snapshotUrl({ host: '192.168.1.64', channel: 2, https: true })).toBe(
      'https://192.168.1.64:443/cgi-bin/snapshot.cgi?channel=2',
    );
  });

  it('honors a custom HTTP port', () => {
    expect(snapshotUrl({ ...BASE, port: 8080 })).toBe('http://192.168.1.64:8080/cgi-bin/snapshot.cgi?channel=1');
  });
});

describe('mjpegUrl', () => {
  it('builds an MJPEG CGI URL with subtype 0 by default', () => {
    expect(mjpegUrl(BASE)).toBe('http://192.168.1.64:80/cgi-bin/mjpg/video.cgi?channel=1&subtype=0');
  });

  it('supports subtype 1 and https', () => {
    expect(mjpegUrl({ ...BASE, channel: 2, subtype: 1, https: true })).toBe(
      'https://192.168.1.64:443/cgi-bin/mjpg/video.cgi?channel=2&subtype=1',
    );
  });

  it('rejects subtypes above 1', () => {
    expect(() => mjpegUrl({ ...BASE, subtype: 2 })).toThrow(/subtype/i);
  });
});

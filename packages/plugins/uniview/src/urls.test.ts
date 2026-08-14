import { describe, expect, it } from 'vitest';
import { mjpegUrl, normalizeChannel, rtspUrl, snapshotUrl } from './urls.js';

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

describe('rtspUrl (IPC form)', () => {
  it('builds the main-stream URL for channel 1', () => {
    expect(rtspUrl(BASE)).toBe('rtsp://admin:12345@192.168.1.64:554/media/video1');
  });

  it('maps sub and third streams to video2 / video3', () => {
    expect(rtspUrl({ ...BASE, stream: 'sub' })).toBe('rtsp://admin:12345@192.168.1.64:554/media/video2');
    expect(rtspUrl({ ...BASE, stream: 'third' })).toBe('rtsp://admin:12345@192.168.1.64:554/media/video3');
  });

  it('honors the channel and a custom RTSP port', () => {
    expect(rtspUrl({ ...BASE, channel: 2, rtspPort: 8554 })).toBe(
      'rtsp://admin:12345@192.168.1.64:8554/media/video1',
    );
  });

  it('percent-encodes credentials', () => {
    expect(rtspUrl({ host: 'h', username: 'a@d min', password: 'p:ass' })).toBe(
      'rtsp://a%40d%20min:p%3Aass@h:554/media/video1',
    );
  });

  it('omits credentials when no username is given', () => {
    expect(rtspUrl({ host: 'h' })).toBe('rtsp://h:554/media/video1');
  });

  it('rejects invalid stream values', () => {
    expect(() => rtspUrl({ ...BASE, stream: 'sideways' as never })).toThrow(/stream/i);
  });
});

describe('rtspUrl (NVR form)', () => {
  it('builds the unicast URL with s0 (main) by default', () => {
    expect(rtspUrl({ ...BASE, nvr: true })).toBe('rtsp://admin:12345@192.168.1.64:554/unicast/c1/s0/live');
    expect(rtspUrl({ ...BASE, nvr: true, channel: 2 })).toBe(
      'rtsp://admin:12345@192.168.1.64:554/unicast/c2/s0/live',
    );
  });

  it('maps the sub stream to s1', () => {
    expect(rtspUrl({ ...BASE, nvr: true, channel: 3, stream: 'sub' })).toBe(
      'rtsp://admin:12345@192.168.1.64:554/unicast/c3/s1/live',
    );
  });

  it("rejects the 'third' stream on NVRs (only s0/s1 exist)", () => {
    expect(() => rtspUrl({ ...BASE, nvr: true, stream: 'third' })).toThrow(/stream/i);
  });
});

describe('snapshotUrl', () => {
  it('builds the documented snapshot URL', () => {
    expect(snapshotUrl({ host: '192.168.1.64' })).toBe('http://192.168.1.64:80/images/snapshot.jpg');
  });

  it('supports HTTPS with the default 443 port', () => {
    expect(snapshotUrl({ host: '192.168.1.64', https: true })).toBe(
      'https://192.168.1.64:443/images/snapshot.jpg',
    );
  });

  it('honors a custom HTTP port', () => {
    expect(snapshotUrl({ host: '192.168.1.64', port: 8080 })).toBe(
      'http://192.168.1.64:8080/images/snapshot.jpg',
    );
  });
});

describe('mjpegUrl', () => {
  it('builds stream1 by default', () => {
    expect(mjpegUrl({ host: '192.168.1.64' })).toBe('http://192.168.1.64:80/video/mjpeg/stream1');
  });

  it('supports streams 2 and 3 plus https', () => {
    expect(mjpegUrl({ host: '192.168.1.64', stream: 2, https: true })).toBe(
      'https://192.168.1.64:443/video/mjpeg/stream2',
    );
    expect(mjpegUrl({ host: '192.168.1.64', stream: 3, port: 8080 })).toBe(
      'http://192.168.1.64:8080/video/mjpeg/stream3',
    );
  });

  it('rejects stream indices outside 1..3', () => {
    expect(() => mjpegUrl({ host: 'h', stream: 0 })).toThrow(/stream/i);
    expect(() => mjpegUrl({ host: 'h', stream: 4 })).toThrow(/stream/i);
    expect(() => mjpegUrl({ host: 'h', stream: 1.5 })).toThrow(/stream/i);
  });
});

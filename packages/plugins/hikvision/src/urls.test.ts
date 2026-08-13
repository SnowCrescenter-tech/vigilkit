import { describe, expect, it } from 'vitest';
import { httpPreviewUrl, normalizeChannel, rtspUrl, snapshotUrl } from './urls.js';

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
  it('builds the main-stream URL for channel 1', () => {
    expect(rtspUrl(BASE)).toBe('rtsp://admin:12345@192.168.1.64:554/Streaming/Channels/101');
  });

  it('builds the sub-stream URL and custom channel', () => {
    expect(rtspUrl({ ...BASE, channel: 2, stream: 'sub' })).toBe(
      'rtsp://admin:12345@192.168.1.64:554/Streaming/Channels/202',
    );
  });

  it('honors a custom RTSP port', () => {
    expect(rtspUrl({ ...BASE, rtspPort: 8554 })).toBe(
      'rtsp://admin:12345@192.168.1.64:8554/Streaming/Channels/101',
    );
  });

  it('percent-encodes credentials', () => {
    expect(rtspUrl({ host: 'h', username: 'a@d min', password: 'p:ass' })).toBe(
      'rtsp://a%40d%20min:p%3Aass@h:554/Streaming/Channels/101',
    );
  });
});

describe('httpPreviewUrl', () => {
  it('builds an HTTP preview URL', () => {
    expect(httpPreviewUrl(BASE)).toBe('http://192.168.1.64:80/ISAPI/Streaming/channels/101/httpPreview');
  });

  it('supports HTTPS with the default 443 port', () => {
    expect(httpPreviewUrl({ ...BASE, https: true })).toBe(
      'https://192.168.1.64:443/ISAPI/Streaming/channels/101/httpPreview',
    );
  });
});

describe('snapshotUrl', () => {
  it('builds a picture URL', () => {
    expect(snapshotUrl(BASE)).toBe('http://192.168.1.64:80/ISAPI/Streaming/channels/101/picture');
  });
});

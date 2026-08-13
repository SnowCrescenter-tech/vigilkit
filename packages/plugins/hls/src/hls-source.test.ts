import { describe, expect, it } from 'vitest';
import type { DemuxerEvent, MediaSource } from '@vigilkit/plugin-sdk';
import type { Bytes } from './aes-cbc.js';
import { HlsSource } from './hls-source.js';
import { TsDemuxer } from './ts/ts-demuxer.js';

const SPS = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0x95, 0xa8, 0x14, 0x01, 0x6e, 0x90]);
const PPS = new Uint8Array([0x68, 0xce, 0x06, 0xe2]);
const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x00]);

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function tsPacket(pid: number, payload: Uint8Array, pusi = false): Uint8Array {
  const out = new Uint8Array(188);
  out[0] = 0x47;
  out[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  out[2] = pid & 0xff;
  out[3] = 0x10;
  out.set(payload, 4);
  return out;
}

function psiSection(tableId: number, body: number[]): Uint8Array {
  const sectionLength = body.length + 4;
  const out = new Uint8Array(3 + body.length + 4);
  out[0] = tableId;
  out[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
  out[2] = sectionLength & 0xff;
  out.set(body, 3);
  return out;
}

function patSection(pmtPid: number): Uint8Array {
  return psiSection(0x00, [0, 1, 0xc1, 0, 0, 0, 1, (0xe000 | pmtPid) >> 8, (0xe000 | pmtPid) & 0xff]);
}

function pmtSection(videoPid: number): Uint8Array {
  return psiSection(0x02, [
    0, 1, 0xc1, 0, 0, 0xe0, 0, 0xf0, 0,
    0x1b, (0xe000 | videoPid) >> 8, (0xe000 | videoPid) & 0xff, 0xf0, 0,
  ]);
}

function annexBNalu(nalu: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0, 0, 0, 1]), nalu);
}

function buildSegment(): Uint8Array<ArrayBuffer> {
  const videoPid = 0x101;
  const pmtPid = 0x100;
  const pes = new Uint8Array(9 + 5 + 13 + 5 + 4 + 5);
  pes[0] = 0;
  pes[1] = 0;
  pes[2] = 1;
  pes[3] = 0xe0;
  pes[6] = 0x80 | 0x20; // PTS only
  // PTS = 90000 ticks
  const pts = 90000;
  const tsb = [
    0x01 | (2 << 4) | ((Math.floor(pts / 0x40000000) & 7) << 1),
    Math.floor(pts / 0x400000) & 0xff,
    0x01 | ((Math.floor(pts / 0x8000) & 0x7f) << 1),
    Math.floor(pts / 0x80) & 0xff,
    0x01 | ((pts & 0x7f) << 1),
  ];
  pes[8] = 5;
  pes.set(tsb, 9);
  const es = concat(annexBNalu(SPS), annexBNalu(PPS), annexBNalu(IDR));
  const fullPes = concat(pes.subarray(0, 14), es);
  return concat(
    tsPacket(0, concat(new Uint8Array([0]), patSection(pmtPid)), true),
    tsPacket(pmtPid, concat(new Uint8Array([0]), pmtSection(videoPid)), true),
    tsPacket(videoPid, fullPes, true),
  );
}

function collect(source: MediaSource): DemuxerEvent[] {
  const events: DemuxerEvent[] = [];
  source.onEvent((event) => events.push(event));
  return events;
}

function mockFetch(route: (url: string, init?: RequestInit) => { ok: boolean; text?: string; arrayBuffer?: Uint8Array }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const result = route(url, init);
    return {
      ok: result.ok,
      status: result.ok ? 200 : 404,
      text: async () => result.text ?? '',
      arrayBuffer: async () => {
        const bytes = result.arrayBuffer ?? new Uint8Array(0);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
    } as Response;
  }) as typeof fetch;
}

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=426x240
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360
high.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
seg-0.ts
#EXTINF:2.0,
seg-0.ts
#EXT-X-ENDLIST
`;

const SEGMENT = buildSegment();

/** Hex-encodes bytes for a playlist IV attribute. */
function toHex(bytes: Bytes): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Encrypts a TS segment with AES-128-CBC for the fixture (real WebCrypto). */
async function encryptSegment(keyBytes: Bytes, iv: Bytes, plaintext: Bytes): Promise<Bytes> {
  const encryptKey = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  return new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-CBC', iv }, encryptKey, plaintext));
}

/** Demuxes bytes directly and returns the emitted video chunks. */
function videoChunksFrom(bytes: Bytes): Uint8Array[] {
  const demuxer = new TsDemuxer();
  const chunks: Uint8Array[] = [];
  demuxer.onEvent((event) => {
    if (event.type === 'video') chunks.push(event.chunk.data);
  });
  demuxer.push(bytes);
  demuxer.flush();
  return chunks;
}

function buildRoutes(): (url: string, init?: RequestInit) => { ok: boolean; text?: string; arrayBuffer?: Uint8Array } {
  const calls: string[] = [];
  const fn = (url: string): { ok: boolean; text?: string; arrayBuffer?: Uint8Array } => {
    calls.push(url);
    if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
    if (url.endsWith('low.m3u8')) return { ok: true, text: MEDIA };
    if (url.endsWith('seg-0.ts')) return { ok: true, arrayBuffer: SEGMENT };
    return { ok: false };
  };
  (fn as unknown as { calls: string[] }).calls = calls;
  return fn;
}

describe('HlsSource', () => {
  it('fetches master -> lowest variant -> media -> segments and emits events', async () => {
    const routes = buildRoutes();
    const fetchImpl = mockFetch(routes);
    const source = new HlsSource('http://localhost/hls/master.m3u8', {
      fetchImpl,
      reloadIntervalMs: 5000,
    });
    const events = collect(source);
    source.start();
    // Wait for the async bootstrap to complete.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const urls = (routes as unknown as { calls: string[] }).calls;
    expect(urls[0]).toContain('master.m3u8');
    expect(urls.some((u) => u.endsWith('low.m3u8'))).toBe(true);
    expect(urls.some((u) => u.endsWith('seg-0.ts'))).toBe(true);

    const seq = events.find((event) => event.type === 'sequence-header');
    expect(seq).toBeDefined();
    const videos = events.filter((event) => event.type === 'video');
    expect(videos.length).toBeGreaterThan(0);
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(0);
    source.stop();
  });

  it('selects the highest variant when requested', async () => {
    const routes = buildRoutes();
    const fetchImpl = mockFetch(routes);
    const source = new HlsSource('http://localhost/hls/master.m3u8', {
      fetchImpl,
      variant: 'highest',
      reloadIntervalMs: 5000,
    });
    collect(source);
    source.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const urls = (routes as unknown as { calls: string[] }).calls;
    expect(urls.some((u) => u.endsWith('high.m3u8'))).toBe(true);
    source.stop();
  });

  it('surfaces an error event for a failed master fetch', async () => {
    const fetchImpl = mockFetch(() => ({ ok: false }));
    const source = new HlsSource('http://localhost/hls/missing.m3u8', {
      fetchImpl,
      reloadIntervalMs: 5000,
    });
    const events = collect(source);
    source.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    const error = errors[0];
    expect(error && error.type === 'error' ? error.error.code : '').toBe('DEMUX');
    source.stop();
  });

  it('emits no events after stop()', async () => {
    const routes = buildRoutes();
    const fetchImpl = mockFetch(routes);
    const source = new HlsSource('http://localhost/hls/master.m3u8', {
      fetchImpl,
      reloadIntervalMs: 5000,
    });
    const events = collect(source);
    source.stop();
    source.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toHaveLength(0);
  });

  it('reloads a live playlist and appends new segments', async () => {
    let fetchCount = 0;
    const fetchImpl = mockFetch((url) => {
      if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
      if (url.endsWith('low.m3u8')) {
        fetchCount++;
        return {
          ok: true,
          text: `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
seg-0.ts
${fetchCount > 1 ? '#EXTINF:2.0,\nseg-0.ts\n' : ''}`,
        };
      }
      if (url.endsWith('seg-0.ts')) return { ok: true, arrayBuffer: SEGMENT };
      return { ok: false };
    });
    const source = new HlsSource('http://localhost/hls/master.m3u8', {
      fetchImpl,
      reloadIntervalMs: 15,
    });
    const events = collect(source);
    source.start();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const videos = events.filter((event) => event.type === 'video');
    expect(fetchCount).toBeGreaterThanOrEqual(2);
    expect(videos.length).toBeGreaterThanOrEqual(2);
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(0);
    source.stop();
  });

  it('sends Range headers for byterange segments', async () => {
    const seen: Record<string, unknown> = {};
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
      if (url.endsWith('low.m3u8')) {
        return {
          ok: true,
          text: `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-BYTERANGE:1000@0
#EXTINF:2.0,
seg-0.ts
#EXT-X-ENDLIST
`,
        };
      }
      if (url.endsWith('seg-0.ts')) {
        seen['range'] = (init?.headers as Record<string, string> | undefined)?.['Range'];
        return { ok: true, arrayBuffer: SEGMENT.slice(0, 1000) };
      }
      return { ok: false };
    });
    const source = new HlsSource('http://localhost/hls/master.m3u8', {
      fetchImpl,
      reloadIntervalMs: 5000,
    });
    collect(source);
    source.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen['range']).toBe('bytes=0-999');
    source.stop();
  });

  describe('AES-128 encryption', () => {
    const KEYED_MEDIA = (ivAttr: string): string => `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=${ivAttr}
#EXTINF:2.0,
seg-0.ts
#EXT-X-ENDLIST
`;

    it('decrypts an AES-128 segment and demuxes the plaintext bytes', async () => {
      const keyBytes = new Uint8Array(16);
      crypto.getRandomValues(keyBytes);
      const iv = new Uint8Array(16);
      iv[0] = 0x01;
      const encrypted = await encryptSegment(keyBytes, iv, SEGMENT);
      let keyFetches = 0;
      const fetchImpl = mockFetch((url) => {
        if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
        if (url.endsWith('low.m3u8')) return { ok: true, text: KEYED_MEDIA(`0x${toHex(iv)}`) };
        if (url.endsWith('key.bin')) {
          keyFetches++;
          return { ok: true, arrayBuffer: keyBytes };
        }
        if (url.endsWith('seg-0.ts')) return { ok: true, arrayBuffer: encrypted };
        return { ok: false };
      });
      const source = new HlsSource('http://localhost/hls/master.m3u8', { fetchImpl, reloadIntervalMs: 5000 });
      const events = collect(source);
      source.start();
      await new Promise((resolve) => setTimeout(resolve, 40));

      const videos = events.filter((event) => event.type === 'video');
      expect(videos.length).toBeGreaterThan(0);
      // Bytes round-trip: the decrypted stream yields exactly the video chunk
      // the plaintext TS yields when fed to a demuxer directly.
      const decrypted = videos[0]?.type === 'video' ? videos[0].chunk.data : null;
      const control = videoChunksFrom(SEGMENT);
      expect(decrypted).toEqual(control[0]);
      expect(keyFetches).toBe(1);
      expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
      source.stop();
    });

    it('derives the IV from the media sequence when the playlist omits IV', async () => {
      const keyBytes = new Uint8Array(16);
      crypto.getRandomValues(keyBytes);
      const iv = new Uint8Array(16); // media sequence 0 → 128-bit BE zero
      const encrypted = await encryptSegment(keyBytes, iv, SEGMENT);
      const fetchImpl = mockFetch((url) => {
        if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
        if (url.endsWith('low.m3u8')) {
          return { ok: true, text: `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:2.0,
seg-0.ts
#EXT-X-ENDLIST
` };
        }
        if (url.endsWith('key.bin')) return { ok: true, arrayBuffer: keyBytes };
        if (url.endsWith('seg-0.ts')) return { ok: true, arrayBuffer: encrypted };
        return { ok: false };
      });
      const source = new HlsSource('http://localhost/hls/master.m3u8', { fetchImpl, reloadIntervalMs: 5000 });
      const events = collect(source);
      source.start();
      await new Promise((resolve) => setTimeout(resolve, 40));

      const videos = events.filter((event) => event.type === 'video');
      expect(videos.length).toBeGreaterThan(0);
      const decrypted = videos[0]?.type === 'video' ? videos[0].chunk.data : null;
      expect(decrypted).toEqual(videoChunksFrom(SEGMENT)[0]);
      expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
      source.stop();
    });

    it('fetches a shared key once for multiple encrypted segments', async () => {
      const keyBytes = new Uint8Array(16);
      crypto.getRandomValues(keyBytes);
      const iv = new Uint8Array(16);
      const encrypted = await encryptSegment(keyBytes, iv, SEGMENT);
      let keyFetches = 0;
      const fetchImpl = mockFetch((url) => {
        if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
        if (url.endsWith('low.m3u8')) {
          return { ok: true, text: `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:2.0,
seg-0.ts
#EXTINF:2.0,
seg-1.ts
#EXT-X-ENDLIST
` };
        }
        if (url.endsWith('key.bin')) {
          keyFetches++;
          return { ok: true, arrayBuffer: keyBytes };
        }
        if (url.endsWith('seg-0.ts') || url.endsWith('seg-1.ts')) return { ok: true, arrayBuffer: encrypted };
        return { ok: false };
      });
      const source = new HlsSource('http://localhost/hls/master.m3u8', { fetchImpl, reloadIntervalMs: 5000 });
      const events = collect(source);
      source.start();
      await new Promise((resolve) => setTimeout(resolve, 40));

      const videos = events.filter((event) => event.type === 'video');
      expect(videos.length).toBeGreaterThanOrEqual(2);
      expect(keyFetches).toBe(1);
      expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
      source.stop();
    });

    it('surfaces a DEMUX error and stops when the key fetch fails', async () => {
      const fetchImpl = mockFetch((url) => {
        if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
        if (url.endsWith('low.m3u8')) return { ok: true, text: KEYED_MEDIA('0x00000000000000000000000000000000') };
        if (url.endsWith('key.bin')) return { ok: false };
        return { ok: false };
      });
      const source = new HlsSource('http://localhost/hls/master.m3u8', { fetchImpl, reloadIntervalMs: 5000 });
      const events = collect(source);
      source.start();
      await new Promise((resolve) => setTimeout(resolve, 40));

      const errors = events.filter((event) => event.type === 'error');
      expect(errors).toHaveLength(1);
      const error = errors[0];
      expect(error && error.type === 'error' ? error.error.code : '').toBe('DEMUX');
      expect(events.filter((event) => event.type === 'video')).toHaveLength(0);
      source.stop();
    });

    it('surfaces a DEMUX error when decryption fails (wrong key)', async () => {
      const keyBytes = new Uint8Array(16);
      crypto.getRandomValues(keyBytes);
      const iv = new Uint8Array(16);
      const encrypted = await encryptSegment(keyBytes, iv, SEGMENT);
      const wrongKey = new Uint8Array(16).fill(0xab);
      const fetchImpl = mockFetch((url) => {
        if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
        if (url.endsWith('low.m3u8')) return { ok: true, text: KEYED_MEDIA('0x00000000000000000000000000000000') };
        if (url.endsWith('key.bin')) return { ok: true, arrayBuffer: wrongKey };
        if (url.endsWith('seg-0.ts')) return { ok: true, arrayBuffer: encrypted };
        return { ok: false };
      });
      const source = new HlsSource('http://localhost/hls/master.m3u8', { fetchImpl, reloadIntervalMs: 5000 });
      const events = collect(source);
      source.start();
      await new Promise((resolve) => setTimeout(resolve, 40));

      const errors = events.filter((event) => event.type === 'error');
      expect(errors).toHaveLength(1);
      const error = errors[0];
      expect(error && error.type === 'error' ? error.error.message : '').toContain('AES-128');
      expect(events.filter((event) => event.type === 'video')).toHaveLength(0);
      source.stop();
    });
  });

  describe('live segment window', () => {
    it('skips segments beyond maxBufferedSegments in a live pass', async () => {
      let segFetches = 0;
      const fetchImpl = mockFetch((url) => {
        if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
        if (url.endsWith('low.m3u8')) {
          return { ok: true, text: `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
seg-0.ts
#EXTINF:2.0,
seg-1.ts
#EXTINF:2.0,
seg-2.ts
#EXTINF:2.0,
seg-3.ts
#EXTINF:2.0,
seg-4.ts
` };
        }
        if (/seg-\d\.ts$/.test(url)) {
          segFetches++;
          return { ok: true, arrayBuffer: SEGMENT };
        }
        return { ok: false };
      });
      const source = new HlsSource('http://localhost/hls/master.m3u8', {
        fetchImpl,
        reloadIntervalMs: 5000,
        maxBufferedSegments: 2,
      });
      collect(source);
      source.start();
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Only the first 2 segments are within the window; the tail waits for a
      // reload instead of being fetched in one unbounded pass.
      expect(segFetches).toBe(2);
      source.stop();
    });

    it('does not apply the window to VOD playlists (every segment plays)', async () => {
      let segFetches = 0;
      const fetchImpl = mockFetch((url) => {
        if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
        if (url.endsWith('low.m3u8')) {
          return { ok: true, text: `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
seg-0.ts
#EXTINF:2.0,
seg-1.ts
#EXTINF:2.0,
seg-2.ts
#EXTINF:2.0,
seg-3.ts
#EXT-X-ENDLIST
` };
        }
        if (/seg-\d\.ts$/.test(url)) {
          segFetches++;
          return { ok: true, arrayBuffer: SEGMENT };
        }
        return { ok: false };
      });
      const source = new HlsSource('http://localhost/hls/master.m3u8', {
        fetchImpl,
        reloadIntervalMs: 5000,
        maxBufferedSegments: 2,
      });
      collect(source);
      source.start();
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(segFetches).toBe(4);
      source.stop();
    });

    it('continues from the sliding media sequence without re-fetching old segments', async () => {
      let playlistVersion = 0;
      let segFetches = 0;
      const fetchImpl = mockFetch((url) => {
        if (url.endsWith('master.m3u8')) return { ok: true, text: MASTER };
        if (url.endsWith('low.m3u8')) {
          playlistVersion++;
          if (playlistVersion === 1) {
            return { ok: true, text: `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
seg-0.ts
#EXTINF:2.0,
seg-1.ts
#EXTINF:2.0,
seg-2.ts
#EXTINF:2.0,
seg-3.ts
` };
          }
          return { ok: true, text: `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:2
#EXTINF:2.0,
seg-2.ts
#EXTINF:2.0,
seg-3.ts
#EXTINF:2.0,
seg-4.ts
#EXTINF:2.0,
seg-5.ts
` };
        }
        if (/seg-\d\.ts$/.test(url)) {
          segFetches++;
          return { ok: true, arrayBuffer: SEGMENT };
        }
        return { ok: false };
      });
      const source = new HlsSource('http://localhost/hls/master.m3u8', {
        fetchImpl,
        reloadIntervalMs: 15,
        maxBufferedSegments: 10,
      });
      collect(source);
      source.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // First pass fetched seg-0..seg-3 (4). After the slide to mediaSequence
      // 2, the overlapping seg-2/seg-3 are deduped (not re-fetched) and only
      // seg-4/seg-5 are new: 6 segment fetches total, never more.
      expect(segFetches).toBe(6);
      source.stop();
    });
  });
});

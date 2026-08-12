import { describe, expect, it } from 'vitest';
import type { DemuxerEvent, MediaSource } from '@vigilkit/plugin-sdk';
import { HlsSource } from './hls-source.js';

const SPS = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0x95, 0xa8, 0x14, 0x01, 0x6e, 0x90]);
const PPS = new Uint8Array([0x68, 0xce, 0x06, 0xe2]);
const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x00]);

function concat(...parts: Uint8Array[]): Uint8Array {
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

function buildSegment(): Uint8Array {
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
});

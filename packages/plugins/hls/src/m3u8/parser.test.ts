import { describe, expect, it } from 'vitest';
import { HlsError } from '../errors.js';
import { parseM3u8 } from './parser.js';

describe('parseM3u8', () => {
  it('parses a master playlist with variants (bandwidth + resolution)', () => {
    const playlist = parseM3u8(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=426x240
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360
high.m3u8
`);
    expect(playlist.type).toBe('master');
    expect(playlist.variants).toHaveLength(2);
    expect(playlist.variants[0]).toEqual({ uri: 'low.m3u8', bandwidth: 200000, resolution: { width: 426, height: 240 } });
    expect(playlist.variants[1]).toEqual({ uri: 'high.m3u8', bandwidth: 500000, resolution: { width: 640, height: 360 } });
  });

  it('parses a media playlist with segments and flags', () => {
    const playlist = parseM3u8(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:2.0,
seg-0.ts
#EXTINF:1.5,
seg-1.ts
#EXT-X-ENDLIST
`);
    expect(playlist.type).toBe('media');
    expect(playlist.segments).toHaveLength(2);
    expect(playlist.segments[0]).toEqual({ uri: 'seg-0.ts', duration: 2 });
    expect(playlist.segments[1]).toEqual({ uri: 'seg-1.ts', duration: 1.5 });
    expect(playlist.targetDuration).toBe(2);
    expect(playlist.mediaSequence).toBe(0);
    expect(playlist.endList).toBe(true);
    expect(playlist.live).toBe(false);
    expect(playlist.version).toBe(3);
  });

  it('applies #EXT-X-BYTERANGE length@offset to the next segment', () => {
    const playlist = parseM3u8(`#EXTM3U
#EXT-X-BYTERANGE:1000@500
#EXTINF:2.0,
seg-0.ts
#EXT-X-BYTERANGE:750
#EXTINF:1.0,
seg-0.ts
`);
    expect(playlist.segments[0]?.byterange).toEqual({ length: 1000, offset: 500 });
    // Missing @offset continues from the previous range end.
    expect(playlist.segments[1]?.byterange).toEqual({ length: 750, offset: 1500 });
  });

  it('marks a playlist without ENDLIST as live', () => {
    const playlist = parseM3u8(`#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
seg-0.ts
`);
    expect(playlist.live).toBe(true);
    expect(playlist.endList).toBe(false);
  });

  it('tolerates a BOM and CRLF line endings', () => {
    const playlist = parseM3u8('\uFEFF#EXTM3U\r\n#EXTINF:2.0,\r\nseg-0.ts\r\n');
    expect(playlist.type).toBe('media');
    expect(playlist.segments[0]?.uri).toBe('seg-0.ts');
  });

  it('skips garbage lines and unknown tags', () => {
    const playlist = parseM3u8(`#EXTM3U
#EXT-X-NONSENSE:42
this is not a playlist
#EXTINF:2.0,
seg-0.ts
`);
    expect(playlist.segments).toHaveLength(1);
    expect(playlist.segments[0]?.uri).toBe('seg-0.ts');
  });

  it('parses quoted attribute values', () => {
    const playlist = parseM3u8(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH="200000",RESOLUTION="426x240"
low.m3u8
`);
    expect(playlist.variants).toHaveLength(1);
    expect(playlist.variants[0]).toEqual({ uri: 'low.m3u8', bandwidth: 200000, resolution: { width: 426, height: 240 } });
  });

  it('an EXTINF with a missing duration does not produce a NaN segment', () => {
    const playlist = parseM3u8(`#EXTM3U
#EXTINF:
seg-0.ts
#EXTINF:2.0,
seg-1.ts
`);
    // The malformed #EXTINF: entry is skipped: no NaN-duration segment.
    expect(playlist.segments).toHaveLength(1);
    expect(playlist.segments[0]).toEqual({ uri: 'seg-1.ts', duration: 2 });
  });

  // Pinned behavior: a segment URI with no preceding #EXTINF (and no pending
  // variant tag) is silently dropped — it is neither an error nor a segment.
  it('a segment URI without a preceding EXTINF is dropped silently', () => {
    const playlist = parseM3u8(`#EXTM3U
orphan.ts
#EXTINF:2.0,
seg-0.ts
`);
    expect(playlist.segments).toHaveLength(1);
    expect(playlist.segments[0]?.uri).toBe('seg-0.ts');
  });

  it('throws HlsError when #EXTM3U is missing', () => {
    expect(() => parseM3u8('#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nseg.ts')).toThrow(HlsError);
  });
});

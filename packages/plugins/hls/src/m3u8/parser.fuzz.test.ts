// Fuzz-style structured-random testing for the m3u8 parser (ROADMAP P2-11).
//
// Contract under test: parseM3u8 must never throw on arbitrary text. Malformed
// input yields a best-effort Playlist object (missing #EXTM3U included); NaN
// durations are dropped, negative durations are clamped to 0, absurdly large
// values survive as finite numbers. The PRNG is a fixed-seed mulberry32 so
// every run is reproducible.
import { describe, expect, it } from 'vitest';
import { parseM3u8 } from './parser.js';
import type { Playlist } from './types.js';

const SEED = 0x4d335538; // 'M3U8'
const N_RANDOM = 300;

/** mulberry32: tiny deterministic PRNG, seeded from a fixed constant. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random bytes decoded as latin1 (every byte maps to a code unit). */
function randomLatin1(rand: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(Math.floor(rand() * 256));
  }
  return out;
}

/** Random bytes decoded as UTF-8 (invalid sequences become U+FFFD). */
function randomUtf8(rand: () => number): string {
  const bytes = new Uint8Array(Math.floor(rand() * 1024));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(rand() * 256);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

const BASE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
seg-0.ts
#EXTINF:1.5,
seg-1.ts
#EXT-X-ENDLIST
`;

/** Garbage lines: corrupted tags, truncated lines, non-numeric durations. */
const GARBAGE_LINES = [
  '#',
  '##',
  '#EXTINF:',
  '#EXTINF:abc',
  '#EXTINF:-5',
  '#EXTINF:1e999',
  '#EXTINF:NaN',
  '#EXTINF:Infinity',
  '#EXTINF:99999999999999999999999999',
  '#EXTINF:0.0001,',
  '#EXT-X-TARGETDURATION:garbage',
  '#EXT-X-MEDIA-SEQUENCE:-42',
  '#EXT-X-MEDIA-SEQUENCE:1e999',
  '#EXT-X-VERSION:0x10',
  '#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0xzz',
  '#EXT-X-KEY:METHOD=',
  '#EXT-X-STREAM-INF:BANDWIDTH=abc,RESOLUTION=not-a-resolution',
  '#EXT-X-STREAM-INF:BANDWIDTH=999999999999999999999999999,RESOLUTION=99999999999x0',
  '#EXT-X-BYTERANGE:abc@def',
  '#EXT-X-BYTERANGE:',
  '#EXT-X-PLAYLIST-TYPE:WAT',
  'not-a-tag',
  '   ',
  '\r',
];

/** Structured mutations of a valid playlist: corrupt / truncate / duplicate. */
function mutatePlaylist(rand: () => number): string {
  const lines = BASE_PLAYLIST.split('\n');
  const insertions: string[] = [];
  const mutations = 1 + Math.floor(rand() * 4);
  for (let m = 0; m < mutations; m++) {
    const kind = Math.floor(rand() * 5);
    const index = Math.floor(rand() * lines.length);
    if (kind === 0) {
      // Replace a random line with a garbage line.
      lines[index] = GARBAGE_LINES[Math.floor(rand() * GARBAGE_LINES.length)] as string;
    } else if (kind === 1) {
      // Corrupt a random line: drop a random slice from it.
      const line = lines[index] as string;
      if (line.length > 1) {
        const start = Math.floor(rand() * line.length);
        const end = Math.min(line.length, start + 1 + Math.floor(rand() * 8));
        lines[index] = line.slice(0, start) + line.slice(end);
      }
    } else if (kind === 2) {
      // Duplicate a line.
      insertions.push(lines[index] as string);
    } else if (kind === 3) {
      // Insert a garbage line.
      insertions.push(GARBAGE_LINES[Math.floor(rand() * GARBAGE_LINES.length)] as string);
    } else {
      // Truncate a random line mid-token.
      const line = lines[index] as string;
      lines[index] = line.slice(0, Math.floor(rand() * line.length));
    }
  }
  // Re-join with a random per-line mix of LF / CRLF.
  return [...insertions, ...lines]
    .map((line) => (rand() < 0.5 ? `${line}\r\n` : `${line}\n`))
    .join('');
}

/** Structural sanity: a Playlist object, never null/garbage. */
function isValidPlaylist(value: unknown): value is Playlist {
  if (typeof value !== 'object' || value === null) return false;
  const playlist = value as Playlist;
  return (
    (playlist.type === 'master' || playlist.type === 'media') &&
    typeof playlist.mediaSequence === 'number' &&
    Array.isArray(playlist.segments) &&
    Array.isArray(playlist.variants) &&
    typeof playlist.live === 'boolean' &&
    typeof playlist.endList === 'boolean'
  );
}

/** Asserts the numeric fields of a best-effort playlist are all sane. */
function expectSaneNumbers(playlist: Playlist, label: string): void {
  for (const segment of playlist.segments) {
    // NaN durations are dropped, negatives clamped: everything that reaches a
    // Segment is a finite non-negative number.
    expect(Number.isFinite(segment.duration), `${label}: segment duration`).toBe(true);
    expect(segment.duration, `${label}: segment duration >= 0`).toBeGreaterThanOrEqual(0);
    expect(typeof segment.uri, `${label}: segment uri`).toBe('string');
    if (segment.byterange !== undefined) {
      expect(Number.isFinite(segment.byterange.length), `${label}: byterange length`).toBe(true);
      expect(Number.isFinite(segment.byterange.offset), `${label}: byterange offset`).toBe(true);
    }
  }
  for (const variant of playlist.variants) {
    if (variant.bandwidth !== undefined) {
      expect(Number.isFinite(variant.bandwidth), `${label}: variant bandwidth`).toBe(true);
    }
    if (variant.resolution !== undefined) {
      expect(Number.isFinite(variant.resolution.width), `${label}: resolution width`).toBe(true);
      expect(Number.isFinite(variant.resolution.height), `${label}: resolution height`).toBe(true);
    }
  }
  if (playlist.targetDuration !== undefined) {
    expect(Number.isFinite(playlist.targetDuration), `${label}: targetDuration`).toBe(true);
  }
  if (playlist.version !== undefined) {
    expect(Number.isFinite(playlist.version), `${label}: version`).toBe(true);
  }
}

/** Runs the parser and returns { result, threw } without letting it fail. */
function parseSafely(text: string): { result: unknown; threw: boolean } {
  try {
    return { result: parseM3u8(text), threw: false };
  } catch {
    return { result: undefined, threw: true };
  }
}

describe('parseM3u8 fuzz', () => {
  it('never throws on random byte-decoded strings', { timeout: 5000 }, () => {
    const rand = mulberry32(SEED);
    for (let i = 0; i < N_RANDOM; i++) {
      const text = rand() < 0.5 ? randomLatin1(rand, Math.floor(rand() * 2048)) : randomUtf8(rand);
      const { result, threw } = parseSafely(text);
      expect(threw, `iteration ${i}: parse threw`).toBe(false);
      expect(isValidPlaylist(result), `iteration ${i}: playlist shape`).toBe(true);
      expectSaneNumbers(result as Playlist, `iteration ${i}`);
    }
  });

  it('never throws on structured mutations of a valid playlist', { timeout: 5000 }, () => {
    const rand = mulberry32(0xdec0ded1);
    for (let i = 0; i < N_RANDOM; i++) {
      const text = mutatePlaylist(rand);
      const { result, threw } = parseSafely(text);
      expect(threw, `iteration ${i}: parse threw`).toBe(false);
      expect(isValidPlaylist(result), `iteration ${i}: playlist shape`).toBe(true);
      expectSaneNumbers(result as Playlist, `iteration ${i}`);
    }
  });
});

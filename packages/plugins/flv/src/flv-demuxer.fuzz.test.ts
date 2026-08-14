// Fuzz-style structured-random testing for FlvDemuxer (ROADMAP P2-11).
//
// Contract under test: push()/flush() must never throw synchronously on
// arbitrary bytes. Malformed input is surfaced as 'error' events or stays
// silent — never a crash, never an infinite loop. The PRNG is a fixed-seed
// mulberry32 so every run is byte-for-byte reproducible.
import { describe, expect, it } from 'vitest';
import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import { FlvDemuxer } from './flv-demuxer.js';
import { concat, craftTag, header, u24 } from './flv-test-utils.js';

const SEED = 0x564c46; // 'FLV'
const N_RANDOM = 300;
const MAX_LENGTH = 4096;

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

/** The FLV demuxer emits these event types — and never 'frame'. */
const KNOWN_EVENT_TYPES = new Set<string>([
  'metadata',
  'sequence-header',
  'audio-config',
  'video',
  'audio',
  'error',
]);

/** Asserts an event is a well-formed DemuxerEvent of a known shape. */
function expectValidEvent(event: DemuxerEvent): void {
  expect(KNOWN_EVENT_TYPES.has(event.type)).toBe(true);
  if (event.type === 'error') {
    expect(typeof event.error.code).toBe('string');
    expect(typeof event.error.message).toBe('string');
  } else if (event.type === 'sequence-header' || event.type === 'audio-config') {
    expect(event.config).toBeDefined();
  } else if (event.type === 'video' || event.type === 'audio') {
    expect(event.chunk).toBeDefined();
    expect(typeof event.chunk.timestamp).toBe('number');
    expect(event.chunk.data).toBeInstanceOf(Uint8Array);
  }
}

function randomBytes(rand: () => number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.floor(rand() * 256);
  }
  return out;
}

/** Pushes `data` (fresh copy, split into 1-3 random sub-chunks) and flushes. */
function exercise(demuxer: FlvDemuxer, rand: () => number, data: Uint8Array): boolean {
  let threw = false;
  const chunks = 1 + Math.floor(rand() * 3);
  const step = Math.max(1, Math.ceil(data.length / chunks));
  for (let offset = 0; offset < data.length; offset += step) {
    try {
      demuxer.push(new Uint8Array(data.subarray(offset, offset + step)));
    } catch {
      threw = true;
    }
  }
  try {
    demuxer.flush();
  } catch {
    threw = true;
  }
  return threw;
}

/**
 * Realistic prefix-corrupted FLV streams: valid header + garbage tails,
 * truncated tags, corrupt tag lengths, and the regression case that used to
 * leak a DemuxError out of push() (a script tag whose leading AMF value is
 * not a string).
 */
function corruptedFlvFixtures(rand: () => number): Uint8Array[] {
  const fixtures: Uint8Array[] = [];

  // Valid header + random garbage tail.
  for (let i = 0; i < 30; i++) {
    const tailLength = Math.floor(rand() * 512);
    fixtures.push(concat(header(), randomBytes(rand, tailLength)));
  }

  // A real stream (header + video/script/audio tags) truncated at
  // interesting byte offsets: mid-header, header boundary, mid-tag-header,
  // mid-payload, and just short of completion.
  const real = concat(
    header(),
    craftTag(9, randomBytes(rand, 64), 0),
    craftTag(18, randomBytes(rand, 32), 100),
    craftTag(8, randomBytes(rand, 16), 200),
  );
  const cuts = [1, 4, 9, 10, 12, 13, 14, 20, 24, 25, 70, 89, 90, 100, real.length - 5, real.length - 1];
  for (const cut of cuts) {
    fixtures.push(real.slice(0, Math.max(0, Math.min(cut, real.length))));
  }

  // Corrupt tag lengths: dataSize far beyond the buffered payload, and zero.
  const overClaim = new Uint8Array(11 + 4 + 4);
  overClaim[0] = 9; // video tag
  overClaim.set(u24(0x00ffff), 1); // claims 65535 bytes, has 4
  fixtures.push(concat(header(), overClaim));
  const zeroSize = new Uint8Array(11 + 4 + 4);
  zeroSize[0] = 18; // script tag
  zeroSize.set(u24(0), 1); // claims 0 bytes, has 4
  fixtures.push(concat(header(), zeroSize));

  // Regression: script tag whose first AMF value is an AMF number (0x00),
  // which used to throw a DemuxError out of push().
  fixtures.push(
    concat(
      header(),
      craftTag(18, new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
    ),
  );

  // Fully valid stream followed by garbage bytes.
  fixtures.push(concat(real, randomBytes(rand, 128)));

  // Random garbage that happens to start with the FLV magic.
  const magicGarbage = new Uint8Array(13 + 32);
  magicGarbage.set([0x46, 0x4c, 0x56, 0x01, 0x05], 0);
  magicGarbage.set(randomBytes(rand, 32), 13);
  fixtures.push(magicGarbage);

  return fixtures;
}

describe('FlvDemuxer fuzz', () => {
  it('never throws on random bytes and only emits known events', { timeout: 5000 }, () => {
    const rand = mulberry32(SEED);
    for (let i = 0; i < N_RANDOM; i++) {
      const length = Math.floor(rand() * (MAX_LENGTH + 1));
      const bytes = randomBytes(rand, length);
      const demuxer = new FlvDemuxer();
      const events: DemuxerEvent[] = [];
      demuxer.onEvent((event) => events.push(event));
      const threw = exercise(demuxer, rand, bytes);
      expect(threw, `iteration ${i} (${length} bytes)`).toBe(false);
      for (const event of events) {
        expectValidEvent(event);
      }
      demuxer.close();
    }
  });

  it('never throws on realistic prefix-corrupted FLV streams', { timeout: 5000 }, () => {
    const rand = mulberry32(0xc0ffeef0);
    const fixtures = corruptedFlvFixtures(rand);
    expect(fixtures.length).toBeGreaterThan(30);
    for (const [index, bytes] of fixtures.entries()) {
      const demuxer = new FlvDemuxer();
      const events: DemuxerEvent[] = [];
      demuxer.onEvent((event) => events.push(event));
      const threw = exercise(demuxer, rand, bytes);
      expect(threw, `fixture ${index} (${bytes.length} bytes)`).toBe(false);
      for (const event of events) {
        expectValidEvent(event);
      }
      demuxer.close();
    }
  });
});

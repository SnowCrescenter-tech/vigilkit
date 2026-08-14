// Fuzz-style structured-random testing for PsDemuxer (ROADMAP P2-13).
//
// Contract under test: push()/flush() must never throw synchronously on
// arbitrary bytes. Malformed input is surfaced as 'error' events or stays
// silent — never a crash, never an infinite loop. The PRNG is a fixed-seed
// mulberry32 so every run is byte-for-byte reproducible.
import { describe, expect, it } from 'vitest';
import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import { PsDemuxer } from './ps-demuxer.js';
import { concat, deltaAccessUnit, idrAccessUnit, packHeader, pesPacket } from './ps-test-utils.js';

const SEED = 0x5053; // 'PS'
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

/** The PS demuxer emits these event types — and never 'frame'. */
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
    expect(typeof event.config.codec).toBe('string');
  } else if (event.type === 'video' || event.type === 'audio') {
    expect(event.chunk).toBeDefined();
    expect(typeof event.chunk.timestamp).toBe('number');
    expect(Number.isFinite(event.chunk.timestamp)).toBe(true);
    expect(event.chunk.data).toBeInstanceOf(Uint8Array);
  } else if (event.type === 'metadata') {
    expect(typeof event.metadata.hasVideo).toBe('boolean');
    expect(typeof event.metadata.hasAudio).toBe('boolean');
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
function exercise(demuxer: PsDemuxer, rand: () => number, data: Uint8Array): boolean {
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
 * Realistic prefix-corrupted PS streams: valid pack/PES structures mixed with
 * garbage tails, truncated packets, corrupt declared lengths, and start-code
 * sequences that could confuse the resync logic.
 */
function corruptedPsFixtures(rand: () => number): Uint8Array[] {
  const fixtures: Uint8Array[] = [];

  // A real stream: pack + video key PES + audio PES, truncated at many
  // interesting byte offsets (mid-pack-header, mid-PES-header, mid-payload).
  const real = concat(
    packHeader(),
    pesPacket(0xe0, idrAccessUnit(), { ptsTicks: 90000 }),
    packHeader(),
    pesPacket(0xc0, randomBytes(rand, 32), { ptsTicks: 180000 }),
    packHeader(),
    pesPacket(0xe0, deltaAccessUnit(), { ptsTicks: 270000 }),
  );
  const cuts = [
    1, 4, 5, 13, 14, 15, 17, 22, 23, 27, 30, 34, real.length - 12, real.length - 7, real.length - 1,
  ];
  for (const cut of cuts) {
    fixtures.push(real.slice(0, Math.max(0, Math.min(cut, real.length))));
  }

  // Valid stream + random garbage tail.
  for (let i = 0; i < 20; i++) {
    fixtures.push(concat(real, randomBytes(rand, Math.floor(rand() * 256))));
  }

  // Valid stream with garbage wedged between packets.
  for (let i = 0; i < 20; i++) {
    const at = 4 + Math.floor(rand() * (real.length - 4));
    fixtures.push(concat(real.slice(0, at), randomBytes(rand, Math.floor(rand() * 64)), real.slice(at)));
  }

  // Random garbage that begins with a plausible start-code prefix.
  const prefixGarbage = new Uint8Array(6 + 48);
  prefixGarbage.set([0x00, 0x00, 0x01], 0);
  prefixGarbage.set([0x00, 0x00, 0x01, 0xba, 0xff], 6);
  prefixGarbage.set(randomBytes(rand, 43), 11);
  fixtures.push(prefixGarbage);

  // Declared-length abuse: PES_packet_length far larger than the payload.
  const overClaim = new Uint8Array([0x00, 0x00, 0x01, 0xe0, 0xff, 0xfc, 0x80, 0x00, 0x00]);
  fixtures.push(concat(packHeader(), overClaim, real));

  // Garbage with a spurious pack-header marker but no valid structure.
  fixtures.push(concat(new Uint8Array([0x00, 0x00, 0x01, 0xba, 0x40]), randomBytes(rand, 128)));

  // Empty-ish and tiny inputs.
  fixtures.push(new Uint8Array(0), new Uint8Array([0x00]), new Uint8Array([0x00, 0x00, 0x01]));

  return fixtures;
}

describe('PsDemuxer fuzz', () => {
  it('never throws on random bytes and only emits known events', { timeout: 5000 }, () => {
    const rand = mulberry32(SEED);
    for (let i = 0; i < N_RANDOM; i++) {
      const length = Math.floor(rand() * (MAX_LENGTH + 1));
      const bytes = randomBytes(rand, length);
      const demuxer = new PsDemuxer();
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

  it('never throws on realistic prefix-corrupted PS streams', { timeout: 5000 }, () => {
    const rand = mulberry32(0xbeefcafe);
    const fixtures = corruptedPsFixtures(rand);
    expect(fixtures.length).toBeGreaterThan(30);
    for (const [index, bytes] of fixtures.entries()) {
      const demuxer = new PsDemuxer();
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

// Fuzz-style structured-random testing for TsDemuxer (ROADMAP P2-11).
//
// Contract under test: push()/flush() must never throw synchronously on
// arbitrary bytes and must never loop forever. Malformed input is surfaced as
// 'error' events or stays silent. The PRNG is a fixed-seed mulberry32 so
// every run is byte-for-byte reproducible; the test timeout is the guard
// against infinite loops.
import { describe, expect, it } from 'vitest';
import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import { TsDemuxer } from './ts-demuxer.js';
import {
  AUDIO_PID,
  PMT_PID,
  VIDEO_PID,
  buildSegment,
  concat,
  patSection,
  pesHeader,
  pesPacket,
  pmtSection,
  psiPackets,
  tsPacket,
} from './ts-demuxer.fixtures.js';

const SEED = 0x54535558; // 'TSUX'
const N_RANDOM = 200;
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

/** The TS demuxer emits these event types — and never 'frame'. */
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
function exercise(demuxer: TsDemuxer, rand: () => number, data: Uint8Array): boolean {
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
 * Realistic corrupted TS streams built from the fixture utilities: truncated
 * packets, bad sync bytes, corrupt PAT/PMT (PSI length overruns), PES length
 * overruns, and random in-place byte flips over a valid segment.
 */
function corruptedTsFixtures(rand: () => number): Uint8Array[] {
  const fixtures: Uint8Array[] = [];
  const base = buildSegment();

  // Truncations at packet boundaries and mid-packet.
  const cuts = [1, 3, 4, 187, 188, 189, 375, 376, 377, 563, 564, base.length - 2, base.length - 1];
  for (const cut of cuts) {
    fixtures.push(base.slice(0, Math.max(0, Math.min(cut, base.length))));
  }

  // Bad sync byte at the start and lost sync mid-stream.
  const badSync = base.slice();
  badSync[0] = 0x00;
  fixtures.push(badSync);
  const midDesync = base.slice();
  midDesync[376] = 0x42;
  fixtures.push(midDesync);

  // PAT section_length claiming far more than the payload holds.
  const pat = psiPackets(patSection(PMT_PID), 0);
  const badPat = pat.slice();
  badPat[6] = 0xbf; // section_length high byte
  badPat[7] = 0xff; // section_length low byte
  fixtures.push(badPat);

  // PMT program_info_length overrun (section[10] high nibble -> 0xF00).
  const pmt = psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID);
  const badPmt = pmt.slice();
  badPmt[4 + 1 + 10] = 0xff;
  fixtures.push(badPmt);

  // PES headerDataLength overrun: the ES subarray clamps to empty, silent.
  const overrunPes = tsPacket(
    VIDEO_PID,
    concat(pesHeader(0xe0, 90000), new Uint8Array([0x00])),
    true,
  );
  overrunPes[4 + 8] = 0xff;
  fixtures.push(concat(psiPackets(patSection(PMT_PID), 0), psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID), overrunPes));

  // Random in-place byte flips over an otherwise valid segment.
  for (let i = 0; i < 30; i++) {
    const copy = base.slice();
    const flips = 1 + Math.floor(rand() * 8);
    for (let f = 0; f < flips; f++) {
      copy[Math.floor(rand() * copy.length)] = Math.floor(rand() * 256);
    }
    fixtures.push(copy);
  }

  // A fully valid segment followed by garbage bytes.
  fixtures.push(concat(base, randomBytes(rand, 128)));

  // Garbage-heavy stream: valid PSI + random PES payloads on the video PID.
  const garbagePes = pesPacket(VIDEO_PID, 0xe0, randomBytes(rand, 160), 90000);
  fixtures.push(concat(psiPackets(patSection(PMT_PID), 0), psiPackets(pmtSection(VIDEO_PID, AUDIO_PID), PMT_PID), garbagePes));

  return fixtures;
}

describe('TsDemuxer fuzz', () => {
  it('never throws on random bytes and only emits known events', { timeout: 5000 }, () => {
    const rand = mulberry32(SEED);
    for (let i = 0; i < N_RANDOM; i++) {
      const length = Math.floor(rand() * (MAX_LENGTH + 1));
      const bytes = randomBytes(rand, length);
      const demuxer = new TsDemuxer();
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

  it('never throws on realistic corrupted TS streams', { timeout: 5000 }, () => {
    const rand = mulberry32(0xbeefb0a5);
    const fixtures = corruptedTsFixtures(rand);
    expect(fixtures.length).toBeGreaterThan(40);
    for (const [index, bytes] of fixtures.entries()) {
      const demuxer = new TsDemuxer();
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

import { describe, expect, it } from 'vitest';
import { DriftCorrector } from './drift-corrector.js';

describe('DriftCorrector', () => {
  it('reports the median (video PTS - audio media time) offset over the ring in ms', () => {
    const corrector = new DriftCorrector({ windowSize: 4 });
    corrector.observe(1_000_000, 1_030_000); // +30ms
    corrector.observe(2_000_000, 2_020_000); // +20ms
    corrector.observe(3_000_000, 3_040_000); // +40ms
    expect(corrector.avOffsetMs()).toBe(30);
    expect(corrector.avOffsetUs()).toBe(30_000);
  });

  it('the median rejects a single outlier sample', () => {
    const corrector = new DriftCorrector({ windowSize: 32 });
    for (let i = 0; i < 31; i++) {
      corrector.observe(i * 33_000, i * 33_000); // in-sync samples
    }
    corrector.observe(0, 1_000_000); // a 1000ms outlier
    expect(corrector.avOffsetMs()).toBe(0);
    expect(corrector.needsResync()).toBe(false);
  });

  it('reset() clears the accumulated samples', () => {
    const corrector = new DriftCorrector();
    corrector.observe(0, 10_000_000);
    expect(corrector.needsResync()).toBe(true);
    corrector.reset();
    expect(corrector.avOffsetMs()).toBe(0);
    expect(corrector.needsResync()).toBe(false);
  });

  it('needsResync flips at the resyncThresholdMs boundary', () => {
    const corrector = new DriftCorrector({ resyncThresholdMs: 60 });
    corrector.observe(0, 59_000); // 59ms: under the threshold
    expect(corrector.needsResync()).toBe(false);
    corrector.observe(0, 62_000); // median (59 + 62) / 2 = 60.5ms: over
    expect(corrector.needsResync()).toBe(true);
  });

  it('10-minute simulation: resync keeps a +1% audio drift bounded, final |avOffsetMs| < 50', () => {
    const corrector = new DriftCorrector();
    // Deterministic LCG noise (±1ms jitter) so the test never flakes.
    let seed = 12345;
    const noiseUs = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed % 2001) - 1000;
    };
    const FRAME_US = 33_000; // ~30fps frame cadence
    const DURATION_US = 10 * 60 * 1e6; // 10 minutes
    // audioUs drifts +1% against videoUs; `correctionUs` is the accumulated
    // re-anchor shift the engine applies when it resyncs the video clock.
    let correctionUs = 0;
    for (let videoUs = 0; videoUs <= DURATION_US; videoUs += FRAME_US) {
      const audioUs = videoUs * 1.01 + noiseUs();
      corrector.observe(audioUs, videoUs - correctionUs);
      if (corrector.needsResync()) {
        correctionUs += corrector.avOffsetUs();
        corrector.reset();
      }
    }
    expect(Math.abs(corrector.avOffsetMs())).toBeLessThan(50);
  });
});

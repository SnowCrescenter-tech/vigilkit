import { describe, expect, it } from 'vitest';
import { MasterClock } from './master-clock.js';

describe('MasterClock', () => {
  it('uses the wall clock when no audio is attached', () => {
    const clock = new MasterClock({ now: () => 42 });
    expect(clock.nowUs()).toBe(42_000);
    expect(clock.nowMs()).toBe(42);
    expect(clock.audioActive()).toBe(false);
  });

  it('uses audio media time when the attached audio is active', () => {
    const clock = new MasterClock({ now: () => 42 });
    const audio = { audioActive: () => true, masterTimeUs: () => 1_234_567 };
    clock.attachAudio(audio);
    expect(clock.nowUs()).toBe(1_234_567);
    expect(clock.nowMs()).toBe(1234.567);
    expect(clock.audioActive()).toBe(true);
  });

  it('flips between wall clock and audio master as audio activates', () => {
    let active = false;
    const clock = new MasterClock({ now: () => 5000 });
    const audio = { audioActive: () => active, masterTimeUs: () => 2_000_000 };
    clock.attachAudio(audio);
    expect(clock.nowUs()).toBe(5_000_000);
    active = true;
    expect(clock.nowUs()).toBe(2_000_000);
    active = false;
    expect(clock.nowUs()).toBe(5_000_000);
  });

  it('an attached-but-inactive audio keeps the wall clock', () => {
    const clock = new MasterClock({ now: () => 100 });
    clock.attachAudio({ audioActive: () => false, masterTimeUs: () => 999 });
    expect(clock.nowUs()).toBe(100_000);
    expect(clock.audioActive()).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { AvSyncClock } from './av-sync.js';

describe('AvSyncClock', () => {
  it('returns delay 0 for the base frame right after reset', () => {
    const clock = new AvSyncClock();
    clock.reset(1_000_000, 1000);
    expect(clock.delayFor(1_000_000, 1000)).toBe(0);
  });

  it('returns a positive delay for a later pts', () => {
    const clock = new AvSyncClock();
    clock.reset(1_000_000, 1000);
    expect(clock.delayFor(1_000_000 + 2_000, 1000)).toBe(2);
  });

  it('returns 0 when pts is behind the base', () => {
    const clock = new AvSyncClock();
    clock.reset(1_000_000, 1000);
    expect(clock.delayFor(500_000, 1000)).toBe(0);
  });

  it('accounts for elapsed wall-clock time', () => {
    const clock = new AvSyncClock();
    clock.reset(1_000_000, 1000);
    // 2s of pts vs 3s of wall time -> overdue -> 0
    expect(clock.delayFor(1_000_000 + 2_000_000, 4000)).toBe(0);
    // 2s of pts vs 1s of wall time -> wait 1s (1000ms)
    expect(clock.delayFor(1_000_000 + 2_000_000, 2000)).toBe(1000);
  });

  it('uses the injected clock when nowMs is omitted', () => {
    const clock = new AvSyncClock(() => 2000);
    clock.reset(1_000_000);
    expect(clock.delayFor(1_000_000 + 1_000)).toBe(1);
  });
});

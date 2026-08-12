import { describe, expect, it, vi } from 'vitest';
import { Pump } from './pump.js';
import type { PumpDrivers } from './pump.js';

/**
 * One-shot (rAF-like) driver backed by a map: `requestFrame` queues a single
 * callback, `cancelFrame` removes it (so a canceled callback never fires), and
 * `fire` consumes one pending callback. Models real rAF semantics.
 */
function manualDriver(): {
  drivers: PumpDrivers;
  fire: (times?: number) => void;
  pendingCount: () => number;
  canceledIds: number[];
} {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const canceledIds: number[] = [];
  return {
    drivers: {
      requestFrame: (cb) => {
        const id = nextId++;
        pending.set(id, cb);
        return id;
      },
      cancelFrame: (id) => {
        canceledIds.push(id);
        pending.delete(id);
      },
    },
    fire: (times = 1) => {
      for (let i = 0; i < times; i++) {
        const entry = pending.entries().next();
        if (entry.done) {
          return;
        }
        const [id, cb] = entry.value;
        pending.delete(id);
        cb();
      }
    },
    pendingCount: () => pending.size,
    canceledIds,
  };
}

describe('Pump', () => {
  it('drives the tick once per request via an injected one-shot driver', () => {
    const { drivers, fire, pendingCount, canceledIds } = manualDriver();
    const ticks: number[] = [];
    const pump = new Pump(() => ticks.push(1), { drivers });
    expect(pump.active).toBe(false);
    pump.start();
    expect(pump.active).toBe(true);
    expect(pendingCount()).toBe(1);
    fire();
    expect(ticks).toHaveLength(1);
    expect(pendingCount()).toBe(1); // re-armed after the tick
    fire();
    expect(ticks).toHaveLength(2);
    pump.stop();
    expect(pump.active).toBe(false);
    expect(canceledIds.length).toBeGreaterThan(0);
    fire(); // a stale callback after stop is ignored
    expect(ticks).toHaveLength(2);
  });

  it('falls back to a 30ms interval when no rAF driver is available', () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('requestAnimationFrame', undefined);
      const ticks: number[] = [];
      const pump = new Pump(() => ticks.push(1));
      pump.start();
      vi.advanceTimersByTime(29);
      expect(ticks).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(ticks).toHaveLength(1);
      vi.advanceTimersByTime(30);
      expect(ticks).toHaveLength(2);
      pump.stop();
      vi.advanceTimersByTime(100);
      expect(ticks).toHaveLength(2); // stop cancels the interval
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('switches to the slow interval while hidden and back to rAF when visible', () => {
    vi.useFakeTimers();
    try {
      let hidden = false;
      const visibilityListeners: Array<() => void> = [];
      const notify = (): void => {
        for (const cb of visibilityListeners) {
          cb();
        }
      };
      const { drivers, fire, pendingCount } = manualDriver();
      const ticks: number[] = [];
      const pump = new Pump(() => ticks.push(1), {
        drivers,
        hiddenIntervalMs: 250,
        isHidden: () => hidden,
        addVisibilityListener: (cb) => {
          visibilityListeners.push(cb);
          return () => {
            const index = visibilityListeners.indexOf(cb);
            if (index !== -1) {
              visibilityListeners.splice(index, 1);
            }
          };
        },
      });
      pump.start();
      expect(pendingCount()).toBe(1); // visible: rAF cadence
      hidden = true;
      notify();
      expect(pendingCount()).toBe(0); // rAF canceled, hidden interval armed
      vi.advanceTimersByTime(249);
      expect(ticks).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(ticks).toHaveLength(1);
      vi.advanceTimersByTime(250);
      expect(ticks).toHaveLength(2);
      hidden = false;
      notify();
      expect(pendingCount()).toBe(1); // back to rAF cadence
      fire();
      expect(ticks).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() is idempotent', () => {
    const { drivers, fire } = manualDriver();
    const ticks: number[] = [];
    const pump = new Pump(() => ticks.push(1), { drivers });
    pump.start();
    pump.stop();
    pump.stop();
    expect(pump.active).toBe(false);
    fire();
    expect(ticks).toHaveLength(0);
  });

  it('start() is idempotent: repeated start() does not double-queue requests', () => {
    const { drivers, fire, pendingCount } = manualDriver();
    const ticks: number[] = [];
    const pump = new Pump(() => ticks.push(1), { drivers });
    pump.start();
    pump.start();
    pump.start();
    expect(pendingCount()).toBe(1);
    fire(3);
    expect(ticks).toHaveLength(3); // one tick per fire, no double-tick
    expect(pendingCount()).toBe(1);
  });
});

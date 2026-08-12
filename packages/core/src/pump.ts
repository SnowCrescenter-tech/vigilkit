/**
 * rAF-backed playback pump.
 *
 * Drives a tick callback at display refresh rate via `requestAnimationFrame`
 * in browsers, falling back to `setInterval` (30ms) in runtimes without rAF
 * (Node, workers) so engine fake-timer tests keep their cadence. While the
 * tab is hidden the primary driver is swapped for a slow interval (250ms) so
 * decode/backpressure keeps draining without burning battery.
 */

export interface PumpDrivers {
  /** Schedule exactly one `cb` invocation; returns a handle for cancelFrame. */
  requestFrame: (cb: () => void) => number;
  /** Cancel a previously scheduled invocation. */
  cancelFrame: (id: number) => void;
}

export interface PumpOptions {
  /**
   * Override the frame-scheduling drivers. Injected drivers are treated as
   * one-shot (rAF-like): `requestFrame` schedules a single callback and the
   * pump re-arms after every tick. Defaults to rAF / setInterval.
   */
  drivers?: Partial<PumpDrivers>;
  /** Interval cadence for the non-browser fallback. Default 30ms. */
  intervalMs?: number;
  /** Interval cadence used while the tab is hidden. Default 250ms. */
  hiddenIntervalMs?: number;
  /** Injectable visibility query; defaults to `document.hidden`. */
  isHidden?: () => boolean;
  /** Injectable visibility subscription; defaults to `visibilitychange`. */
  addVisibilityListener?: (cb: () => void) => () => void;
}

const PUMP_INTERVAL_MS = 30;
const HIDDEN_INTERVAL_MS = 250;

interface ResolvedDrivers {
  drivers: PumpDrivers;
  rearm: boolean;
}

function intervalDrivers(intervalMs: number): PumpDrivers {
  return {
    requestFrame: (cb) => setInterval(cb, intervalMs),
    cancelFrame: (id) => clearInterval(id),
  };
}

function rAFDrivers(): PumpDrivers {
  return {
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
  };
}

function defaultDrivers(options: PumpOptions): ResolvedDrivers {
  if (typeof requestAnimationFrame === 'function') {
    return { drivers: rAFDrivers(), rearm: true };
  }
  return { drivers: intervalDrivers(options.intervalMs ?? PUMP_INTERVAL_MS), rearm: false };
}

export class Pump {
  private readonly primary: PumpDrivers;
  private readonly primaryRearm: boolean;
  private readonly hiddenDrivers: PumpDrivers;
  private readonly isHidden: () => boolean;
  private readonly removeVisibility: (() => void) | undefined;
  private started = false;
  private hidden = false;
  private frameId: number | null = null;
  private current: PumpDrivers;
  private currentRearm = false;

  constructor(
    private readonly tick: () => void,
    options: PumpOptions = {},
  ) {
    const primary = this.resolvePrimary(options);
    this.primary = primary.drivers;
    this.primaryRearm = primary.rearm;
    this.hiddenDrivers = intervalDrivers(options.hiddenIntervalMs ?? HIDDEN_INTERVAL_MS);
    this.current = this.primary;
    this.currentRearm = this.primaryRearm;
    const hasDocument = typeof document !== 'undefined';
    this.isHidden = options.isHidden ?? (hasDocument ? () => document.hidden : () => false);
    const addVisibility =
      options.addVisibilityListener ??
      (hasDocument
        ? (cb: () => void): (() => void) => {
            document.addEventListener('visibilitychange', cb);
            return () => document.removeEventListener('visibilitychange', cb);
          }
        : undefined);
    this.removeVisibility =
      addVisibility === undefined ? undefined : addVisibility(() => this.handleVisibilityChange());
  }

  get active(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.applyHiddenState();
    this.schedule();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.cancel();
  }

  /** Stops the pump and detaches the visibility listener. */
  destroy(): void {
    this.stop();
    this.removeVisibility?.();
  }

  private schedule(): void {
    this.frameId = this.current.requestFrame(() => this.handleTick());
  }

  private handleTick(): void {
    if (!this.started) {
      return;
    }
    this.tick();
    if (this.currentRearm) {
      this.schedule();
    }
  }

  private cancel(): void {
    if (this.frameId !== null) {
      this.current.cancelFrame(this.frameId);
      this.frameId = null;
    }
  }

  private applyHiddenState(): void {
    if (!this.started) {
      return;
    }
    const hidden = this.isHidden();
    if (hidden === this.hidden) {
      return;
    }
    this.hidden = hidden;
    this.cancel();
    this.current = hidden ? this.hiddenDrivers : this.primary;
    this.currentRearm = hidden ? false : this.primaryRearm;
  }

  private handleVisibilityChange(): void {
    const prevHidden = this.hidden;
    this.applyHiddenState();
    if (prevHidden !== this.hidden) {
      this.schedule();
    }
  }

  private resolvePrimary(options: PumpOptions): ResolvedDrivers {
    const injected = options.drivers;
    if (injected?.requestFrame !== undefined || injected?.cancelFrame !== undefined) {
      const fallback = defaultDrivers(options);
      return {
        drivers: {
          requestFrame: injected.requestFrame ?? fallback.drivers.requestFrame,
          cancelFrame: injected.cancelFrame ?? fallback.drivers.cancelFrame,
        },
        rearm: true,
      };
    }
    return defaultDrivers(options);
  }
}

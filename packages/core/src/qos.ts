export interface StallMonitorOptions {
  /** Idle time (ms) after which a stall episode is declared. */
  stallThresholdMs: number;
  /** Stall-episode duration (ms) beyond which the stall is fatal. */
  fatalStallMs: number;
}

export interface StallTickResult {
  stalledCount: number;
  rebufferMs: number;
  activeStall: boolean;
  /** True on the tick the current episode began (rising edge). */
  started: boolean;
  /** True once, when the current episode exceeds fatalStallMs. */
  fatal: boolean;
}

/**
 * Episode-aware stall watchdog. `noteData` records data activity (enqueue or
 * decoder output); `onTick` runs once per pump tick with whether the pipeline
 * still has data to consume. Declares one stall episode per idle run past
 * `stallThresholdMs`, accumulates rebuffer time while stalled, and reports
 * `fatal` once an episode outlives `fatalStallMs`.
 */
export class StallMonitor {
  private episodes = 0;
  private rebufferAccum = 0;
  private active = false;
  private lastDataAtMs: number | null = null;
  private lastTickMs: number | null = null;
  private episodeStartMs = 0;
  private fatalReported = false;
  private readonly stallThresholdMs: number;
  private readonly fatalStallMs: number;

  constructor(options: StallMonitorOptions) {
    this.stallThresholdMs = options.stallThresholdMs;
    this.fatalStallMs = options.fatalStallMs;
  }

  /** Records data activity; clears any active episode. */
  noteData(now: number): void {
    this.lastDataAtMs = now;
    this.active = false;
    this.fatalReported = false;
  }

  get stalledCount(): number {
    return this.episodes;
  }

  get rebufferMs(): number {
    return this.rebufferAccum;
  }

  onTick(hasData: boolean, now: number): StallTickResult | undefined {
    if (this.active && this.lastTickMs !== null) {
      this.rebufferAccum += Math.max(0, now - this.lastTickMs);
    }
    this.lastTickMs = now;

    if (hasData) {
      if (this.active) {
        this.active = false;
        this.fatalReported = false;
        return this.snapshot(false, false);
      }
      return undefined;
    }
    if (this.active) {
      const fatal = !this.fatalReported && now - this.episodeStartMs > this.fatalStallMs;
      if (fatal) {
        this.fatalReported = true;
      }
      return this.snapshot(false, fatal);
    }
    if (this.lastDataAtMs === null || now - this.lastDataAtMs <= this.stallThresholdMs) {
      return undefined;
    }
    this.active = true;
    this.episodes++;
    this.episodeStartMs = now;
    this.fatalReported = false;
    return this.snapshot(true, false);
  }

  private snapshot(started: boolean, fatal: boolean): StallTickResult {
    return {
      stalledCount: this.episodes,
      rebufferMs: this.rebufferAccum,
      activeStall: this.active,
      started,
      fatal,
    };
  }
}

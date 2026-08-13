export interface DriftCorrectorOptions {
  /** Ring size of (audio media time, video PTS) offset samples. Default 32. */
  windowSize?: number;
  /** |avOffsetMs| above this means the streams need a resync. Default 60. */
  resyncThresholdMs?: number;
}

/**
 * Sample-accurate A/V drift detector. Each rendered frame contributes an
 * (audio media time, video PTS) sample; the smoothed offset is the MEDIAN of
 * the most recent `windowSize` offsets, so a single outlier sample cannot
 * skew it. When |avOffsetMs()| crosses `resyncThresholdMs` the engine re-bases
 * the video clock (Scheduler.resync()) and calls reset() to re-anchor the
 * window to the new base.
 */
export class DriftCorrector {
  private readonly windowSize: number;
  private readonly resyncThresholdMs: number;
  private readonly offsetsUs: number[] = [];
  private cursor = 0;
  private count = 0;

  constructor(options: DriftCorrectorOptions = {}) {
    this.windowSize = options.windowSize ?? 32;
    this.resyncThresholdMs = options.resyncThresholdMs ?? 60;
  }

  /** Records one (audio media time, video PTS) sample; offset = video - audio. */
  observe(audioMediaUs: number, videoPtsUs: number): void {
    this.offsetsUs[this.cursor % this.windowSize] = videoPtsUs - audioMediaUs;
    this.cursor++;
    if (this.count < this.windowSize) {
      this.count++;
    }
  }

  /** Smoothed offset in µs (median of the ring; 0 until the first sample). */
  avOffsetUs(): number {
    return this.medianUs();
  }

  /** Smoothed offset in ms. */
  avOffsetMs(): number {
    return this.avOffsetUs() / 1000;
  }

  /** True when |avOffsetMs()| exceeds the resync threshold. */
  needsResync(): boolean {
    return Math.abs(this.avOffsetMs()) > this.resyncThresholdMs;
  }

  /** Clears the ring; call after re-anchoring the video clock on resync. */
  reset(): void {
    this.cursor = 0;
    this.count = 0;
  }

  private medianUs(): number {
    if (this.count === 0) {
      return 0;
    }
    const values = this.offsetsUs.slice(0, this.count).sort((a, b) => a - b);
    const mid = Math.floor(this.count / 2);
    if (this.count % 2 === 1) {
      return values[mid] ?? 0;
    }
    return ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
  }
}

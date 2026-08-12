export class AvSyncClock {
  private basePtsUs = 0;
  private baseTimeMs = 0;
  private baseSet = false;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** Aligns the pts origin with the wall-clock origin. */
  reset(basePtsUs: number, nowMs?: number): void {
    this.basePtsUs = basePtsUs;
    this.baseTimeMs = nowMs ?? this.now();
    this.baseSet = true;
  }

  /**
   * Milliseconds to wait before the frame at `ptsUs` is due.
   * Returns 0 when the frame is already due or behind the base.
   */
  delayFor(ptsUs: number, nowMs?: number): number {
    const delayMs = this.latenessMs(ptsUs, nowMs);
    return delayMs > 0 ? delayMs : 0;
  }

  /**
   * Signed variant of `delayFor`: positive means ahead of schedule,
   * negative means the frame is already late by that many ms.
   */
  latenessMs(ptsUs: number, nowMs?: number): number {
    if (!this.baseSet) {
      return 0;
    }
    const currentMs = nowMs ?? this.now();
    const elapsedMs = currentMs - this.baseTimeMs;
    // Surveillance/FLV streams carry a 33-bit microsecond PTS counter that
    // wraps every ~2.4h. Unwrap the delta so a wrapped PTS reads as the next
    // frame instead of ~-8.6M ms of lateness.
    const wrap = 2 ** 33;
    const residue = ((ptsUs - this.basePtsUs) % wrap + wrap) % wrap;
    const ptsElapsedMs = (residue > wrap / 2 ? residue - wrap : residue) / 1000;
    return ptsElapsedMs - elapsedMs;
  }
}

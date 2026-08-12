export interface MasterClockOptions {
  /** Wall clock in ms; defaults to performance.now. */
  now?: () => number;
}

/** Audio source contract the master clock derives media time from. */
export interface MasterAudio {
  audioActive(): boolean;
  masterTimeUs(): number;
}

/**
 * Supplies the playback pipeline's `now()`. While audio is actively playing
 * (AudioContext running with a scheduled buffer) the master is the audio media
 * time; otherwise it falls back to the wall clock.
 */
export class MasterClock {
  private readonly now: () => number;
  private audio: MasterAudio | null = null;

  constructor(options: MasterClockOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  attachAudio(audio: MasterAudio): void {
    this.audio = audio;
  }

  /** Current master time in µs. */
  nowUs(): number {
    if (this.audio !== null && this.audio.audioActive()) {
      return this.audio.masterTimeUs();
    }
    return this.now() * 1000;
  }

  /** Current master time in ms (the scheduler's clock unit). */
  nowMs(): number {
    return this.nowUs() / 1000;
  }

  audioActive(): boolean {
    return this.audio !== null && this.audio.audioActive();
  }
}

export interface JitterBufferOptions {
  capacity?: number;
  onOverflow?: (dropped: number) => void;
}

/**
 * Sorted FIFO buffer keyed by `timestamp`. Equal timestamps keep insertion
 * order (stable). On overflow the OLDEST items are dropped and the count is
 * reported through `onOverflow`.
 */
export class JitterBuffer<T extends { timestamp: number }> {
  private readonly items: T[] = [];
  private readonly capacity: number;
  private readonly onOverflow: ((dropped: number) => void) | undefined;

  constructor(options: JitterBufferOptions = {}) {
    this.capacity = options.capacity ?? 512;
    this.onOverflow = options.onOverflow;
  }

  push(item: T): void {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const existing = this.items[mid];
      if (existing !== undefined && existing.timestamp <= item.timestamp) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    this.items.splice(low, 0, item);
    const overflow = this.items.length - this.capacity;
    if (overflow > 0) {
      const dropped = this.items.splice(0, overflow);
      this.onOverflow?.(dropped.length);
    }
  }

  next(): T | undefined {
    return this.items.shift();
  }

  peek(): T | undefined {
    return this.items[0];
  }

  /** The newest (largest-pts) item, or undefined when empty. */
  tail(): T | undefined {
    return this.items[this.items.length - 1];
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

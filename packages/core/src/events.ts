type Handler<T> = (payload: T) => void;

export class Emitter<EventMap extends object> {
  private readonly handlers = new Map<keyof EventMap, Set<Handler<never>>>();

  on<K extends keyof EventMap>(type: K, cb: Handler<EventMap[K]>): () => void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  off<K extends keyof EventMap>(type: K, cb: Handler<EventMap[K]>): void {
    const set = this.handlers.get(type);
    if (set === undefined) {
      return;
    }
    set.delete(cb);
    if (set.size === 0) {
      this.handlers.delete(type);
    }
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    const set = this.handlers.get(type);
    if (set === undefined) {
      return;
    }
    for (const handler of [...set]) {
      (handler as (payload: EventMap[K]) => void)(payload);
    }
  }

  listenerCount(type: keyof EventMap): number {
    const set = this.handlers.get(type);
    return set === undefined ? 0 : set.size;
  }
}

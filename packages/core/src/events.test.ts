import { describe, expect, it, vi } from 'vitest';
import { Emitter } from './events.js';

interface TestEvents {
  ping: { n: number };
  done: string;
}

describe('Emitter', () => {
  it('emit delivers payload to registered listeners', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = vi.fn();
    emitter.on('ping', listener);
    emitter.emit('ping', { n: 1 });
    expect(listener).toHaveBeenCalledWith({ n: 1 });
  });

  it('off removes a listener so emit does not call it', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = vi.fn();
    emitter.on('ping', listener);
    emitter.off('ping', listener);
    emitter.emit('ping', { n: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('the returned unsubscribe function removes the listener', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = vi.fn();
    const unsubscribe = emitter.on('ping', listener);
    unsubscribe();
    emitter.emit('ping', { n: 3 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('emit with no listeners does not throw', () => {
    const emitter = new Emitter<TestEvents>();
    expect(() => emitter.emit('done', 'x')).not.toThrow();
  });

  it('listenerCount tracks active listeners', () => {
    const emitter = new Emitter<TestEvents>();
    expect(emitter.listenerCount('ping')).toBe(0);
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('ping', a);
    emitter.on('ping', b);
    expect(emitter.listenerCount('ping')).toBe(2);
    emitter.off('ping', a);
    expect(emitter.listenerCount('ping')).toBe(1);
    emitter.off('ping', b);
    expect(emitter.listenerCount('ping')).toBe(0);
  });

  it('all registered listeners receive the payload', () => {
    const emitter = new Emitter<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('done', a);
    emitter.on('done', b);
    emitter.emit('done', 'payload');
    expect(a).toHaveBeenCalledWith('payload');
    expect(b).toHaveBeenCalledWith('payload');
  });

  it('different event types are independent', () => {
    const emitter = new Emitter<TestEvents>();
    const ping = vi.fn();
    const done = vi.fn();
    emitter.on('ping', ping);
    emitter.on('done', done);
    emitter.emit('ping', { n: 1 });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });
});

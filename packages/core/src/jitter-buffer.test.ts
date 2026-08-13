import { describe, expect, it, vi } from 'vitest';
import { JitterBuffer } from './jitter-buffer.js';

interface Item {
  timestamp: number;
  id: string;
}

describe('JitterBuffer', () => {
  it('yields FIFO order for monotonic timestamps', () => {
    const buffer = new JitterBuffer<Item>();
    buffer.push({ timestamp: 1, id: 'a' });
    buffer.push({ timestamp: 2, id: 'b' });
    buffer.push({ timestamp: 3, id: 'c' });
    expect(buffer.next()?.id).toBe('a');
    expect(buffer.next()?.id).toBe('b');
    expect(buffer.next()?.id).toBe('c');
  });

  it('yields ascending order for out-of-order timestamps', () => {
    const buffer = new JitterBuffer<Item>();
    buffer.push({ timestamp: 30, id: 'c' });
    buffer.push({ timestamp: 10, id: 'a' });
    buffer.push({ timestamp: 20, id: 'b' });
    expect([buffer.next()?.id, buffer.next()?.id, buffer.next()?.id]).toEqual(['a', 'b', 'c']);
  });

  it('stays FIFO-stable for equal timestamps', () => {
    const buffer = new JitterBuffer<Item>();
    buffer.push({ timestamp: 5, id: 'first' });
    buffer.push({ timestamp: 5, id: 'second' });
    buffer.push({ timestamp: 5, id: 'third' });
    expect([buffer.next()?.id, buffer.next()?.id, buffer.next()?.id]).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('capacity overflow drops the oldest and fires onOverflow with the count', () => {
    const onOverflow = vi.fn();
    const buffer = new JitterBuffer<Item>({ capacity: 2, onOverflow });
    buffer.push({ timestamp: 1, id: 'a' });
    buffer.push({ timestamp: 2, id: 'b' });
    buffer.push({ timestamp: 3, id: 'c' });
    buffer.push({ timestamp: 4, id: 'd' });
    expect(onOverflow).toHaveBeenCalledTimes(2);
    expect(onOverflow).toHaveBeenNthCalledWith(1, 1);
    expect(onOverflow).toHaveBeenNthCalledWith(2, 1);
    expect(buffer.size).toBe(2);
    expect(buffer.peek()?.id).toBe('c');
  });

  it('capacity 1 overflow drops the oldest on every push', () => {
    const onOverflow = vi.fn();
    const buffer = new JitterBuffer<Item>({ capacity: 1, onOverflow });
    buffer.push({ timestamp: 1, id: 'a' });
    buffer.push({ timestamp: 2, id: 'b' });
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenNthCalledWith(1, 1);
    expect(buffer.size).toBe(1);
    expect(buffer.peek()?.id).toBe('b');
    buffer.push({ timestamp: 3, id: 'c' });
    expect(onOverflow).toHaveBeenCalledTimes(2);
    expect(buffer.peek()?.id).toBe('c');
  });

  it('equal-timestamp pushes stay FIFO-stable across capacity overflow', () => {
    const onOverflow = vi.fn();
    const buffer = new JitterBuffer<Item>({ capacity: 2, onOverflow });
    buffer.push({ timestamp: 5, id: 'first' });
    buffer.push({ timestamp: 5, id: 'second' });
    buffer.push({ timestamp: 5, id: 'third' });
    expect(onOverflow).toHaveBeenNthCalledWith(1, 1);
    expect([buffer.next()?.id, buffer.next()?.id]).toEqual(['second', 'third']);
  });

  it('peek is non-destructive', () => {
    const buffer = new JitterBuffer<Item>();
    buffer.push({ timestamp: 7, id: 'x' });
    expect(buffer.peek()?.id).toBe('x');
    expect(buffer.size).toBe(1);
    expect(buffer.peek()?.id).toBe('x');
  });

  it('next consumes the head', () => {
    const buffer = new JitterBuffer<Item>();
    buffer.push({ timestamp: 7, id: 'x' });
    expect(buffer.next()?.id).toBe('x');
    expect(buffer.next()).toBeUndefined();
    expect(buffer.size).toBe(0);
  });

  it('returns undefined when empty', () => {
    const buffer = new JitterBuffer<Item>();
    expect(buffer.peek()).toBeUndefined();
    expect(buffer.next()).toBeUndefined();
  });

  it('tail() returns the last item in pts order', () => {
    const buffer = new JitterBuffer<Item>();
    buffer.push({ timestamp: 1, id: 'a' });
    buffer.push({ timestamp: 3, id: 'c' });
    buffer.push({ timestamp: 2, id: 'b' });
    expect(buffer.tail()?.id).toBe('c');
  });

  it('tail() is undefined when empty', () => {
    const buffer = new JitterBuffer<Item>();
    expect(buffer.tail()).toBeUndefined();
  });

  it('clear empties the buffer', () => {
    const buffer = new JitterBuffer<Item>();
    buffer.push({ timestamp: 1, id: 'a' });
    buffer.push({ timestamp: 2, id: 'b' });
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.next()).toBeUndefined();
  });

  it('defaults to capacity 512', () => {
    const buffer = new JitterBuffer<Item>();
    for (let i = 0; i < 512; i++) {
      buffer.push({ timestamp: i, id: String(i) });
    }
    expect(buffer.size).toBe(512);
    buffer.push({ timestamp: 512, id: 'overflow' });
    expect(buffer.size).toBe(512);
    expect(buffer.peek()?.id).toBe('1');
  });
});

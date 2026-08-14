import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransportEvent } from '@vigilkit/plugin-sdk';
import {
  WebSocketTransport,
  type WebSocketConstructor,
  type WebSocketTransportOptions,
} from '../src/index.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * Minimal WebSocket stand-in implementing only the surface that
 * WebSocketTransport touches, plus helpers to fire events on demand.
 */
class MockWebSocketImpl {
  static readonly instances: MockWebSocketImpl[] = [];

  readonly url: string;
  binaryType = 'blob';
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocketImpl.instances.push(this);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = CLOSED;
  }

  triggerOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  triggerData(data: ArrayBuffer): void {
    this.onmessage?.({ data });
  }

  triggerClose(code: number): void {
    this.readyState = CLOSED;
    this.onclose?.({ code });
  }

  triggerError(): void {
    this.onerror?.();
  }
}

const MockWebSocket = MockWebSocketImpl as unknown as WebSocketConstructor;

/**
 * WebSocket stand-in that succeeds on the first construction (usable as a real
 * socket) and then throws — for exercising a failing reconnect attempt.
 */
class FlakyWebSocketImpl {
  static constructions = 0;
  static first: FlakyWebSocketImpl | null = null;

  readonly url: string;
  binaryType = 'blob';
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    FlakyWebSocketImpl.constructions += 1;
    if (FlakyWebSocketImpl.constructions > 1) {
      throw new Error('connection refused');
    }
    FlakyWebSocketImpl.first = this;
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = CLOSED;
  }

  triggerOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  triggerClose(code: number): void {
    this.readyState = CLOSED;
    this.onclose?.({ code });
  }
}

const FlakyWebSocket = FlakyWebSocketImpl as unknown as WebSocketConstructor;

function lastSocket(): MockWebSocketImpl {
  const socket = MockWebSocketImpl.instances.at(-1);
  if (socket === undefined) {
    throw new Error('no WebSocket was created by connect()');
  }
  return socket;
}

function makeTransport(url = 'ws://localhost:8080'): WebSocketTransport {
  return new WebSocketTransport(url, { WebSocketCtor: MockWebSocket });
}

describe('WebSocketTransport', () => {
  beforeEach(() => {
    MockWebSocketImpl.instances.length = 0;
  });

  it('emits { type: "open" } when the socket opens', () => {
    const transport = makeTransport();
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));

    transport.connect();
    lastSocket().triggerOpen();

    expect(events).toEqual([{ type: 'open' }]);
  });

  it('accepts the wss scheme', () => {
    const transport = makeTransport('wss://example.com/feed');
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));

    transport.connect();
    lastSocket().triggerOpen();

    expect(events).toEqual([{ type: 'open' }]);
  });

  it('emits a data event with the exact bytes of an ArrayBuffer message', () => {
    const transport = makeTransport();
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    transport.connect();

    const expected = new Uint8Array([0, 1, 127, 128, 255]);
    lastSocket().triggerData(expected.buffer);

    expect(events).toEqual([{ type: 'data', data: expected }]);
  });

  it('emits a close event with the server close code', () => {
    const transport = makeTransport();
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    transport.connect();

    lastSocket().triggerClose(1006);

    expect(events).toEqual([{ type: 'close', code: 1006 }]);
  });

  it('emits error then close when the socket errors and closes (standard contract)', () => {
    const transport = makeTransport();
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    transport.connect();
    const socket = lastSocket();

    socket.triggerError();
    socket.triggerClose(1006);

    expect(events).toEqual([
      { type: 'error', error: { code: 'TRANSPORT', message: 'WebSocket error' } },
      { type: 'close', code: 1006 },
    ]);
  });

  it('close() is idempotent and suppresses events after explicit close', () => {
    const transport = makeTransport();
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    transport.connect();
    const socket = lastSocket();

    transport.close();
    transport.close();

    socket.triggerOpen();
    socket.triggerData(new Uint8Array([1, 2]).buffer);
    socket.triggerClose(1000);

    expect(events).toEqual([]);
    expect(socket.closeCalls).toBe(1);
  });

  it('throws TransportError for a non-ws scheme', () => {
    const transport = makeTransport('http://example.com/live');

    expect(() => transport.connect()).toThrowError(
      expect.objectContaining({ code: 'TRANSPORT', message: expect.stringContaining('invalid scheme') }),
    );
  });

  it('onEvent unsubscribe stops event delivery', () => {
    const transport = makeTransport();
    const events: TransportEvent[] = [];
    const unsubscribe = transport.onEvent((event) => events.push(event));
    transport.connect();

    unsubscribe();
    lastSocket().triggerOpen();
    lastSocket().triggerData(new Uint8Array([9]).buffer);

    expect(events).toEqual([]);
  });

  it('sets socket binaryType to "arraybuffer" on connect', () => {
    const transport = makeTransport();

    transport.connect();

    expect(lastSocket().binaryType).toBe('arraybuffer');
  });
});

describe('WebSocketTransport reconnect', () => {
  beforeEach(() => {
    MockWebSocketImpl.instances.length = 0;
    FlakyWebSocketImpl.constructions = 0;
    FlakyWebSocketImpl.first = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeReconnectTransport(
    overrides: Partial<WebSocketTransportOptions> = {},
  ): WebSocketTransport {
    return new WebSocketTransport('ws://localhost:8080', {
      WebSocketCtor: MockWebSocket,
      reconnect: true,
      ...overrides,
    });
  }

  it('does not reconnect when reconnect is disabled (default behavior locked)', () => {
    const transport = makeTransport(); // reconnect defaults to false
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    transport.connect();
    const socket = lastSocket();
    socket.triggerOpen();
    socket.triggerClose(1006);

    expect(events).toEqual([
      { type: 'open' },
      { type: 'close', code: 1006 },
    ]);
    expect(transport.state).toBe('closed');
    expect(MockWebSocketImpl.instances.length).toBe(1);
  });

  it('schedules a reconnect on unexpected close and doubles the backoff per attempt', () => {
    vi.useFakeTimers();
    const transport = makeReconnectTransport({ reconnectDelayMs: 500 });
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    transport.connect();
    const first = lastSocket();
    first.triggerOpen();
    first.triggerClose(1006);

    // No close event while reconnecting — the pipeline stays alive.
    expect(events).toEqual([{ type: 'open' }]);
    expect(transport.state).toBe('reconnecting');
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 500);

    vi.advanceTimersByTime(500);
    expect(MockWebSocketImpl.instances.length).toBe(2);
    const second = lastSocket();
    expect(second).not.toBe(first);

    // Second drop: the new socket closes before opening — delay doubles.
    second.triggerClose(1006);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);
    expect(transport.state).toBe('reconnecting');
  });

  it('never reconnects after an explicit close()', () => {
    vi.useFakeTimers();
    const transport = makeReconnectTransport();
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    transport.connect();
    const socket = lastSocket();
    socket.triggerOpen();

    transport.close();
    socket.triggerClose(1006); // socket close racing in after the user close

    // Only the pre-close open is delivered; the user close is terminal.
    expect(events).toEqual([{ type: 'open' }]);
    expect(transport.state).toBe('closed');
    expect(MockWebSocketImpl.instances.length).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(MockWebSocketImpl.instances.length).toBe(1);
    expect(events).toEqual([{ type: 'open' }]);
  });

  it('emits a final close and stops once reconnectMaxAttempts is exhausted', () => {
    vi.useFakeTimers();
    const transport = makeReconnectTransport({ reconnectMaxAttempts: 2 });
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    transport.connect();
    lastSocket().triggerOpen();
    lastSocket().triggerClose(1006); // schedules attempt 1

    vi.advanceTimersByTime(500);
    lastSocket().triggerClose(1006); // schedules attempt 2

    vi.advanceTimersByTime(1000);
    lastSocket().triggerClose(1006); // cap reached

    expect(events).toEqual([{ type: 'open' }, { type: 'close', code: 1006 }]);
    expect(transport.state).toBe('closed');
    expect(MockWebSocketImpl.instances.length).toBe(3);

    vi.advanceTimersByTime(60_000);
    expect(MockWebSocketImpl.instances.length).toBe(3); // permanently stopped
  });

  it('resumes data delivery after a successful reconnect', () => {
    vi.useFakeTimers();
    const transport = makeReconnectTransport();
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    transport.connect();
    const first = lastSocket();
    first.triggerOpen();
    first.triggerClose(1006);

    vi.advanceTimersByTime(500);
    const second = lastSocket();
    second.triggerOpen();
    expect(transport.state).toBe('open');

    const payload = new Uint8Array([1, 2, 3]);
    second.triggerData(payload.buffer);

    expect(events).toEqual([
      { type: 'open' },
      { type: 'open' },
      { type: 'data', data: payload },
    ]);
  });

  it('caps the backoff delay at reconnectMaxDelayMs', () => {
    vi.useFakeTimers();
    const transport = makeReconnectTransport({
      reconnectDelayMs: 500,
      reconnectFactor: 2,
      reconnectMaxDelayMs: 2000,
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    transport.connect();
    lastSocket().triggerOpen();

    lastSocket().triggerClose(1006);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 500);
    vi.advanceTimersByTime(500);

    lastSocket().triggerClose(1006);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);
    vi.advanceTimersByTime(1000);

    lastSocket().triggerClose(1006);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2000);
    vi.advanceTimersByTime(2000);

    lastSocket().triggerClose(1006);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2000);
    expect(transport.state).toBe('reconnecting');
  });

  it('emits a final close (code 1006) and stops when a reconnect attempt throws', () => {
    vi.useFakeTimers();
    const transport = new WebSocketTransport('ws://localhost:8080', {
      WebSocketCtor: FlakyWebSocket,
      reconnect: true,
    });
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));
    transport.connect();
    const first = FlakyWebSocketImpl.first;
    expect(first).not.toBeNull();
    first?.triggerOpen();
    first?.triggerClose(1006);

    expect(transport.state).toBe('reconnecting');
    vi.advanceTimersByTime(500); // reconnect attempt throws

    expect(events).toEqual([{ type: 'open' }, { type: 'close', code: 1006 }]);
    expect(transport.state).toBe('closed');
    expect(FlakyWebSocketImpl.constructions).toBe(2);

    vi.advanceTimersByTime(60_000);
    expect(FlakyWebSocketImpl.constructions).toBe(2); // permanently stopped
  });
});

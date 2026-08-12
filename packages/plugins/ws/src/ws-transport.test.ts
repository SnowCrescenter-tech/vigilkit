import { beforeEach, describe, expect, it } from 'vitest';
import type { TransportEvent } from '@vigilkit/plugin-sdk';
import {
  WebSocketTransport,
  type WebSocketConstructor,
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

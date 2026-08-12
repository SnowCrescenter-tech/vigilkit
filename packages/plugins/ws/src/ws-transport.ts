import type { Transport, TransportEvent } from '@vigilkit/plugin-sdk';
import { TransportError } from './errors.js';

export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocket;

export interface WebSocketTransportOptions {
  WebSocketCtor?: WebSocketConstructor;
}

// WebSocket.readyState value for "already closed". Inline constant: the global
// WebSocket is not guaranteed to exist outside browsers (e.g. Node tests).
const CLOSED = 3;

const isWebSocketUrl = (url: string): boolean => {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  return protocol === 'ws:' || protocol === 'wss:';
};

/**
 * Transport backed by the browser WebSocket API. Binary messages arrive as
 * ArrayBuffer and are surfaced as Uint8Array views over the same bytes.
 *
 * Event contract (mirrors the standard WebSocket flow): an error event is
 * followed by a close event; both are emitted. After an explicit close() no
 * further events are emitted.
 */
export class WebSocketTransport implements Transport {
  private readonly url: string;
  private readonly WebSocketCtor: WebSocketConstructor;
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private socket: WebSocket | null = null;
  private closed = false;

  constructor(url: string, options?: WebSocketTransportOptions) {
    this.url = url;
    this.WebSocketCtor = options?.WebSocketCtor ?? globalThis.WebSocket;
  }

  connect(): void {
    if (this.socket !== null) {
      return;
    }
    if (!isWebSocketUrl(this.url)) {
      throw new TransportError('invalid scheme');
    }
    const socket = new this.WebSocketCtor(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => this.emit({ type: 'open' });
    socket.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.emit({ type: 'data', data: new Uint8Array(event.data) });
      }
    };
    socket.onclose = (event: CloseEvent) => this.emit({ type: 'close', code: event.code });
    socket.onerror = () =>
      this.emit({ type: 'error', error: { code: 'TRANSPORT', message: 'WebSocket error' } });
  }

  close(): void {
    this.closed = true;
    const socket = this.socket;
    if (socket === null || socket.readyState === CLOSED) {
      return;
    }
    socket.close();
  }

  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: TransportEvent): void {
    if (this.closed) {
      return;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

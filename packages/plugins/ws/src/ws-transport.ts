import type { Transport, TransportEvent } from '@vigilkit/plugin-sdk';
import { TransportError } from './errors.js';

export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocket;

export interface WebSocketTransportOptions {
  WebSocketCtor?: WebSocketConstructor;
  /** Reconnect after an unexpected close. Defaults to false (opt-in). */
  reconnect?: boolean;
  /** Initial reconnect delay in ms. Defaults to 500. */
  reconnectDelayMs?: number;
  /** Backoff cap in ms. Defaults to 30_000. */
  reconnectMaxDelayMs?: number;
  /** Backoff multiplier per attempt. Defaults to 2. */
  reconnectFactor?: number;
  /** Maximum reconnect attempts; 0 = unlimited. Defaults to 0. */
  reconnectMaxAttempts?: number;
}

export type WebSocketTransportState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

// WebSocket.readyState value for "already closed". Inline constant: the global
// WebSocket is not guaranteed to exist outside browsers (e.g. Node tests).
const CLOSED = 3;

// Close code for an abnormal (connection dropped without a close frame) close.
const ABNORMAL_CLOSE = 1006;

const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_FACTOR = 2;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 0;

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
 *
 * Reconnect: when `reconnect` is enabled, an unexpected close (a close not
 * preceded by an explicit close()) schedules a reconnect after an exponential
 * backoff delay (doubling per attempt, capped at `reconnectMaxDelayMs`).
 * No 'close' event is emitted while reconnecting — the stream is treated as
 * temporarily dropped. The reconnect fails permanently (final 'close' with the
 * socket's code, or 1006) when the attempt cap is reached or a reconnect
 * attempt throws; an explicit close() always stops the transport for good.
 */
export class WebSocketTransport implements Transport {
  private readonly url: string;
  private readonly WebSocketCtor: WebSocketConstructor;
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private readonly reconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectFactor: number;
  private readonly reconnectMaxAttempts: number;
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private _state: WebSocketTransportState = 'idle';

  constructor(url: string, options?: WebSocketTransportOptions) {
    this.url = url;
    this.WebSocketCtor = options?.WebSocketCtor ?? globalThis.WebSocket;
    this.reconnect = options?.reconnect ?? false;
    this.reconnectDelayMs = options?.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.reconnectMaxDelayMs = options?.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.reconnectFactor = options?.reconnectFactor ?? DEFAULT_RECONNECT_FACTOR;
    this.reconnectMaxAttempts =
      options?.reconnectMaxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS;
  }

  /** Current lifecycle state; 'reconnecting' while a backoff timer is pending. */
  get state(): WebSocketTransportState {
    return this._state;
  }

  connect(): void {
    if (this.closed || this.socket !== null || this._state === 'reconnecting') {
      return;
    }
    if (!isWebSocketUrl(this.url)) {
      throw new TransportError('invalid scheme');
    }
    this._state = 'connecting';
    this.openSocket();
  }

  close(): void {
    this.closed = true;
    this._state = 'closed';
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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

  /**
   * Creates the socket and wires its handlers. The first connection is made
   * from connect() (a constructor throw propagates, preserving the original
   * synchronous error contract); a reconnect attempt instead ends the
   * transport with a final 'close' (1006).
   */
  private openSocket(): void {
    try {
      const socket = new this.WebSocketCtor(this.url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.onopen = () => {
        this._state = 'open';
        this.emit({ type: 'open' });
      };
      socket.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          this.emit({ type: 'data', data: new Uint8Array(event.data) });
        }
      };
      socket.onclose = (event: CloseEvent) => this.onSocketClose(event.code);
      socket.onerror = () =>
        this.emit({ type: 'error', error: { code: 'TRANSPORT', message: 'WebSocket error' } });
    } catch (error) {
      if (this._state === 'reconnecting') {
        this.finalClose(ABNORMAL_CLOSE);
      } else {
        throw error;
      }
    }
  }

  /**
   * A socket closed without an explicit close(). If reconnect is enabled and
   * attempts remain, schedule a reconnect after the current backoff delay (no
   * 'close' event — the stream is expected back). Otherwise emit the final
   * 'close' and stop.
   */
  private onSocketClose(code: number): void {
    if (this.closed) {
      return;
    }
    this.socket = null;
    if (
      !this.reconnect ||
      (this.reconnectMaxAttempts > 0 && this.reconnectAttempts >= this.reconnectMaxAttempts)
    ) {
      this.finalClose(code);
      return;
    }
    const delay = this.backoffDelay();
    this.reconnectAttempts += 1;
    this._state = 'reconnecting';
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptReconnect();
    }, delay);
  }

  private attemptReconnect(): void {
    if (this.closed) {
      return;
    }
    this.openSocket();
  }

  private backoffDelay(): number {
    const delay = this.reconnectDelayMs * Math.pow(this.reconnectFactor, this.reconnectAttempts);
    return Math.min(delay, this.reconnectMaxDelayMs);
  }

  /** Permanent stop: emit the final 'close', then suppress every further event. */
  private finalClose(code: number): void {
    this.socket = null;
    this._state = 'closed';
    this.emit({ type: 'close', code });
    this.closed = true;
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

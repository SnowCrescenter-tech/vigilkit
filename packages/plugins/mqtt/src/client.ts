import { MqttError } from './errors.js';
import {
  PacketStream,
  buildConnect,
  buildDisconnect,
  buildPingReq,
  buildPubAck,
  buildPubComp,
  buildPubRec,
  buildPubRel,
  buildPublish,
  buildSubscribe,
  buildUnsubscribe,
  type MqttPacket,
  type Qos,
} from './packet.js';
import type { WillMessage } from './packet.js';

export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocket;

export type MqttClientState = 'idle' | 'connecting' | 'connected' | 'closing' | 'closed';

export interface MqttClientOptions {
  clientId?: string;
  username?: string;
  password?: string;
  keepaliveSec?: number;
  cleanSession?: boolean;
  will?: WillMessage;
  /** Injectable WebSocket constructor (defaults to the runtime global). */
  WebSocketCtor?: WebSocketConstructor;
  /** Keepalive ping interval in ms (defaults to keepaliveSec * 500). */
  pingIntervalMs?: number;
  /** Timeout for the CONNECT → CONNACK handshake, ms. Defaults to 10000. */
  connectTimeoutMs?: number;
  /** Timeout for an awaited ack (PUBACK/PUBREC/SUBACK/UNSUBACK), ms. Defaults to 10000. */
  ackTimeoutMs?: number;
}

export interface MqttClientEvents {
  /** A PUBLISH arrived from the broker; payload is raw bytes. */
  message: (topic: string, payload: Uint8Array) => void;
  /** The connection was closed (by close()/end() or by the peer). */
  close: () => void;
  /** A non-fatal or fatal error occurred (e.g. malformed frame, ping timeout). */
  error: (error: MqttError) => void;
}

const DEFAULT_KEEPALIVE_SEC = 60;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const OPEN = 1;
const CLOSED = 3;

/** Maps a broker's CONNACK return code to a typed error code. */
const connackErrorCode = (returnCode: number): 'AUTH' | 'PROTOCOL' =>
  returnCode === 4 || returnCode === 5 ? 'AUTH' : 'PROTOCOL';

const connackMessage = (returnCode: number): string => {
  const names: Record<number, string> = {
    1: 'unacceptable protocol version',
    2: 'identifier rejected',
    3: 'server unavailable',
    4: 'bad username or password',
    5: 'not authorized',
  };
  return `CONNACK rejected connection: ${names[returnCode] ?? `return code ${returnCode}`}`;
};

/** Translates mqtt://mqtts:// URLs to their WebSocket equivalents. */
const normalizeUrl = (url: string): string => {
  if (url.startsWith('mqtt://')) {
    return `ws://${url.slice('mqtt://'.length)}`;
  }
  if (url.startsWith('mqtts://')) {
    return `wss://${url.slice('mqtts://'.length)}`;
  }
  return url;
};

type Waiter =
  | { kind: 'puback'; resolve: () => void; reject: (error: MqttError) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: 'pubrec'; resolve: () => void; reject: (error: MqttError) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: 'pubcomp'; resolve: () => void; reject: (error: MqttError) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: 'subscribe'; resolve: (codes: number[]) => void; reject: (error: MqttError) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: 'unsubscribe'; resolve: () => void; reject: (error: MqttError) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Zero-dependency MQTT 3.1.1 client over WebSocket for browser / IoT use.
 *
 * The wire protocol is implemented from the OASIS MQTT 3.1.1 specification;
 * transport is the host runtime's native WebSocket. The WebSocket constructor
 * is injectable (`WebSocketCtor`) so tests and non-browser runtimes can
 * substitute a double.
 */
export class MqttClient {
  private readonly url: string;
  private readonly clientId: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly keepaliveSec: number;
  private readonly cleanSession: boolean;
  private readonly will?: WillMessage;
  private readonly WebSocketCtor: WebSocketConstructor;
  private readonly pingIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;

  private socket: WebSocket | null = null;
  private _state: MqttClientState = 'idle';
  private explicitClose = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingOutstanding = false;
  private pingMissed = false;
  private lastTrafficMs = 0;
  private packetIdCounter = 0;
  private readonly pending = new Map<number, Waiter>();
  private readonly inboundQos2 = new Set<number>();
  private readonly packetStream: PacketStream;
  private readonly listeners: {
    [K in keyof MqttClientEvents]: Set<MqttClientEvents[K]>;
  } = {
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };
  private connectSettle: ((error: MqttError | null) => void) | null = null;

  constructor(url: string, options: MqttClientOptions = {}) {
    this.url = normalizeUrl(url);
    this.clientId = options.clientId ?? `vigilkit-${Math.random().toString(36).slice(2, 10)}`;
    this.username = options.username;
    this.password = options.password;
    this.keepaliveSec = options.keepaliveSec ?? DEFAULT_KEEPALIVE_SEC;
    this.cleanSession = options.cleanSession ?? true;
    this.will = options.will;
    this.WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
    this.pingIntervalMs =
      options.pingIntervalMs ?? (this.keepaliveSec > 0 ? this.keepaliveSec * 500 : 0);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.packetStream = new PacketStream({ onError: (error) => this.emit('error', error) });
  }

  /** Current lifecycle state. */
  get state(): MqttClientState {
    return this._state;
  }

  /**
   * Opens the WebSocket, sends CONNECT, and resolves once CONNACK with return
   * code 0 arrives. Rejects with a typed `MqttError` on a rejected CONNACK
   * (`AUTH`/`PROTOCOL`), a network failure (`NETWORK`), or a handshake
   * timeout (`TIMEOUT`).
   */
  connect(): Promise<void> {
    if (this._state !== 'idle') {
      return Promise.reject(
        new MqttError('INVALID_ARGUMENT', `connect() called in state '${this._state}'`),
      );
    }
    this._state = 'connecting';
    this.explicitClose = false;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error: MqttError | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.connectSettle = null;
        if (this.connectTimer !== null) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        if (error !== null) {
          this._state = 'closed';
          this.cleanupSocket();
          reject(error);
        } else {
          this._state = 'connected';
          this.startPing();
          resolve();
        }
      };
      this.connectSettle = settle;

      try {
        const socket = new this.WebSocketCtor(this.url);
        socket.binaryType = 'arraybuffer';
        this.socket = socket;
        socket.onopen = () => {
          this.sendRaw(
            buildConnect({
              clientId: this.clientId,
              keepaliveSec: this.keepaliveSec,
              cleanSession: this.cleanSession,
              username: this.username,
              password: this.password,
              will: this.will,
            }),
          );
        };
        socket.onmessage = (event: MessageEvent) => this.onSocketData(event);
        socket.onerror = () => {
          const error = new MqttError('NETWORK', 'WebSocket error');
          this.emit('error', error);
          settle(error);
        };
        socket.onclose = () => this.onSocketClose();
      } catch (error) {
        settle(
          new MqttError(
            'NETWORK',
            `WebSocket construction failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }

      this.connectTimer = setTimeout(() => {
        settle(new MqttError('TIMEOUT', `timed out waiting for CONNACK (${this.connectTimeoutMs}ms)`));
      }, this.connectTimeoutMs);
    });
  }

  /**
   * Publishes a message. QoS 0 returns immediately after sending; QoS 1
   * resolves on PUBACK; QoS 2 runs the PUBREC → PUBREL → PUBCOMP handshake.
   * Rejects with `TIMEOUT` if the broker does not acknowledge in time.
   */
  async publish(
    topic: string,
    payload: string | Uint8Array,
    options: { qos?: Qos; retain?: boolean } = {},
  ): Promise<void> {
    this.assertConnected();
    const qos = options.qos ?? 0;
    const retain = options.retain ?? false;
    if (qos === 0) {
      this.requireOpen();
      this.sendRaw(buildPublish({ topic, payload, qos: 0, retain }));
      return;
    }
    const packetId = this.nextPacketId();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timeoutWaiter(packetId);
      }, this.ackTimeoutMs);
      this.pending.set(packetId, {
        kind: qos === 1 ? 'puback' : 'pubrec',
        resolve,
        reject,
        timer,
      });
      if (!this.sendRaw(buildPublish({ topic, payload, qos, retain, packetId }))) {
        this.failWaiter(packetId, new MqttError('NETWORK', 'socket not open'));
      }
    });
  }

  /**
   * Subscribes to one or more topic filters and resolves with the broker's
   * granted QoS list (a `0x80` entry means that subscription failed).
   */
  async subscribe(topics: string | Array<{ topic: string; qos?: Qos }>): Promise<number[]> {
    this.assertConnected();
    const subscriptions = (typeof topics === 'string' ? [{ topic: topics, qos: 0 }] : topics).map(
      (entry) => ({ topic: entry.topic, qos: (entry.qos ?? 0) as Qos }),
    );
    const packetId = this.nextPacketId();
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timeoutWaiter(packetId);
      }, this.ackTimeoutMs);
      this.pending.set(packetId, { kind: 'subscribe', resolve, reject, timer });
      if (!this.sendRaw(buildSubscribe({ packetId, subscriptions }))) {
        this.failWaiter(packetId, new MqttError('NETWORK', 'socket not open'));
      }
    });
  }

  /** Unsubscribes from topic filters, resolving on UNSUBACK. */
  async unsubscribe(topics: string | string[]): Promise<void> {
    this.assertConnected();
    const list = typeof topics === 'string' ? [topics] : topics;
    const packetId = this.nextPacketId();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timeoutWaiter(packetId);
      }, this.ackTimeoutMs);
      this.pending.set(packetId, { kind: 'unsubscribe', resolve, reject, timer });
      if (!this.sendRaw(buildUnsubscribe({ packetId, topics: list }))) {
        this.failWaiter(packetId, new MqttError('NETWORK', 'socket not open'));
      }
    });
  }

  /** Subscribes a listener; returns a function that removes it. */
  on<K extends keyof MqttClientEvents>(event: K, listener: MqttClientEvents[K]): () => void {
    const set = this.listeners[event];
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /**
   * Closes the connection: sends DISCONNECT, closes the WebSocket, and
   * transitions to 'closed'. Idempotent; `end()` is an alias.
   */
  close(): void {
    if (this._state === 'closed' || this._state === 'closing') {
      return;
    }
    this.explicitClose = true;
    this.clearTimers();
    if (this._state === 'connected') {
      const socket = this.socket;
      if (socket !== null && socket.readyState === OPEN) {
        this.sendRaw(buildDisconnect());
      }
    }
    this._state = 'closing';
    const socket = this.socket;
    if (socket !== null && socket.readyState !== CLOSED) {
      socket.close();
    } else {
      this.finishClose();
    }
  }

  /** Alias for {@link close}. */
  end(): void {
    this.close();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertConnected(): void {
    if (this._state !== 'connected') {
      throw new MqttError(
        'INVALID_ARGUMENT',
        `operation requires a connected client (state: '${this._state}')`,
      );
    }
  }

  /** True when the socket is open; otherwise records a network error. */
  private requireOpen(): void {
    if (this.socket === null || this.socket.readyState !== OPEN) {
      throw new MqttError('NETWORK', 'socket not open');
    }
  }

  /** Sends a raw frame; returns false when the socket is not open. */
  private sendRaw(frame: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) {
      return false;
    }
    try {
      socket.send(frame);
    } catch {
      return false;
    }
    this.lastTrafficMs = Date.now();
    return true;
  }

  private onSocketData(event: MessageEvent): void {
    const data = event.data;
    if (!(data instanceof ArrayBuffer)) {
      return; // binary frames only (binaryType = 'arraybuffer')
    }
    this.lastTrafficMs = Date.now();
    const packets = this.packetStream.push(new Uint8Array(data));
    for (const packet of packets) {
      this.handlePacket(packet);
    }
  }

  private handlePacket(packet: MqttPacket): void {
    switch (packet.type) {
      case 'connack':
        if (this._state === 'connecting') {
          if (packet.returnCode === 0) {
            this.connectSettle?.(null);
          } else {
            this.connectSettle?.(
              new MqttError(connackErrorCode(packet.returnCode), connackMessage(packet.returnCode)),
            );
          }
        }
        break;
      case 'publish': {
        this.emit('message', packet.topic, packet.payload);
        if (packet.qos === 1) {
          this.sendRaw(buildPubAck(packet.packetId));
        } else if (packet.qos === 2) {
          this.inboundQos2.add(packet.packetId);
          this.sendRaw(buildPubRec(packet.packetId));
        }
        break;
      }
      case 'puback':
        this.resolveAck(packet.packetId, 'puback');
        break;
      case 'pubrec':
        this.resolveAck(packet.packetId, 'pubrec');
        break;
      case 'pubrel':
        // Inbound QoS 2 completion: acknowledge with PUBCOMP (even for an
        // unknown packet id, per spec the handshake must complete).
        this.inboundQos2.delete(packet.packetId);
        this.sendRaw(buildPubComp(packet.packetId));
        break;
      case 'pubcomp':
        this.resolveAck(packet.packetId, 'pubcomp');
        break;
      case 'suback': {
        const waiter = this.pending.get(packet.packetId);
        if (waiter !== undefined && waiter.kind === 'subscribe') {
          this.settleWaiter(packet.packetId, null);
          waiter.resolve(packet.returnCodes);
        }
        break;
      }
      case 'unsuback': {
        const waiter = this.pending.get(packet.packetId);
        if (waiter !== undefined && waiter.kind === 'unsubscribe') {
          this.settleWaiter(packet.packetId, null);
          waiter.resolve();
        }
        break;
      }
      case 'pingresp':
        this.pingOutstanding = false;
        this.pingMissed = false;
        break;
      default:
        break; // connect/subscribe/pingreq from the broker: nothing to do
    }
  }

  /** Advances a QoS 2 publish waiter through its two-phase handshake. */
  private resolveAck(packetId: number, ack: 'puback' | 'pubrec' | 'pubcomp'): void {
    const waiter = this.pending.get(packetId);
    if (waiter === undefined) {
      return;
    }
    if (waiter.kind === 'puback' && ack === 'puback') {
      this.settleWaiter(packetId, null);
      waiter.resolve();
      return;
    }
    if (waiter.kind === 'pubrec' && ack === 'pubrec') {
      // Phase 1 done: switch the waiter to await PUBCOMP and send PUBREL.
      this.pending.delete(packetId);
      const next: Waiter = { ...waiter, kind: 'pubcomp' };
      this.pending.set(packetId, next);
      this.sendRaw(buildPubRel(packetId));
      return;
    }
    if (waiter.kind === 'pubcomp' && ack === 'pubcomp') {
      this.settleWaiter(packetId, null);
      waiter.resolve();
      return;
    }
    // Unexpected ack for this packet id: protocol violation.
    this.settleWaiter(packetId, new MqttError('PROTOCOL', `unexpected ${ack} for packet ${packetId}`));
  }

  /** Removes a waiter from the map (clearing its timer) after resolution. */
  private settleWaiter(packetId: number, error: MqttError | null): void {
    const waiter = this.pending.get(packetId);
    if (waiter === undefined) {
      return;
    }
    clearTimeout(waiter.timer);
    this.pending.delete(packetId);
    if (error !== null) {
      waiter.reject(error);
    }
  }

  private timeoutWaiter(packetId: number): void {
    this.settleWaiter(packetId, new MqttError('TIMEOUT', `no acknowledgement for packet ${packetId}`));
  }

  private failWaiter(packetId: number, error: MqttError): void {
    this.settleWaiter(packetId, error);
  }

  private nextPacketId(): number {
    for (let attempts = 0; attempts < 0xffff; attempts += 1) {
      this.packetIdCounter += 1;
      if (this.packetIdCounter > 0xffff) {
        this.packetIdCounter = 1;
      }
      if (!this.pending.has(this.packetIdCounter)) {
        return this.packetIdCounter;
      }
    }
    throw new MqttError('PROTOCOL', 'no free packet ids');
  }

  // --- keepalive ping ------------------------------------------------------

  private startPing(): void {
    if (this.pingIntervalMs <= 0) {
      return;
    }
    this.pingTimer = setInterval(() => this.onPingTick(), this.pingIntervalMs);
  }

  private onPingTick(): void {
    if (this._state !== 'connected') {
      return;
    }
    if (Date.now() - this.lastTrafficMs < this.pingIntervalMs) {
      return;
    }
    if (this.pingOutstanding) {
      if (this.pingMissed) {
        // A PINGREQ was outstanding for two full intervals with no reply.
        this.failConnection(new MqttError('NETWORK', 'broker did not respond to PINGREQ'));
        return;
      }
      this.pingMissed = true; // resend once before giving up
    } else {
      this.pingOutstanding = true;
    }
    this.sendRaw(buildPingReq());
  }

  private failConnection(error: MqttError): void {
    this.emit('error', error);
    this.explicitClose = true;
    this._state = 'closing';
    const socket = this.socket;
    if (socket !== null && socket.readyState !== CLOSED) {
      socket.close();
    } else {
      this.finishClose();
    }
  }

  // --- lifecycle -----------------------------------------------------------

  private onSocketClose(): void {
    if (this._state === 'closed') {
      return;
    }
    if (this._state === 'connecting' && this.connectSettle !== null) {
      this.connectSettle(new MqttError('NETWORK', 'socket closed before CONNACK'));
      return;
    }
    if (!this.explicitClose) {
      this.failConnection(new MqttError('NETWORK', 'connection closed unexpectedly'));
      return;
    }
    this.finishClose();
  }

  private finishClose(): void {
    this.clearTimers();
    this._state = 'closed';
    const error = new MqttError('NETWORK', 'connection closed');
    for (const [packetId, waiter] of [...this.pending]) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(packetId);
    }
    this.inboundQos2.clear();
    this.emit('close');
  }

  private cleanupSocket(): void {
    this.socket = null;
  }

  private clearTimers(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private emit<K extends keyof MqttClientEvents>(
    event: K,
    ...args: Parameters<MqttClientEvents[K]>
  ): void {
    for (const listener of this.listeners[event]) {
      (listener as (...callArgs: Parameters<MqttClientEvents[K]>) => void)(...args);
    }
  }
}

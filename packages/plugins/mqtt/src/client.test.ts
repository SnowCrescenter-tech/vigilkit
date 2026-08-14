import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MqttClient, type MqttClientOptions, type WebSocketConstructor } from './client.js';
import { MqttError } from './errors.js';
import {
  buildConnack,
  buildPingResp,
  buildPubAck,
  buildPubComp,
  buildPubRec,
  buildPubRel,
  buildPublish,
  buildSubAck,
  buildUnsubAck,
  parsePacket,
  type MqttPacket,
} from './packet.js';

const URL = 'ws://broker.test/mqtt';

/** Minimal WebSocket double recording everything the client sends. */
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  sent: ArrayBufferLike[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: { type: string }) => void) | null = null;

  constructor(url: string, _protocols?: string | string[]) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === 'string') {
      this.sent.push(new TextEncoder().encode(data).buffer);
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(data);
    } else {
      this.sent.push(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength).buffer,
      );
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // --- test helpers --------------------------------------------------------

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(bytes: Uint8Array): void {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }

  fail(): void {
    this.onerror?.({ type: 'error' });
  }

  serverClose(code = 1006): void {
    this.close(code);
  }

  sentPackets(): MqttPacket[] {
    return this.sent.map((buffer) => parsePacket(new Uint8Array(buffer)));
  }

  lastPacket(): MqttPacket {
    const packets = this.sentPackets();
    const last = packets[packets.length - 1];
    if (last === undefined) {
      throw new Error('no packet sent yet');
    }
    return last;
  }
}

const clients: MqttClient[] = [];
const track = (client: MqttClient): MqttClient => {
  clients.push(client);
  return client;
};

/** The mock structurally matches only the parts the client touches; cast for the rest. */
const MockWebSocketCtor = MockWebSocket as unknown as WebSocketConstructor;

const makeClient = (options: MqttClientOptions = {}): MqttClient =>
  track(new MqttClient(URL, { WebSocketCtor: MockWebSocketCtor, ...options }));

/** Drives the connect handshake to completion and returns the socket. */
async function connectClient(client: MqttClient): Promise<MockWebSocket> {
  const promise = client.connect();
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (ws === undefined) {
    throw new Error('no websocket was created');
  }
  ws.open();
  ws.receive(buildConnack({ sessionPresent: false, returnCode: 0 }));
  await promise;
  return ws;
}

beforeEach(() => {
  MockWebSocket.instances.length = 0;
});

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
  vi.useRealTimers();
});

describe('connect', () => {
  it('opens the socket, sends CONNECT, and resolves on CONNACK', async () => {
    const client = makeClient({
      clientId: 'c1',
      username: 'u',
      password: 'p',
      keepaliveSec: 30,
      cleanSession: true,
    });
    const ws = await connectClient(client);
    expect(ws.lastPacket()).toMatchObject({
      type: 'connect',
      clientId: 'c1',
      username: 'u',
      password: 'p',
      keepaliveSec: 30,
      cleanSession: true,
    });
    expect(client.state).toBe('connected');
  });

  it('defaults the client id, keepalive, and clean session', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const connect = ws.lastPacket();
    expect(connect).toMatchObject({ type: 'connect', keepaliveSec: 60, cleanSession: true });
    const clientId = (connect as { clientId: string }).clientId;
    expect(clientId.startsWith('vigilkit-')).toBe(true);
  });

  it('normalizes mqtt:// and mqtts:// schemes to ws(s)://', async () => {
    const a = track(new MqttClient('mqtt://broker.test/mqtt', { WebSocketCtor: MockWebSocketCtor }));
    const b = track(
      new MqttClient('mqtts://broker.test/mqtt', { WebSocketCtor: MockWebSocketCtor }),
    );
    const pa = a.connect();
    const pb = b.connect();
    expect(MockWebSocket.instances[0]?.url).toBe('ws://broker.test/mqtt');
    expect(MockWebSocket.instances[1]?.url).toBe('wss://broker.test/mqtt');
    MockWebSocket.instances[0]?.open();
    MockWebSocket.instances[1]?.open();
    MockWebSocket.instances[0]?.receive(buildConnack({ sessionPresent: false, returnCode: 0 }));
    MockWebSocket.instances[1]?.receive(buildConnack({ sessionPresent: false, returnCode: 0 }));
    await Promise.all([pa, pb]);
  });

  it('rejects with AUTH on CONNACK return code 4/5', async () => {
    const client = makeClient();
    const promise = client.connect();
    const ws = MockWebSocket.instances[0];
    ws?.open();
    ws?.receive(buildConnack({ sessionPresent: false, returnCode: 4 }));
    await expect(promise).rejects.toMatchObject({ code: 'AUTH' });
    expect(client.state).toBe('closed');
  });

  it('rejects with PROTOCOL on CONNACK return code 1', async () => {
    const client = makeClient();
    const promise = client.connect();
    MockWebSocket.instances[0]?.open();
    MockWebSocket.instances[0]?.receive(buildConnack({ sessionPresent: false, returnCode: 1 }));
    await expect(promise).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('rejects with NETWORK when the socket errors before CONNACK', async () => {
    const client = makeClient();
    const promise = client.connect();
    MockWebSocket.instances[0]?.fail();
    await expect(promise).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('rejects with NETWORK when the socket closes before CONNACK', async () => {
    const client = makeClient();
    const promise = client.connect();
    MockWebSocket.instances[0]?.open();
    MockWebSocket.instances[0]?.serverClose();
    await expect(promise).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('rejects with TIMEOUT when CONNACK never arrives', async () => {
    vi.useFakeTimers();
    const client = makeClient({ connectTimeoutMs: 5000 });
    const promise = client.connect();
    MockWebSocket.instances[0]?.open();
    // Attach the rejection handler before advancing so the rejection is handled.
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(client.state).toBe('closed');
  });

  it('rejects a second connect() call', async () => {
    const client = makeClient();
    await connectClient(client);
    await expect(client.connect()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('publish', () => {
  it('sends a QoS 0 PUBLISH immediately (string payload)', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    await client.publish('s/t', 'hello');
    expect(ws.lastPacket()).toMatchObject({
      type: 'publish',
      topic: 's/t',
      qos: 0,
      retain: false,
      payload: new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]),
    });
  });

  it('sends a QoS 0 PUBLISH with binary payload and retain', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const payload = new Uint8Array([0x00, 0xff, 0x80]);
    await client.publish('s/bin', payload, { retain: true });
    const packet = ws.lastPacket();
    expect(packet).toMatchObject({ type: 'publish', qos: 0, retain: true, payload });
  });

  it('awaits PUBACK for QoS 1', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const promise = client.publish('s/t', 'x', { qos: 1 });
    const sent = ws.lastPacket();
    expect(sent).toMatchObject({ type: 'publish', qos: 1 });
    const packetId = (sent as { packetId: number }).packetId;
    expect(packetId).toBeGreaterThan(0);
    ws.receive(buildPubAck(packetId));
    await promise;
  });

  it('runs the full PUBREC 閳?PUBREL 閳?PUBCOMP handshake for QoS 2', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const promise = client.publish('s/t', 'x', { qos: 2 });
    const sent = ws.lastPacket();
    const packetId = (sent as { packetId: number }).packetId;
    ws.receive(buildPubRec(packetId));
    expect(ws.sentPackets().map((p) => p.type)).toEqual(['connect', 'publish', 'pubrel']);
    ws.receive(buildPubComp(packetId));
    await promise;
  });

  it('rejects with TIMEOUT when no PUBACK arrives', async () => {
    vi.useFakeTimers();
    const client = makeClient({ ackTimeoutMs: 1000 });
    await connectClient(client);
    const promise = client.publish('s/t', 'x', { qos: 1 });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(client.state).toBe('connected');
  });

  it('rejects with INVALID_ARGUMENT when not connected', async () => {
    const client = makeClient();
    await expect(client.publish('s/t', 'x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('subscribe / unsubscribe', () => {
  it('resolves with granted QoS codes on SUBACK', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const promise = client.subscribe([{ topic: 'a/b' }, { topic: 'c/#', qos: 2 }]);
    const sent = ws.lastPacket();
    expect(sent).toMatchObject({
      type: 'subscribe',
      subscriptions: [
        { topic: 'a/b', qos: 0 },
        { topic: 'c/#', qos: 2 },
      ],
    });
    const packetId = (sent as { packetId: number }).packetId;
    ws.receive(buildSubAck({ packetId, returnCodes: [0, 2] }));
    await expect(promise).resolves.toEqual([0, 2]);
  });

  it('resolves on UNSUBACK', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const promise = client.unsubscribe(['a/b', 'c/#']);
    const sent = ws.lastPacket();
    expect(sent).toMatchObject({ type: 'unsubscribe', topics: ['a/b', 'c/#'] });
    const packetId = (sent as { packetId: number }).packetId;
    ws.receive(buildUnsubAck(packetId));
    await promise;
  });

  it('rejects with TIMEOUT when no SUBACK arrives', async () => {
    vi.useFakeTimers();
    const client = makeClient({ ackTimeoutMs: 1000 });
    const ws = await connectClient(client);
    const promise = client.subscribe('x');
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(ws.sentPackets().at(-1)).toMatchObject({ type: 'subscribe' });
  });
});

describe('inbound messages', () => {
  it('delivers server PUBLISH as a message event with byte payload', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const messages: Array<[string, Uint8Array]> = [];
    client.on('message', (topic, payload) => messages.push([topic, payload]));
    ws.receive(
      buildPublish({ topic: 'in/0', payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]), qos: 0 }),
    );
    expect(messages).toEqual([['in/0', new Uint8Array([0xde, 0xad, 0xbe, 0xef])]]);
  });

  it('acks an inbound QoS 1 PUBLISH with PUBACK', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const messages: Array<[string, Uint8Array]> = [];
    client.on('message', (topic, payload) => messages.push([topic, payload]));
    ws.receive(buildPublish({ topic: 'in/1', payload: 'x', qos: 1, packetId: 11 }));
    expect(ws.lastPacket()).toEqual({ type: 'puback', packetId: 11 });
    expect(messages).toHaveLength(1);
  });

  it('runs the inbound QoS 2 handshake (PUBREC then PUBCOMP on PUBREL)', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    ws.receive(buildPublish({ topic: 'in/2', payload: 'y', qos: 2, packetId: 22 }));
    expect(ws.lastPacket()).toEqual({ type: 'pubrec', packetId: 22 });
    ws.receive(buildPubRel(22));
    expect(ws.lastPacket()).toEqual({ type: 'pubcomp', packetId: 22 });
  });

  it('emits an error event for malformed frames but keeps the connection', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const errors: MqttError[] = [];
    client.on('error', (error) => errors.push(error));
    ws.receive(new Uint8Array([0x36, 0x00])); // QoS 3 PUBLISH: invalid
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('PROTOCOL');
    expect(client.state).toBe('connected');
    const messages: Array<[string, Uint8Array]> = [];
    client.on('message', (topic, payload) => messages.push([topic, payload]));
    ws.receive(buildPublish({ topic: 'after/error', payload: 'ok', qos: 0 }));
    expect(messages).toHaveLength(1);
  });

  it('handles several packets arriving in a single frame', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const messages: string[] = [];
    client.on('message', (topic) => messages.push(topic));
    const a = buildPublish({ topic: 'm/1', payload: 'a', qos: 0 });
    const b = buildPublish({ topic: 'm/2', payload: 'b', qos: 0 });
    const c = buildPingResp();
    const frame = new Uint8Array(a.length + b.length + c.length);
    frame.set(a, 0);
    frame.set(b, a.length);
    frame.set(c, a.length + b.length);
    ws.receive(frame);
    expect(messages).toEqual(['m/1', 'm/2']);
  });
});

describe('ping', () => {
  it('sends PINGREQ on the keepalive interval and reacts to PINGRESP', async () => {
    vi.useFakeTimers();
    const client = makeClient({ keepaliveSec: 4 }); // interval = 2000ms
    const ws = await connectClient(client);
    expect(ws.sentPackets().filter((p) => p.type === 'pingreq')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.sentPackets().filter((p) => p.type === 'pingreq')).toHaveLength(1);
    ws.receive(buildPingResp());
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.sentPackets().filter((p) => p.type === 'pingreq')).toHaveLength(2);
    expect(client.state).toBe('connected');
  });

  it('fails the connection when the broker never answers PINGREQ', async () => {
    vi.useFakeTimers();
    const client = makeClient({ keepaliveSec: 4 });
    const ws = await connectClient(client);
    const errors: MqttError[] = [];
    const closed = vi.fn();
    client.on('error', (error) => errors.push(error));
    client.on('close', closed);
    await vi.advanceTimersByTimeAsync(2000); // PINGREQ #1, unanswered
    await vi.advanceTimersByTimeAsync(2000); // PINGREQ #2, still unanswered
    expect(ws.sentPackets().filter((p) => p.type === 'pingreq')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000); // ping timeout
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('NETWORK');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('closed');
  });

  it('does not ping when keepalive is disabled', async () => {
    vi.useFakeTimers();
    const client = makeClient({ keepaliveSec: 0 });
    const ws = await connectClient(client);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.sentPackets().filter((p) => p.type === 'pingreq')).toHaveLength(0);
    expect(client.state).toBe('connected');
  });
});

describe('close', () => {
  it('sends DISCONNECT, closes the socket, and emits close once', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const closed = vi.fn();
    client.on('close', closed);
    client.close();
    expect(ws.sentPackets().filter((p) => p.type === 'disconnect')).toHaveLength(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('closed');
  });

  it('is idempotent and end() is an alias', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const closed = vi.fn();
    client.on('close', closed);
    client.close();
    client.close();
    client.end();
    expect(ws.sentPackets().filter((p) => p.type === 'disconnect')).toHaveLength(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('emits close on an unexpected server-side close', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const closed = vi.fn();
    client.on('close', closed);
    ws.serverClose(1006);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('closed');
    await expect(client.publish('s/t', 'x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects in-flight acks when the connection drops', async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    const promise = client.publish('s/t', 'x', { qos: 1 });
    ws.serverClose();
    await expect(promise).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('stops listening after the returned unsubscribe function is called', async () => {
    const client = makeClient();
    await connectClient(client);
    const closed = vi.fn();
    const off = client.on('close', closed);
    off();
    client.close();
    expect(closed).not.toHaveBeenCalled();
  });
});

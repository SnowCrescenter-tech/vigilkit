import { MqttError } from './errors.js';

/**
 * MQTT 3.1.1 packet codec: pure encode/decode of every packet type plus a
 * tolerant stream parser. No I/O, no dependencies — fully deterministic and
 * unit-testable. Wire formats follow the OASIS "MQTT Version 3.1.1" standard
 * (29 October 2014).
 */

export type Qos = 0 | 1 | 2;

export const MAX_REMAINING_LENGTH = 268_435_455;
const MAX_VARINT_BYTES = 4;
const UTF8_MAX_LENGTH = 65_535;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const proto = (message: string): MqttError => new MqttError('PROTOCOL', message);
const invalid = (message: string): MqttError => new MqttError('INVALID_ARGUMENT', message);

/** MQTT 3.1.1 packet types (packet-type nibble of the fixed header). */
const PACKET_TYPE: Record<string, number> = {
  connect: 1,
  connack: 2,
  publish: 3,
  puback: 4,
  pubrec: 5,
  pubrel: 6,
  pubcomp: 7,
  subscribe: 8,
  suback: 9,
  unsubscribe: 10,
  unsuback: 11,
  pingreq: 12,
  pingresp: 13,
  disconnect: 14,
};

/** Mandatory flags nibble per packet type; -1 = any (PUBLISH). */
const REQUIRED_FLAGS: Record<number, number> = {
  1: 0,
  2: 0,
  3: -1,
  4: 0,
  5: 0,
  6: 2,
  7: 0,
  8: 2,
  9: 0,
  10: 2,
  11: 0,
  12: 0,
  13: 0,
  14: 0,
};

// ---------------------------------------------------------------------------
// Packet model
// ---------------------------------------------------------------------------

export interface WillMessage {
  topic: string;
  payload: string | Uint8Array;
  qos?: Qos;
  retain?: boolean;
}

export interface ConnectOptions {
  clientId: string;
  keepaliveSec?: number;
  cleanSession?: boolean;
  username?: string;
  password?: string;
  will?: WillMessage;
}

export interface PublishOptions {
  topic: string;
  payload: string | Uint8Array;
  qos?: Qos;
  retain?: boolean;
  dup?: boolean;
  /** Required when qos > 0. */
  packetId?: number;
}

export interface SubscribeOptions {
  packetId: number;
  subscriptions: Array<{ topic: string; qos: Qos }>;
}

export interface UnsubscribeOptions {
  packetId: number;
  topics: string[];
}

/** Parsed packet model. QoS 0 PUBLISH packets carry `packetId: 0`. */
export type MqttPacket =
  | {
      type: 'connect';
      clientId: string;
      keepaliveSec: number;
      cleanSession: boolean;
      username?: string;
      password?: string;
      will?: { topic: string; payload: Uint8Array; qos: Qos; retain: boolean };
    }
  | { type: 'connack'; sessionPresent: boolean; returnCode: number }
  | {
      type: 'publish';
      topic: string;
      packetId: number;
      qos: Qos;
      retain: boolean;
      dup: boolean;
      payload: Uint8Array;
    }
  | { type: 'puback'; packetId: number }
  | { type: 'pubrec'; packetId: number }
  | { type: 'pubrel'; packetId: number }
  | { type: 'pubcomp'; packetId: number }
  | { type: 'subscribe'; packetId: number; subscriptions: Array<{ topic: string; qos: Qos }> }
  | { type: 'suback'; packetId: number; returnCodes: number[] }
  | { type: 'unsubscribe'; packetId: number; topics: string[] }
  | { type: 'unsuback'; packetId: number }
  | { type: 'pingreq' }
  | { type: 'pingresp' }
  | { type: 'disconnect' };

export type MqttPacketType = MqttPacket['type'];

// ---------------------------------------------------------------------------
// Remaining length varint (7 bits per byte, continuation bit 0x80, max 4 bytes)
// ---------------------------------------------------------------------------

/**
 * Encodes a remaining length as the MQTT variable-length integer
 * (0 .. 268435455).
 */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > MAX_REMAINING_LENGTH) {
    throw invalid(
      `remaining length must be an integer in 0..${MAX_REMAINING_LENGTH}, got ${value}`,
    );
  }
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (remaining > 0);
  return new Uint8Array(out);
}

/**
 * Decodes a remaining length starting at `offset`.
 *
 * Returns `null` when the buffer ends in the middle of the varint (caller
 * should wait for more data). Throws an `MqttError('PROTOCOL')` when the
 * encoding is definitively malformed (continuation bit set on the 4th byte).
 */
export function decodeVarint(
  bytes: Uint8Array,
  offset = 0,
): { value: number; bytes: number } | null {
  let value = 0;
  let multiplier = 1;
  for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
    const byte = bytes[offset + i];
    if (byte === undefined) {
      return null;
    }
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return { value, bytes: i + 1 };
    }
    multiplier *= 128;
  }
  throw proto('malformed remaining length: continuation bit set on 4th byte');
}

// ---------------------------------------------------------------------------
// Low-level byte helpers
// ---------------------------------------------------------------------------

/** Reads length-prefixed fields from a packet body, throwing on overrun. */
class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  byte(): number {
    const byte = this.bytes[this.offset];
    if (byte === undefined) {
      throw proto('unexpected end of packet');
    }
    this.offset += 1;
    return byte;
  }

  u16(): number {
    const hi = this.byte();
    const lo = this.byte();
    return (hi << 8) | lo;
  }

  /** 2-byte length + UTF-8 bytes. */
  utf8(): string {
    const length = this.u16();
    if (this.offset + length > this.bytes.length) {
      throw proto('string length exceeds packet body');
    }
    const value = TEXT_DECODER.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  /** 2-byte length + raw binary bytes (copied). */
  binary(): Uint8Array {
    const length = this.u16();
    if (this.offset + length > this.bytes.length) {
      throw proto('binary length exceeds packet body');
    }
    const value = this.bytes.subarray(this.offset, this.offset + length).slice();
    this.offset += length;
    return value;
  }

  /** Remaining bytes (copied). */
  rest(): Uint8Array {
    const value = this.bytes.subarray(this.offset).slice();
    this.offset = this.bytes.length;
    return value;
  }
}

/** Assembles a packet body from length-prefixed fields. */
class ByteWriter {
  private chunks: Uint8Array[] = [];
  private total = 0;

  byte(value: number): void {
    this.chunks.push(new Uint8Array([value]));
    this.total += 1;
  }

  u16(value: number): void {
    this.chunks.push(new Uint8Array([(value >> 8) & 0xff, value & 0xff]));
    this.total += 2;
  }

  /** 2-byte length + UTF-8 bytes. */
  utf8(value: string): void {
    const bytes = TEXT_ENCODER.encode(value);
    if (bytes.length > UTF8_MAX_LENGTH) {
      throw invalid('UTF-8 string exceeds 65535 bytes');
    }
    this.chunks.push(new Uint8Array([(bytes.length >> 8) & 0xff, bytes.length & 0xff]));
    this.chunks.push(bytes);
    this.total += 2 + bytes.length;
  }

  /** 2-byte length + raw binary bytes. */
  binary(value: Uint8Array): void {
    if (value.length > UTF8_MAX_LENGTH) {
      throw invalid('binary field exceeds 65535 bytes');
    }
    this.chunks.push(new Uint8Array([(value.length >> 8) & 0xff, value.length & 0xff]));
    this.chunks.push(value);
    this.total += 2 + value.length;
  }

  raw(value: Uint8Array): void {
    this.chunks.push(value);
    this.total += value.length;
  }

  get result(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

const toBytes = (payload: string | Uint8Array): Uint8Array =>
  typeof payload === 'string' ? TEXT_ENCODER.encode(payload) : payload;

/** Wraps a body with the fixed header (type << 4 | flags + remaining length). */
function frame(packetType: number, flags: number, body: Uint8Array): Uint8Array {
  const lengthBytes = encodeVarint(body.length);
  const out = new Uint8Array(1 + lengthBytes.length + body.length);
  out[0] = (packetType << 4) | flags;
  out.set(lengthBytes, 1);
  out.set(body, 1 + lengthBytes.length);
  return out;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** CONNECT: protocol name 'MQTT', level 4, connect-flags layout, then payload. */
export function buildConnect(options: ConnectOptions): Uint8Array {
  const keepaliveSec = options.keepaliveSec ?? 60;
  const cleanSession = options.cleanSession ?? true;
  const will = options.will;
  if (will !== undefined && (will.qos ?? 0) > 2) {
    throw invalid('will qos must be 0, 1 or 2');
  }

  let flags = 0;
  if (cleanSession) {
    flags |= 0x02;
  }
  if (will !== undefined) {
    flags |= 0x04;
    flags |= (will.qos ?? 0) << 3;
    if (will.retain ?? false) {
      flags |= 0x20;
    }
  }
  if (options.username !== undefined) {
    flags |= 0x80;
  }
  if (options.password !== undefined) {
    flags |= 0x40;
  }

  const body = new ByteWriter();
  body.utf8('MQTT');
  body.byte(0x04);
  body.byte(flags);
  body.u16(keepaliveSec);
  body.utf8(options.clientId);
  if (will !== undefined) {
    body.utf8(will.topic);
    body.binary(toBytes(will.payload));
  }
  if (options.username !== undefined) {
    body.utf8(options.username);
  }
  if (options.password !== undefined) {
    body.utf8(options.password);
  }
  return frame(PACKET_TYPE['connect'] ?? 1, 0, body.result);
}

/** CONNACK: session-present bit + return code. */
export function buildConnack(options: { sessionPresent: boolean; returnCode: number }): Uint8Array {
  const body = new ByteWriter();
  body.byte(options.sessionPresent ? 1 : 0);
  body.byte(options.returnCode);
  return frame(PACKET_TYPE['connack'] ?? 2, 0, body.result);
}

/** PUBLISH: topic + optional packet id + payload. QoS 0 omits the packet id. */
export function buildPublish(options: PublishOptions): Uint8Array {
  const qos = options.qos ?? 0;
  if (qos < 0 || qos > 2) {
    throw invalid('qos must be 0, 1 or 2');
  }
  if (options.topic.length === 0) {
    throw invalid('topic must not be empty');
  }
  if (
    qos > 0 &&
    (options.packetId === undefined || options.packetId < 1 || options.packetId > 0xffff)
  ) {
    throw invalid('packet id (1..65535) is required for qos 1/2 publishes');
  }

  let flags = qos << 1;
  if (options.retain ?? false) {
    flags |= 0x01;
  }
  if (options.dup ?? false) {
    flags |= 0x08;
  }

  const body = new ByteWriter();
  body.utf8(options.topic);
  if (qos > 0) {
    body.u16(options.packetId as number);
  }
  body.raw(toBytes(options.payload));
  return frame(PACKET_TYPE['publish'] ?? 3, flags, body.result);
}

const buildPacketIdOnly = (type: string, flags: number, packetId: number): Uint8Array => {
  if (!Number.isInteger(packetId) || packetId < 1 || packetId > 0xffff) {
    throw invalid('packet id must be an integer in 1..65535');
  }
  const body = new ByteWriter();
  body.u16(packetId);
  return frame(PACKET_TYPE[type] ?? 0, flags, body.result);
};

export const buildPubAck = (packetId: number): Uint8Array =>
  buildPacketIdOnly('puback', 0, packetId);
export const buildPubRec = (packetId: number): Uint8Array =>
  buildPacketIdOnly('pubrec', 0, packetId);
export const buildPubRel = (packetId: number): Uint8Array =>
  buildPacketIdOnly('pubrel', 2, packetId);
export const buildPubComp = (packetId: number): Uint8Array =>
  buildPacketIdOnly('pubcomp', 0, packetId);

/** SUBSCRIBE: packet id + (topic filter, requested QoS) pairs. Flags 0x02. */
export function buildSubscribe(options: SubscribeOptions): Uint8Array {
  if (options.subscriptions.length === 0) {
    throw invalid('subscribe requires at least one topic filter');
  }
  const body = new ByteWriter();
  body.u16(options.packetId);
  for (const subscription of options.subscriptions) {
    if (subscription.qos < 0 || subscription.qos > 2) {
      throw invalid('requested qos must be 0, 1 or 2');
    }
    if (subscription.topic.length === 0) {
      throw invalid('topic filter must not be empty');
    }
    body.utf8(subscription.topic);
    body.byte(subscription.qos);
  }
  return frame(PACKET_TYPE['subscribe'] ?? 8, 2, body.result);
}

/** SUBACK: packet id + one return code (0/1/2 granted QoS, 0x80 failure) per topic. */
export function buildSubAck(options: { packetId: number; returnCodes: number[] }): Uint8Array {
  if (options.returnCodes.length === 0) {
    throw invalid('suback requires at least one return code');
  }
  const body = new ByteWriter();
  body.u16(options.packetId);
  for (const code of options.returnCodes) {
    if (code !== 0 && code !== 1 && code !== 2 && code !== 0x80) {
      throw invalid(`invalid suback return code 0x${code.toString(16)}`);
    }
    body.byte(code);
  }
  return frame(PACKET_TYPE['suback'] ?? 9, 0, body.result);
}

/** UNSUBSCRIBE: packet id + topic filters. Flags 0x02. */
export function buildUnsubscribe(options: UnsubscribeOptions): Uint8Array {
  if (options.topics.length === 0) {
    throw invalid('unsubscribe requires at least one topic filter');
  }
  const body = new ByteWriter();
  body.u16(options.packetId);
  for (const topic of options.topics) {
    body.utf8(topic);
  }
  return frame(PACKET_TYPE['unsubscribe'] ?? 10, 2, body.result);
}

export const buildUnsubAck = (packetId: number): Uint8Array =>
  buildPacketIdOnly('unsuback', 0, packetId);

export const buildPingReq = (): Uint8Array => frame(PACKET_TYPE['pingreq'] ?? 12, 0, new Uint8Array(0));
export const buildPingResp = (): Uint8Array =>
  frame(PACKET_TYPE['pingresp'] ?? 13, 0, new Uint8Array(0));
export const buildDisconnect = (): Uint8Array =>
  frame(PACKET_TYPE['disconnect'] ?? 14, 0, new Uint8Array(0));

/** Encodes any parsed packet back to its wire bytes. */
export function encodePacket(packet: MqttPacket): Uint8Array {
  switch (packet.type) {
    case 'connect':
      return buildConnect({
        clientId: packet.clientId,
        keepaliveSec: packet.keepaliveSec,
        cleanSession: packet.cleanSession,
        username: packet.username,
        password: packet.password,
        will:
          packet.will === undefined
            ? undefined
            : {
                topic: packet.will.topic,
                payload: packet.will.payload,
                qos: packet.will.qos,
                retain: packet.will.retain,
              },
      });
    case 'connack':
      return buildConnack({ sessionPresent: packet.sessionPresent, returnCode: packet.returnCode });
    case 'publish':
      return buildPublish({
        topic: packet.topic,
        payload: packet.payload,
        qos: packet.qos,
        retain: packet.retain,
        dup: packet.dup,
        packetId: packet.qos === 0 ? undefined : packet.packetId,
      });
    case 'puback':
      return buildPubAck(packet.packetId);
    case 'pubrec':
      return buildPubRec(packet.packetId);
    case 'pubrel':
      return buildPubRel(packet.packetId);
    case 'pubcomp':
      return buildPubComp(packet.packetId);
    case 'subscribe':
      return buildSubscribe({ packetId: packet.packetId, subscriptions: packet.subscriptions });
    case 'suback':
      return buildSubAck({ packetId: packet.packetId, returnCodes: packet.returnCodes });
    case 'unsubscribe':
      return buildUnsubscribe({ packetId: packet.packetId, topics: packet.topics });
    case 'unsuback':
      return buildUnsubAck(packet.packetId);
    case 'pingreq':
      return buildPingReq();
    case 'pingresp':
      return buildPingResp();
    case 'disconnect':
      return buildDisconnect();
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseConnectBody(body: Uint8Array): MqttPacket {
  const reader = new Reader(body);
  const name = reader.utf8();
  if (name !== 'MQTT') {
    throw proto(`unexpected protocol name '${name}'`);
  }
  const level = reader.byte();
  if (level !== 4) {
    throw proto(`unsupported protocol level ${level} (expected 4 = MQTT 3.1.1)`);
  }
  const flags = reader.byte();
  if ((flags & 0x01) !== 0) {
    throw proto('connect flags reserved bit must be 0');
  }
  const usernameFlag = (flags & 0x80) !== 0;
  const passwordFlag = (flags & 0x40) !== 0;
  const willRetain = (flags & 0x20) !== 0;
  const willQosRaw = (flags >> 3) & 0x03;
  const willFlag = (flags & 0x04) !== 0;
  const cleanSession = (flags & 0x02) !== 0;
  if (willQosRaw === 3) {
    throw proto('will qos must not be 3');
  }
  const willQos = willQosRaw as Qos;
  if (!willFlag && (willQos !== 0 || willRetain)) {
    throw proto('will qos/retain flags require the will flag');
  }

  const keepaliveSec = reader.u16();
  const clientId = reader.utf8();
  let will: { topic: string; payload: Uint8Array; qos: Qos; retain: boolean } | undefined;
  if (willFlag) {
    will = { topic: reader.utf8(), payload: reader.binary(), qos: willQos, retain: willRetain };
  }
  const username = usernameFlag ? reader.utf8() : undefined;
  const password = passwordFlag ? TEXT_DECODER.decode(reader.binary()) : undefined;
  return {
    type: 'connect',
    clientId,
    keepaliveSec,
    cleanSession,
    username,
    password,
    will,
  };
}

function parsePublishBody(body: Uint8Array, flags: number): MqttPacket {
  const qosRaw = (flags >> 1) & 0x03;
  if (qosRaw === 3) {
    throw proto('publish qos must not be 3');
  }
  const qos = qosRaw as Qos;
  const reader = new Reader(body);
  const topic = reader.utf8();
  if (topic.length === 0) {
    throw proto('publish topic must not be empty');
  }
  const packetId = qos > 0 ? reader.u16() : 0;
  return {
    type: 'publish',
    topic,
    packetId,
    qos,
    retain: (flags & 0x01) !== 0,
    dup: (flags & 0x08) !== 0,
    payload: reader.rest(),
  };
}

function parseSubscribeBody(body: Uint8Array): MqttPacket {
  const reader = new Reader(body);
  const packetId = reader.u16();
  const subscriptions: Array<{ topic: string; qos: Qos }> = [];
  while (reader.remaining > 0) {
    const topic = reader.utf8();
    const qos = reader.byte();
    if (qos > 2) {
      throw proto(`invalid requested qos ${qos}`);
    }
    subscriptions.push({ topic, qos: qos as Qos });
  }
  if (subscriptions.length === 0) {
    throw proto('subscribe requires at least one topic filter');
  }
  return { type: 'subscribe', packetId, subscriptions };
}

function parseSubAckBody(body: Uint8Array): MqttPacket {
  const reader = new Reader(body);
  const packetId = reader.u16();
  const returnCodes: number[] = [];
  while (reader.remaining > 0) {
    const code = reader.byte();
    if (code !== 0 && code !== 1 && code !== 2 && code !== 0x80) {
      throw proto(`invalid suback return code 0x${code.toString(16)}`);
    }
    returnCodes.push(code);
  }
  if (returnCodes.length === 0) {
    throw proto('suback requires at least one return code');
  }
  return { type: 'suback', packetId, returnCodes };
}

function parseUnsubscribeBody(body: Uint8Array): MqttPacket {
  const reader = new Reader(body);
  const packetId = reader.u16();
  const topics: string[] = [];
  while (reader.remaining > 0) {
    topics.push(reader.utf8());
  }
  if (topics.length === 0) {
    throw proto('unsubscribe requires at least one topic filter');
  }
  return { type: 'unsubscribe', packetId, topics };
}

const parsePacketIdBody = (type: MqttPacketType, body: Uint8Array): MqttPacket => {
  if (body.length !== 2) {
    throw proto(`${type} body must be exactly a 2-byte packet id`);
  }
  return { type, packetId: ((body[0] ?? 0) << 8) | (body[1] ?? 0) } as MqttPacket;
};

/**
 * Parses one complete MQTT frame (fixed header + full body). Throws an
 * `MqttError('PROTOCOL')` on any malformed content; use `PacketStream` for
 * buffered, non-throwing stream parsing.
 */
export function parsePacket(frame: Uint8Array): MqttPacket {
  const first = frame[0];
  if (first === undefined) {
    throw proto('empty frame');
  }
  const type = first >> 4;
  const flags = first & 0x0f;
  const requiredFlags = REQUIRED_FLAGS[type];
  if (requiredFlags === undefined) {
    throw proto(`unknown packet type ${type}`);
  }
  if (requiredFlags !== -1 && flags !== requiredFlags) {
    throw proto(`packet type ${type} requires flags 0x${requiredFlags.toString(16)}, got 0x${flags.toString(16)}`);
  }
  const varint = decodeVarint(frame, 1);
  if (varint === null) {
    throw proto('truncated remaining length');
  }
  const expectedLength = 1 + varint.bytes + varint.value;
  if (frame.length !== expectedLength) {
    throw proto(
      `frame length ${frame.length} does not match remaining length ${expectedLength - 1 - varint.bytes}`,
    );
  }
  const body = frame.subarray(1 + varint.bytes);

  switch (type) {
    case 1:
      return parseConnectBody(body);
    case 2: {
      if (body.length !== 2) {
        throw proto('connack body must be exactly 2 bytes');
      }
      return {
        type: 'connack',
        sessionPresent: ((body[0] ?? 0) & 0x01) === 1,
        returnCode: body[1] ?? 0,
      };
    }
    case 3:
      return parsePublishBody(body, flags);
    case 4:
      return parsePacketIdBody('puback', body);
    case 5:
      return parsePacketIdBody('pubrec', body);
    case 6:
      return parsePacketIdBody('pubrel', body);
    case 7:
      return parsePacketIdBody('pubcomp', body);
    case 8:
      return parseSubscribeBody(body);
    case 9:
      return parseSubAckBody(body);
    case 10:
      return parseUnsubscribeBody(body);
    case 11:
      return parsePacketIdBody('unsuback', body);
    case 12:
      if (body.length !== 0) {
        throw proto('pingreq must have an empty body');
      }
      return { type: 'pingreq' };
    case 13:
      if (body.length !== 0) {
        throw proto('pingresp must have an empty body');
      }
      return { type: 'pingresp' };
    case 14:
      if (body.length !== 0) {
        throw proto('disconnect must have an empty body');
      }
      return { type: 'disconnect' };
    default:
      throw proto(`unknown packet type ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Tolerant stream parser
// ---------------------------------------------------------------------------

export interface PacketStreamOptions {
  /** Called for every malformed frame that is skipped. */
  onError?: (error: MqttError) => void;
}

type FixedHeader = { error: MqttError } | { frameLength: number } | null;

/** Decodes the fixed header of the frame at the front of `buffer`. */
function readFixedHeader(buffer: Uint8Array): FixedHeader {
  if (buffer.length === 0) {
    return null;
  }
  try {
    const varint = decodeVarint(buffer, 1);
    if (varint === null) {
      return null;
    }
    return { frameLength: 1 + varint.bytes + varint.value };
  } catch (error) {
    if (error instanceof MqttError) {
      return { error };
    }
    throw error;
  }
}

/**
 * Buffers an incoming byte stream and yields complete MQTT packets as they
 * arrive. `push()` never throws: partial frames are buffered, and malformed
 * frames are skipped with the error recorded in `errors` (and reported through
 * the optional `onError` callback) while parsing continues on the next frame.
 */
export class PacketStream {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly onErrorCallback?: (error: MqttError) => void;
  /** Errors collected from skipped malformed frames. */
  readonly errors: MqttError[] = [];

  constructor(options?: PacketStreamOptions) {
    this.onErrorCallback = options?.onError;
  }

  /** Feeds bytes; returns every complete packet contained in them. */
  push(bytes: Uint8Array): MqttPacket[] {
    const packets: MqttPacket[] = [];
    this.buffer = concatBytes(this.buffer, bytes);
    for (;;) {
      const header = readFixedHeader(this.buffer);
      if (header === null) {
        break;
      }
      if ('error' in header) {
        // Malformed remaining length: the frame boundary is unknowable, so
        // drop the buffered bytes and resync on the next push.
        this.recordError(header.error);
        this.buffer = new Uint8Array(0);
        break;
      }
      if (this.buffer.length < header.frameLength) {
        break; // frame body not complete yet
      }
      const frame = this.buffer.subarray(0, header.frameLength);
      this.buffer = this.buffer.subarray(header.frameLength);
      try {
        packets.push(parsePacket(frame));
      } catch (error) {
        this.recordError(
          error instanceof MqttError ? error : new MqttError('PROTOCOL', String(error)),
        );
      }
    }
    return packets;
  }

  private recordError(error: MqttError): void {
    this.errors.push(error);
    this.onErrorCallback?.(error);
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b.slice();
  }
  if (b.length === 0) {
    return a.slice();
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

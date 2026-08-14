import { describe, expect, it, vi } from 'vitest';
import {
  PacketStream,
  buildConnack,
  buildConnect,
  buildDisconnect,
  buildPingReq,
  buildPingResp,
  buildPubAck,
  buildPubComp,
  buildPubRec,
  buildPubRel,
  buildPublish,
  buildSubAck,
  buildSubscribe,
  buildUnsubscribe,
  decodeVarint,
  encodePacket,
  encodeVarint,
  parsePacket,
  type MqttPacket,
} from './packet.js';
import { MqttError } from './errors.js';

/** Deterministic PRNG (mulberry32) so chunked-stream tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const roundTrip = (packet: MqttPacket): void => {
  expect(parsePacket(encodePacket(packet))).toEqual(packet);
};

describe('remaining length varint', () => {
  const cases: Array<[number, number[]]> = [
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [16_383, [0xff, 0x7f]],
    [16_384, [0x80, 0x80, 0x01]],
    [2_097_151, [0xff, 0xff, 0x7f]],
    [268_435_455, [0xff, 0xff, 0xff, 0x7f]],
  ];

  it.each(cases)('encodes %i as %j', (value, expected) => {
    expect(Array.from(encodeVarint(value))).toEqual(expected);
  });

  it.each(cases)('decodes %i back from its encoding', (value) => {
    const decoded = decodeVarint(encodeVarint(value));
    expect(decoded).toEqual({ value, bytes: encodeVarint(value).length });
  });

  it('rejects out-of-range lengths', () => {
    expect(() => encodeVarint(-1)).toThrowError(MqttError);
    expect(() => encodeVarint(268_435_456)).toThrowError(MqttError);
    expect(() => encodeVarint(1.5)).toThrowError(MqttError);
    expect(() => encodeVarint(268_435_456)).toThrowError(/268435455/);
  });

  it('returns null when the varint is incomplete (needs more bytes)', () => {
    expect(decodeVarint(new Uint8Array([]))).toBeNull();
    expect(decodeVarint(new Uint8Array([0x80]))).toBeNull();
    expect(decodeVarint(new Uint8Array([0x80, 0x80]))).toBeNull();
  });

  it('throws on a malformed varint (continuation bit on the 4th byte)', () => {
    // 4 bytes each with the continuation bit set: cannot be a valid length.
    expect(() => decodeVarint(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x7f]))).toThrowError(
      MqttError,
    );
    expect(() => decodeVarint(new Uint8Array([0x80, 0x80, 0x80, 0x80]))).toThrowError(MqttError);
  });
});

describe('fixed header', () => {
  it('encodes packet type and flags in the first byte', () => {
    expect(Array.from(buildPingReq())).toEqual([0xc0, 0x00]);
    expect(Array.from(buildPingResp())).toEqual([0xd0, 0x00]);
    expect(Array.from(buildDisconnect())).toEqual([0xe0, 0x00]);
    expect(Array.from(buildPubAck(5))).toEqual([0x40, 0x02, 0x00, 0x05]);
    // PUBREL carries the mandatory flags nibble 0x02.
    expect(Array.from(buildPubRel(5))).toEqual([0x62, 0x02, 0x00, 0x05]);
    expect(Array.from(buildPubRec(5))).toEqual([0x50, 0x02, 0x00, 0x05]);
    expect(Array.from(buildPubComp(5))).toEqual([0x70, 0x02, 0x00, 0x05]);
    expect(Array.from(buildConnack({ sessionPresent: false, returnCode: 0 }))).toEqual([
      0x20, 0x02, 0x00, 0x00,
    ]);
  });

  it('rejects reserved flag bits on packets whose flags must be zero', () => {
    // PINGREQ with flags 0x0F.
    expect(() => parsePacket(new Uint8Array([0xcf, 0x00]))).toThrowError(MqttError);
    // CONNACK with flags 0x01.
    expect(() => parsePacket(new Uint8Array([0x21, 0x02, 0x00, 0x00]))).toThrowError(MqttError);
    // SUBSCRIBE without the mandatory 0x02 flags nibble.
    expect(() => parsePacket(new Uint8Array([0x80, 0x00]))).toThrowError(MqttError);
    // PUBREL without the mandatory 0x02 flags nibble.
    expect(() => parsePacket(new Uint8Array([0x60, 0x02, 0x00, 0x01]))).toThrowError(MqttError);
  });

  it('rejects an unknown packet type', () => {
    expect(() => parsePacket(new Uint8Array([0xf0, 0x00]))).toThrowError(MqttError);
    expect(() => parsePacket(new Uint8Array([0x00, 0x00]))).toThrowError(MqttError);
  });

  it('rejects a frame whose body length does not match the remaining length', () => {
    // Declares remaining length 5 but only carries 3 body bytes.
    const frame = new Uint8Array([0x30, 0x05, 0x00, 0x01, 0x61]);
    expect(() => parsePacket(frame)).toThrowError(MqttError);
  });
});

describe('CONNECT', () => {
  it('builds the exact wire bytes', () => {
    const frame = buildConnect({ clientId: 'abc', keepaliveSec: 60, cleanSession: true });
    expect(Array.from(frame)).toEqual([
      0x10, 0x0f, 0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c, 0x00, 0x03, 0x61,
      0x62, 0x63,
    ]);
  });

  it('sets username/password/will flags per the 3.1.1 connect-flags layout', () => {
    const frame = buildConnect({
      clientId: 'c',
      keepaliveSec: 30,
      cleanSession: false,
      username: 'u',
      password: 'p',
      will: { topic: 't', payload: Uint8Array.of(1, 2), qos: 2, retain: true },
    });
    // flags byte: username 0x80 | password 0x40 | will-retain 0x20 | will-qos(2<<3) 0x10 | will 0x04
    expect(frame[9]).toBe(0xf4);
    expect(frame[8]).toBe(0x04); // protocol level 4
    const packet = parsePacket(frame);
    expect(packet).toMatchObject({
      type: 'connect',
      clientId: 'c',
      keepaliveSec: 30,
      cleanSession: false,
      username: 'u',
      password: 'p',
      will: { topic: 't', payload: Uint8Array.of(1, 2), qos: 2, retain: true },
    });
  });

  it('defaults keepalive/cleanSession and omits optional fields', () => {
    const packet = parsePacket(buildConnect({ clientId: 'x' }));
    expect(packet).toMatchObject({ type: 'connect', keepaliveSec: 60, cleanSession: true });
    expect(packet.type === 'connect' ? packet.username : undefined).toBeUndefined();
  });

  it('rejects a non-MQTT protocol name / wrong level / reserved flag', () => {
    const base = buildConnect({ clientId: 'x' });
    const badName = base.slice();
    badName[2] = 0x00;
    badName[3] = 0x03; // "MQX" is still 3 bytes...
    badName[5] = 0x58; // 'X' instead of 'T'
    expect(() => parsePacket(badName)).toThrowError(MqttError);

    const badLevel = base.slice();
    badLevel[8] = 0x03; // MQTT 3.1 level, not 3.1.1
    expect(() => parsePacket(badLevel)).toThrowError(MqttError);

    const badFlags = base.slice();
    badFlags[9] = 0x03; // reserved bit 0 set
    expect(() => parsePacket(badFlags)).toThrowError(MqttError);
  });

  it('rejects a will QoS of 3', () => {
    const frame = buildConnect({ clientId: 'x' });
    const f = frame.slice();
    f[9] = 0x02 | 0x04 | (3 << 3); // clean session + will flag + will-qos 3
    expect(() => parsePacket(f)).toThrowError(MqttError);
  });

  it('round-trips', () => {
    roundTrip({
      type: 'connect',
      clientId: 'dev-42',
      keepaliveSec: 120,
      cleanSession: true,
      username: 'admin',
      password: 'secret',
      will: { topic: 'dev/42/status', payload: new Uint8Array([0xde, 0xad]), qos: 1, retain: true },
    });
    roundTrip({ type: 'connect', clientId: '', keepaliveSec: 0, cleanSession: false });
  });
});

describe('CONNACK', () => {
  it('parses session-present and return code', () => {
    expect(parsePacket(new Uint8Array([0x20, 0x02, 0x01, 0x00]))).toEqual({
      type: 'connack',
      sessionPresent: true,
      returnCode: 0,
    });
    expect(parsePacket(new Uint8Array([0x20, 0x02, 0x00, 0x05]))).toEqual({
      type: 'connack',
      sessionPresent: false,
      returnCode: 5,
    });
  });

  it('rejects a CONNACK with a body longer than 2 bytes', () => {
    expect(() => parsePacket(new Uint8Array([0x20, 0x03, 0x00, 0x00, 0x00]))).toThrowError(
      MqttError,
    );
  });

  it('round-trips', () => {
    roundTrip({ type: 'connack', sessionPresent: true, returnCode: 0 });
    roundTrip({ type: 'connack', sessionPresent: false, returnCode: 4 });
  });
});

describe('PUBLISH', () => {
  it('builds a QoS 0 frame without a packet id', () => {
    const frame = buildPublish({ topic: 'a/b', payload: 'hi' });
    expect(frame[0]).toBe(0x30);
    expect(frame[1]).toBe(7); // topic 2+3 + payload 2
    expect(Array.from(frame.slice(2))).toEqual([
      0x00, 0x03, 0x61, 0x2f, 0x62, 0x68, 0x69,
    ]);
  });

  it('builds QoS 1/2 frames with a packet id and retain/dup flag bits', () => {
    // QoS nibble is (qos << 1): 0x32 = qos 1, 0x34 = qos 2, retain 0x01, dup 0x08.
    expect(buildPublish({ topic: 't', payload: 'x', qos: 1, packetId: 7 })[0]).toBe(0x32);
    expect(buildPublish({ topic: 't', payload: 'x', qos: 2, packetId: 7, retain: true })[0]).toBe(
      0x35,
    );
    expect(buildPublish({ topic: 't', payload: 'x', qos: 1, packetId: 7, dup: true })[0]).toBe(
      0x3a,
    );
  });

  it('requires a packet id for QoS > 0', () => {
    expect(() => buildPublish({ topic: 't', payload: 'x', qos: 1 })).toThrowError(MqttError);
    expect(() => buildPublish({ topic: 't', payload: 'x', qos: 2 })).toThrowError(MqttError);
  });

  it('parses QoS 0/1/2 with binary payloads byte-exactly', () => {
    const payload = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x00, 0x01]);
    const frame = buildPublish({ topic: 'dev/1/temp', payload, qos: 0 });
    const parsed = parsePacket(frame);
    expect(parsed).toEqual({
      type: 'publish',
      topic: 'dev/1/temp',
      packetId: 0,
      qos: 0,
      retain: false,
      dup: false,
      payload,
    });
    expect((parsed as { payload: Uint8Array }).payload).not.toBe(payload);

    const qos1 = parsePacket(buildPublish({ topic: 't', payload, qos: 1, packetId: 0x1234 }));
    expect(qos1).toMatchObject({ qos: 1, packetId: 0x1234, payload });

    const qos2 = parsePacket(
      buildPublish({ topic: 't', payload: Uint8Array.of(9, 8), qos: 2, packetId: 1, retain: true }),
    );
    expect(qos2).toMatchObject({ qos: 2, retain: true, payload: Uint8Array.of(9, 8) });
  });

  it('rejects QoS 3 and an empty topic', () => {
    expect(() => parsePacket(new Uint8Array([0x36, 0x00]))).toThrowError(MqttError);
    expect(() => buildPublish({ topic: '', payload: 'x', qos: 0 })).toThrowError(MqttError);
  });

  it('round-trips', () => {
    roundTrip({ type: 'publish', topic: 'a/b/c', packetId: 0, qos: 0, retain: false, dup: false, payload: new Uint8Array() });
    roundTrip({ type: 'publish', topic: 'a/b/c', packetId: 42, qos: 1, retain: false, dup: true, payload: new Uint8Array([1, 2, 3]) });
    roundTrip({ type: 'publish', topic: '$SYS/broker/load', packetId: 0xffff, qos: 2, retain: true, dup: false, payload: new Uint8Array([0x00, 0xff]) });
  });
});

describe('acknowledgement packets', () => {
  it.each([
    [{ type: 'puback', packetId: 1 } as MqttPacket],
    [{ type: 'pubrec', packetId: 2 } as MqttPacket],
    [{ type: 'pubrel', packetId: 3 } as MqttPacket],
    [{ type: 'pubcomp', packetId: 4 } as MqttPacket],
  ])('round-trips %j', (packet) => {
    roundTrip(packet);
  });

  it('rejects acks whose body is not exactly 2 bytes', () => {
    expect(() => parsePacket(new Uint8Array([0x40, 0x03, 0x00, 0x01, 0x00]))).toThrowError(
      MqttError,
    );
  });
});

describe('SUBSCRIBE / SUBACK', () => {
  it('builds a subscribe with the mandatory 0x02 flags', () => {
    const frame = buildSubscribe({
      packetId: 1,
      subscriptions: [
        { topic: 'a/b', qos: 1 },
        { topic: 'c/#', qos: 2 },
      ],
    });
    expect(frame[0]).toBe(0x82);
    expect(frame[1]).toBe(14); // 2 id + (5 + 1) + (5 + 1)
    expect(parsePacket(frame)).toEqual({
      type: 'subscribe',
      packetId: 1,
      subscriptions: [
        { topic: 'a/b', qos: 1 },
        { topic: 'c/#', qos: 2 },
      ],
    });
  });

  it('rejects a subscribe with no subscriptions or QoS 3', () => {
    expect(() => buildSubscribe({ packetId: 1, subscriptions: [] })).toThrowError(MqttError);
    const frame = buildSubscribe({ packetId: 1, subscriptions: [{ topic: 't', qos: 1 }] });
    const f = frame.slice();
    f[f.length - 1] = 3;
    expect(() => parsePacket(f)).toThrowError(MqttError);
  });

  it('parses SUBACK return codes, including 0x80 failure', () => {
    const packet = parsePacket(buildSubAck({ packetId: 9, returnCodes: [0, 2, 0x80] }));
    expect(packet).toEqual({ type: 'suback', packetId: 9, returnCodes: [0, 2, 0x80] });
    expect(() => buildSubAck({ packetId: 1, returnCodes: [] })).toThrowError(MqttError);
    expect(() => parsePacket(new Uint8Array([0x90, 0x04, 0x00, 0x01, 0x00, 0x03]))).toThrowError(
      MqttError,
    );
  });

  it('round-trips', () => {
    roundTrip({ type: 'subscribe', packetId: 7, subscriptions: [{ topic: 'x/#', qos: 2 }] });
    roundTrip({ type: 'suback', packetId: 7, returnCodes: [0, 1, 2, 0x80] });
  });
});

describe('UNSUBSCRIBE / UNSUBACK', () => {
  it('round-trips', () => {
    roundTrip({ type: 'unsubscribe', packetId: 3, topics: ['a/b', 'c/#'] });
    roundTrip({ type: 'unsuback', packetId: 3 });
  });

  it('rejects an empty unsubscribe and a malformed unsuback', () => {
    expect(() => buildUnsubscribe({ packetId: 1, topics: [] })).toThrowError(MqttError);
    // UNSUBACK must carry exactly a 2-byte packet id.
    expect(() => parsePacket(new Uint8Array([0xb0, 0x01, 0x00]))).toThrowError(MqttError);
    expect(() => parsePacket(new Uint8Array([0xb0, 0x04, 0x00, 0x01, 0x00, 0x00]))).toThrowError(
      MqttError,
    );
  });
});

describe('PINGREQ / PINGRESP / DISCONNECT', () => {
  it.each([
    [{ type: 'pingreq' } as MqttPacket],
    [{ type: 'pingresp' } as MqttPacket],
    [{ type: 'disconnect' } as MqttPacket],
  ])('round-trips %j', (packet) => {
    roundTrip(packet);
  });

  it('rejects them with a non-empty body', () => {
    expect(() => parsePacket(new Uint8Array([0xc0, 0x01, 0x00]))).toThrowError(MqttError);
    expect(() => parsePacket(new Uint8Array([0xe0, 0x01, 0x00]))).toThrowError(MqttError);
  });
});

describe('PacketStream', () => {
  const connack = buildConnack({ sessionPresent: false, returnCode: 0 });
  const pingreq = buildPingReq();
  const publish = buildPublish({
    topic: 'sensors/1',
    payload: new Uint8Array(128).fill(0xab),
    qos: 1,
    packetId: 77,
  });
  const puback = buildPubAck(77);

  it('returns complete packets fed in a single push', () => {
    const stream = new PacketStream();
    const packets = stream.push(concat(pingreq, publish, puback));
    expect(packets).toEqual([
      { type: 'pingreq' },
      parsePacket(publish),
      { type: 'puback', packetId: 77 },
    ]);
  });

  it('buffers partial frames when fed byte by byte', () => {
    const stream = new PacketStream();
    const all = concat(connack, publish, puback);
    const packets: MqttPacket[] = [];
    for (let i = 0; i < all.length; i += 1) {
      packets.push(...stream.push(all.subarray(i, i + 1)));
    }
    expect(packets).toEqual([parsePacket(connack), parsePacket(publish), parsePacket(puback)]);
    expect(stream.errors).toHaveLength(0);
  });

  it('buffers partial frames when fed in random chunks', () => {
    const stream = new PacketStream();
    const all = concat(connack, publish, puback, pingreq);
    const rand = mulberry32(20260814);
    const packets: MqttPacket[] = [];
    let offset = 0;
    while (offset < all.length) {
      const size = 1 + Math.floor(rand() * 5);
      packets.push(...stream.push(all.subarray(offset, Math.min(offset + size, all.length))));
      offset += size;
    }
    expect(packets).toEqual([
      parsePacket(connack),
      parsePacket(publish),
      parsePacket(puback),
      { type: 'pingreq' },
    ]);
  });

  it('handles a frame split exactly in the middle of its body', () => {
    const stream = new PacketStream();
    const half = Math.floor(publish.length / 2);
    expect(stream.push(publish.subarray(0, half))).toEqual([]);
    const packets = stream.push(publish.subarray(half));
    expect(packets).toEqual([parsePacket(publish)]);
  });

  it('waits for more data on a truncated remaining-length varint', () => {
    const stream = new PacketStream();
    // PUBLISH header with varint 0x80 (continuation set, needs a 2nd byte).
    expect(stream.push(new Uint8Array([0x30, 0x80]))).toEqual([]);
    // Second varint byte 0x01 → remaining length 128: 2-byte topic ('a') + 125 payload bytes.
    const body = new Uint8Array(128);
    body[0] = 0x00;
    body[1] = 0x01;
    body[2] = 0x61; // 'a'
    body.fill(0x5a, 3); // payload
    const packets = stream.push(concat(new Uint8Array([0x01]), body));
    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ type: 'publish', topic: 'a', qos: 0 });
  });

  it('handles a two-byte remaining length in the fixed header', () => {
    const stream = new PacketStream();
    // Remaining length 128 exactly → two-byte varint 0x80 0x01.
    const frame = buildPublish({
      topic: 'a',
      payload: new Uint8Array(125).fill(0x5a),
      qos: 0,
    });
    expect(frame[1]).toBe(0x80);
    expect(frame[2]).toBe(0x01);
    const packets = stream.push(frame);
    expect(packets[0]).toMatchObject({ type: 'publish', topic: 'a', qos: 0 });
  });

  it('skips malformed frames, records an error, and keeps parsing', () => {
    const stream = new PacketStream();
    // QoS 3 PUBLISH: flags nibble 0x06 with qos 3 is invalid.
    const bad = new Uint8Array([0x36, 0x00]);
    expect(stream.push(bad)).toEqual([]);
    expect(stream.errors).toHaveLength(1);
    expect(stream.errors[0]?.code).toBe('PROTOCOL');
    // Stream resynchronized: the next good frame still parses.
    expect(stream.push(pingreq)).toEqual([{ type: 'pingreq' }]);
  });

  it('drops the buffer on a malformed remaining-length varint', () => {
    const stream = new PacketStream();
    const bad = new Uint8Array([0x10, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    expect(() => stream.push(bad)).not.toThrow();
    expect(stream.errors).toHaveLength(1);
    // A subsequent good frame parses fine.
    expect(stream.push(pingreq)).toEqual([{ type: 'pingreq' }]);
  });

  it('never throws out of push() on arbitrary garbage', () => {
    const stream = new PacketStream();
    const garbage = new Uint8Array(64);
    for (let i = 0; i < garbage.length; i += 1) {
      garbage[i] = (i * 37 + 11) & 0xff;
    }
    expect(() => stream.push(garbage)).not.toThrow();
    expect(() => stream.push(new Uint8Array(0))).not.toThrow();
  });

  it('invokes the onError callback for malformed frames', () => {
    const onError = vi.fn();
    const stream = new PacketStream({ onError });
    stream.push(new Uint8Array([0x36, 0x00]));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(MqttError);
  });

  it('is empty-safe', () => {
    const stream = new PacketStream();
    expect(stream.push(new Uint8Array(0))).toEqual([]);
    expect(stream.errors).toHaveLength(0);
  });
});

/** Concatenates byte arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

import { describe, expect, it } from 'vitest';
import { TsPacketizer, parsePacket } from './packet.js';

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Builds a minimal 188-byte packet with the given PID / continuity counter. */
function tsPacket(
  pid: number,
  continuity = 0,
  adaptationFieldControl = 0b01,
  adaptationFieldLength = 0,
): Uint8Array {
  const out = new Uint8Array(188);
  out[0] = 0x47;
  out[1] = (pid >> 8) & 0x1f;
  out[2] = pid & 0xff;
  out[3] = (adaptationFieldControl << 4) | (continuity & 0x0f);
  if (adaptationFieldControl === 0b10 || adaptationFieldControl === 0b11) {
    out[4] = adaptationFieldLength;
  }
  return out;
}

describe('TsPacketizer', () => {
  it('emits 188-byte packets from byte-split input', () => {
    const p0 = tsPacket(0x100, 0);
    p0.set([1, 2, 3], 4);
    const p1 = tsPacket(0x100, 1);
    p1.set([4, 5, 6], 4);
    const stream = concat(p0, p1);
    const packetizer = new TsPacketizer();
    const emitted: Uint8Array[] = [];
    // Odd-sized 7-byte chunks force packet boundaries to land mid-chunk.
    for (let i = 0; i < stream.length; i += 7) {
      packetizer.push(stream.subarray(i, i + 7), (packet) => emitted.push(packet));
    }
    packetizer.flush();
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toEqual(p0);
    expect(emitted[1]).toEqual(p1);
  });

  it('false sync rejected via double-0x47 check', () => {
    // A lone 0x47 amid garbage must not sync on its own.
    const garbage = new Uint8Array([0x11, 0x47, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const packetizer = new TsPacketizer();
    const emitted: Uint8Array[] = [];
    packetizer.push(garbage, (packet) => emitted.push(packet));
    expect(emitted).toHaveLength(0);

    // The same garbage followed by a real stream does sync at the real start.
    const real = tsPacket(0x100, 0);
    real.set([9, 9, 9], 4);
    const packetizer2 = new TsPacketizer();
    const emitted2: Uint8Array[] = [];
    packetizer2.push(concat(garbage, real), (packet) => emitted2.push(packet));
    expect(emitted2).toHaveLength(1);
    expect(emitted2[0]).toEqual(real);
  });

  it('continuity counter gap surfaces an error', () => {
    const errors: string[] = [];
    const packetizer = new TsPacketizer({ onError: (message) => errors.push(message) });
    const emitted: Uint8Array[] = [];
    // Same PID, continuity 0 then 2 (skips 1): a gap.
    packetizer.push(concat(tsPacket(0x100, 0), tsPacket(0x100, 2)), (packet) => emitted.push(packet));
    expect(emitted).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/continuity counter gap/);
  });

  it('continuity counter 15->0 wrap is not a gap', () => {
    const errors: string[] = [];
    const packetizer = new TsPacketizer({ onError: (message) => errors.push(message) });
    packetizer.push(concat(tsPacket(0x100, 15), tsPacket(0x100, 0)), () => {});
    expect(errors).toEqual([]);
  });

  it('duplicate packets (same continuity counter) are skipped silently', () => {
    const errors: string[] = [];
    const packetizer = new TsPacketizer({ onError: (message) => errors.push(message) });
    packetizer.push(concat(tsPacket(0x100, 7), tsPacket(0x100, 7)), () => {});
    expect(errors).toEqual([]);
  });

  it('packetizes 204-byte packets (16-byte RS parity) without desyncing', () => {
    const body = tsPacket(0x100, 0);
    body.set([1, 2, 3, 4], 4);
    const p204a = concat(body, new Uint8Array(16));
    const p204b = concat(tsPacket(0x100, 1), new Uint8Array(16));
    const packetizer = new TsPacketizer({ packetSize: 204 });
    const emitted: Uint8Array[] = [];
    packetizer.push(concat(p204a, p204b), (packet) => emitted.push(packet));
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.length).toBe(204);

    // The 16 trailing parity bytes must not leak into the parsed payload:
    // the payload is exactly the 184-byte body slot, not 200 bytes.
    const parsed = parsePacket(emitted[0] as Uint8Array);
    expect(parsed).not.toBeNull();
    expect(parsed?.payload.length).toBe(184);
    expect(parsed?.payload.subarray(0, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe('parsePacket', () => {
  it('adaptation-field stuffing parses with empty payload', () => {
    // adaptation_field_control = 0b10 (adaptation only), length 183 → no payload.
    const packet = tsPacket(0x100, 0, 0b10, 183);
    const parsed = parsePacket(packet);
    expect(parsed).not.toBeNull();
    expect(parsed?.pid).toBe(0x100);
    expect(parsed?.payload.length).toBe(0);
    expect(parsed?.adaptationFieldLength).toBe(183);
  });

  it('adaptation-field stuffing with payload returns only the payload bytes', () => {
    // adaptation_field_control = 0b11, length 173 → 10 payload bytes at 178.
    const packet = tsPacket(0x100, 0, 0b11, 173);
    packet.set([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33, 0x44, 0x55], 178);
    const parsed = parsePacket(packet);
    expect(parsed).not.toBeNull();
    expect(parsed?.payload).toEqual(
      new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33, 0x44, 0x55]),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { pcmDecodeInt16, pcmEncodeInt16 } from './pcm.js';

describe('PCM passthrough', () => {
  it('is the identity on the full int16 range', () => {
    const values: number[] = [];
    for (let v = -32768; v <= 32767; v += 997) values.push(v);
    values.push(32767, -32768, 0);
    const pcm = Int16Array.from(values);
    const roundTrip = pcmDecodeInt16(pcmEncodeInt16(pcm));
    expect(Array.from(roundTrip)).toEqual(Array.from(pcm));
  });

  it('uses little-endian 16-bit layout', () => {
    const pcm = new Int16Array([0x1234, -1, 258]);
    const bytes = pcmEncodeInt16(pcm);
    expect(bytes[0]).toBe(0x34);
    expect(bytes[1]).toBe(0x12);
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0xff);
  });

  it('decodes odd-length buffers by truncating the trailing byte', () => {
    const bytes = new Uint8Array([0x34, 0x12, 0x00]);
    expect(Array.from(pcmDecodeInt16(bytes))).toEqual([0x1234]);
  });
});

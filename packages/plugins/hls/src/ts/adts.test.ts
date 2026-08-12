import { describe, expect, it } from 'vitest';
import { parseAdtsHeader } from './adts.js';

function adtsFrame(frameLength: number): Uint8Array {
  const out = new Uint8Array(frameLength);
  out[0] = 0xff;
  out[1] = 0xf1; // sync + MPEG-4 + layer 0 + no CRC
  out[2] = (1 << 6) | (4 << 2) | 0; // profile 1 (AAC-LC), 44100 index 4, channels 2 (high bit 0)
  out[3] = (2 << 6) | ((frameLength >> 11) & 0x03);
  out[4] = (frameLength >> 3) & 0xff;
  out[5] = ((frameLength & 0x07) << 5) | 0x1f;
  out[6] = 0xfc;
  return out;
}

describe('parseAdtsHeader', () => {
  it('parses sample rate, channels and frame length', () => {
    const header = parseAdtsHeader(adtsFrame(17));
    expect(header.isAdts).toBe(true);
    expect(header.sampleRate).toBe(44100);
    expect(header.channels).toBe(2);
    expect(header.profile).toBe(1);
    expect(header.frameLength).toBe(17);
  });

  it('rejects non-ADTS data', () => {
    expect(parseAdtsHeader(new Uint8Array(7)).isAdts).toBe(false);
  });

  it('rejects short buffers', () => {
    expect(parseAdtsHeader(new Uint8Array([0xff, 0xf1, 0x50])).isAdts).toBe(false);
  });
});

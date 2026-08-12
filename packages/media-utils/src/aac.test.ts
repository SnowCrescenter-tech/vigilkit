import { describe, expect, it } from 'vitest';
import { adtsToConfig, ascToConfig, stripAdts } from './aac.js';
import { MediaFormatError } from './errors.js';

/** 7-byte-header ADTS frame (protection_absent = 1): header bytes 0..6. */
function adtsFrame(frameLength: number): Uint8Array {
  const out = new Uint8Array(frameLength);
  out[0] = 0xff;
  out[1] = 0xf1; // sync + MPEG-4 + layer 0 + no CRC
  out[2] = (1 << 6) | (4 << 2); // profile 1, 44100 index 4, channelConfig high bit 0
  out[3] = (2 << 6) | ((frameLength >> 11) & 0x03);
  out[4] = (frameLength >> 3) & 0xff;
  out[5] = ((frameLength & 0x07) << 5) | 0x1f;
  out[6] = 0xfc;
  return out;
}

/** 9-byte-header ADTS frame (protection_absent = 0, CRC present). */
function crcAdtsFrame(frameLength: number): Uint8Array {
  const out = new Uint8Array(frameLength);
  out[0] = 0xff;
  out[1] = 0xf0; // sync + MPEG-4 + layer 0 + CRC present
  out[2] = (1 << 6) | (4 << 2);
  out[3] = (2 << 6) | ((frameLength >> 11) & 0x03);
  out[4] = (frameLength >> 3) & 0xff;
  out[5] = ((frameLength & 0x07) << 5) | 0x1f;
  out[6] = 0xfc;
  out[7] = 0x12; // CRC bytes
  out[8] = 0x34;
  return out;
}

describe('ascToConfig', () => {
  it('parses a known AudioSpecificConfig into an AudioDecoderConfig', () => {
    const asc = new Uint8Array([0x12, 0x10]);
    const config = ascToConfig(asc);
    expect(config.codec).toBe('mp4a.40.2');
    expect(config.sampleRate).toBe(44100);
    expect(config.numberOfChannels).toBe(2);
    expect(config.description).toEqual(asc);
    expect(config.description).not.toBe(asc);
  });

  it('throws MediaFormatError when AOT is 31 (escape sequence)', () => {
    expect(() => ascToConfig(new Uint8Array([0xf8, 0x00]))).toThrow(MediaFormatError);
  });

  it('throws MediaFormatError when the sampling frequency is explicit (index 15)', () => {
    expect(() => ascToConfig(new Uint8Array([0x17, 0x80]))).toThrow(MediaFormatError);
  });

  it('throws MediaFormatError when shorter than 2 bytes', () => {
    expect(() => ascToConfig(new Uint8Array([0x12]))).toThrow(MediaFormatError);
  });
});

describe('adtsToConfig', () => {
  it('builds a 2-byte ASC matching the ADTS header fields', () => {
    const config = adtsToConfig({ profile: 1, sampleRateIndex: 4, sampleRate: 44100, channels: 2 });
    expect(config.codec).toBe('mp4a.40.2');
    expect(config.sampleRate).toBe(44100);
    expect(config.numberOfChannels).toBe(2);
    expect(config.description).toEqual(new Uint8Array([0x12, 0x10]));
  });
});

describe('stripAdts', () => {
  it('returns the payload of a 7-byte-header frame', () => {
    const frame = adtsFrame(17);
    const payload = stripAdts(frame);
    expect(payload.length).toBe(17 - 7);
    expect(payload).toEqual(frame.slice(7));
  });

  it('returns the payload of a 9-byte-header (CRC) frame', () => {
    const frame = crcAdtsFrame(17);
    const payload = stripAdts(frame);
    expect(payload.length).toBe(17 - 9);
    expect(payload).toEqual(frame.slice(9));
  });

  it('throws MediaFormatError on non-ADTS data', () => {
    expect(() => stripAdts(new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]))).toThrow(
      MediaFormatError,
    );
  });

  it('throws MediaFormatError on a short frame', () => {
    expect(() => stripAdts(new Uint8Array([0xff, 0xf1, 0x50]))).toThrow(MediaFormatError);
    expect(() => stripAdts(adtsFrame(17).subarray(0, 10))).toThrow(MediaFormatError);
  });
});

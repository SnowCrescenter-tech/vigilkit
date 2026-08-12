import { MediaFormatError } from './errors.js';

/** MPEG-4 sampling frequency index table (indexes 0..12; 13/14 reserved, 15 = explicit). */
const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * Parses an MPEG-4 AudioSpecificConfig (2+ bytes, as carried by FLV AAC
 * sequence headers) into an `AudioDecoderConfig`. Only the first two bytes are
 * consumed: AOT, samplingFrequencyIndex and channelConfig. Escaped AOTs
 * (31) and explicitly-signaled sample rates (index 15) are rejected — HE-AAC
 * via implicit signaling is not handled.
 */
export function ascToConfig(asc: Uint8Array): AudioDecoderConfig {
  if (asc.length < 2) {
    throw new MediaFormatError('malformed AudioSpecificConfig: shorter than 2 bytes');
  }
  const b0 = asc[0] as number;
  const b1 = asc[1] as number;
  const aot = (b0 >> 3) & 0x1f;
  const samplingFrequencyIndex = ((b0 & 0x07) << 1) | (b1 >> 7);
  const channelConfig = (b1 >> 3) & 0x0f;
  if (aot === 31 || samplingFrequencyIndex === 15) {
    throw new MediaFormatError('unsupported AudioSpecificConfig');
  }
  const sampleRate = SAMPLE_RATES[samplingFrequencyIndex];
  if (sampleRate === undefined) {
    // Reserved index (13/14) or out-of-range garbage.
    throw new MediaFormatError('unsupported AudioSpecificConfig');
  }
  return {
    codec: `mp4a.40.${aot}`,
    sampleRate,
    numberOfChannels: channelConfig,
    description: asc.slice(),
  };
}

/** Parsed ADTS header fields consumed by {@link adtsToConfig}. */
export interface AdtsConfigInput {
  profile: number;
  sampleRateIndex: number;
  sampleRate: number;
  channels: number;
}

/**
 * Builds an `AudioDecoderConfig` from ADTS header fields by synthesizing the
 * equivalent 2-byte AudioSpecificConfig. `profile` is the ADTS profile field
 * (0..3); the MPEG-4 audio object type is `profile + 1`.
 */
export function adtsToConfig(header: AdtsConfigInput): AudioDecoderConfig {
  const aot = header.profile + 1;
  const b0 = (aot << 3) | (header.sampleRateIndex >> 1);
  const b1 = ((header.sampleRateIndex & 0x01) << 7) | (header.channels << 3);
  return {
    codec: `mp4a.40.${aot}`,
    sampleRate: header.sampleRate,
    numberOfChannels: header.channels,
    description: new Uint8Array([b0, b1]),
  };
}

/**
 * Strips the ADTS header (7 bytes, or 9 with a CRC) off one AAC frame and
 * returns the raw payload (the bytes a WebCodecs AudioDecoder consumes).
 * Throws `MediaFormatError` on non-ADTS data or a frame shorter than its
 * declared length.
 */
export function stripAdts(frame: Uint8Array): Uint8Array {
  if (frame.length < 7 || (frame[0] as number) !== 0xff || ((frame[1] as number) & 0xf0) !== 0xf0) {
    throw new MediaFormatError('not an ADTS frame');
  }
  const headerLength = (frame[1] as number) & 0x01 ? 7 : 9;
  const frameLength =
    (((frame[3] as number) & 0x03) << 11) |
    ((frame[4] as number) << 3) |
    (((frame[5] as number) >> 5) & 0x07);
  if (frame.length < frameLength || frameLength <= headerLength) {
    throw new MediaFormatError('truncated ADTS frame');
  }
  return frame.slice(headerLength, frameLength);
}

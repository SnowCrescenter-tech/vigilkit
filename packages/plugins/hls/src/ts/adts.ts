/** AAC ADTS frame header. */
export interface AdtsHeader {
  sampleRate: number;
  channels: number;
  frameLength: number;
  profile: number;
  isAdts: boolean;
}

const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * Parses the 7-byte ADTS header of an AAC frame. Non-ADTS data (bad syncword
 * or too short) returns `isAdts: false`.
 */
export function parseAdtsHeader(data: Uint8Array): AdtsHeader {
  const fail: AdtsHeader = { isAdts: false, sampleRate: 0, channels: 0, frameLength: 0, profile: 0 };
  if (data.length < 7 || (data[0] as number) !== 0xff || ((data[1] as number) & 0xf0) !== 0xf0) {
    return fail;
  }
  const profile = ((data[2] as number) >> 6) & 0x03;
  const sampleRateIndex = ((data[2] as number) >> 2) & 0x0f;
  const channels = (((data[2] as number) & 0x01) << 2) | (((data[3] as number) >> 6) & 0x03);
  const frameLength =
    (((data[3] as number) & 0x03) << 11) |
    ((data[4] as number) << 3) |
    (((data[5] as number) >> 5) & 0x07);
  const sampleRate = SAMPLE_RATES[sampleRateIndex] ?? 0;
  return { isAdts: true, sampleRate, channels, frameLength, profile };
}

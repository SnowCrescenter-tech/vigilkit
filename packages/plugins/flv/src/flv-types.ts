// FLV container constants and tag/video/audio enums.

/** The 3-byte FLV file signature `'FLV'`. */
export const FLV_SIGNATURE = new Uint8Array([0x46, 0x4c, 0x56]);

export const TagType = {
  AUDIO: 8,
  VIDEO: 9,
  SCRIPT: 18,
} as const;

export const SoundFormat = {
  AAC: 10,
} as const;

export const VideoCodec = {
  AVC: 7,
} as const;

export const AvcPacketType = {
  SEQ: 0,
  NALU: 1,
} as const;

export const AacPacketType = {
  SEQ: 0,
  RAW: 1,
} as const;

// AVC frame type is the high nibble of the first video tag byte.
export const AvcFrameType = {
  KEY: 1,
  INTER: 2,
} as const;

/** FLV header size in bytes (signature + version + flags + dataOffset). */
export const HEADER_SIZE = 9;
/** Size of a tag header in bytes (type + dataSize + timestamp + ext + streamId). */
export const TAG_HEADER_SIZE = 11;
/** Size of the PreviousTagSize field that follows every tag. */
export const PREV_TAG_SIZE = 4;

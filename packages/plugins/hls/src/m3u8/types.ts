/**
 * Media segment encryption (RFC 8216 §5.2). `method` is `'AES-128'` for
 * AES-128-CBC whole-segment encryption or `'NONE'` for no encryption. `uri`
 * is the key file URL (resolved against the playlist URL), required for
 * AES-128. `iv`, when present, is the 128-bit IV as a `0x`-prefixed
 * 32-hex-digit string; when absent for AES-128 it defaults to the segment's
 * media sequence as a 128-bit big-endian integer (per spec).
 */
export interface KeyInfo {
  method: 'AES-128' | 'NONE';
  uri?: string;
  iv?: string;
}

export interface Segment {
  uri: string;
  duration: number;
  byterange?: { length: number; offset: number };
  /** The #EXT-X-KEY in effect for this segment; undefined = unencrypted. */
  key?: KeyInfo;
}

export interface Variant {
  uri: string;
  bandwidth?: number;
  resolution?: { width: number; height: number };
}

export interface Playlist {
  type: 'master' | 'media';
  targetDuration?: number;
  mediaSequence: number;
  segments: Segment[];
  variants: Variant[];
  live: boolean;
  endList: boolean;
  version?: number;
}

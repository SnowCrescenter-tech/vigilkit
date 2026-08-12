export interface Segment {
  uri: string;
  duration: number;
  byterange?: { length: number; offset: number };
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

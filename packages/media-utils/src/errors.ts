/**
 * Error thrown by media demux/codec helpers for malformed container data.
 * `code` is the literal `'DEMUX'` shared by all format-level failures.
 */
export class MediaFormatError extends Error {
  readonly code: 'DEMUX';

  constructor(message: string) {
    super(message);
    this.name = 'MediaFormatError';
    this.code = 'DEMUX';
  }
}

/** Convenience factory for throwing a `MediaFormatError`. */
export function formatError(message: string): MediaFormatError {
  return new MediaFormatError(message);
}

import type { MediaErrorCode } from '@vigilkit/plugin-sdk';

/**
 * Error thrown by the FLV demuxer internals for malformed container data.
 * `code` is a MediaErrorCode: 'DEMUX' for generic framing/parsing failures,
 * 'DEMUX_BAD_SIGNATURE' and 'DEMUX_MISSING_SEQUENCE_HEADER' for their
 * specific conditions.
 */
export class DemuxError extends Error {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message: string) {
    super(message);
    this.name = 'DemuxError';
    this.code = code;
  }
}

/** Convenience factory for throwing a `DemuxError`. */
export function demuxError(code: MediaErrorCode, message: string): DemuxError {
  return new DemuxError(code, message);
}

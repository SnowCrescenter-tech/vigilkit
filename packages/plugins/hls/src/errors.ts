/**
 * Error thrown by the HLS source for playlist/segment/TS failures.
 * `code` maps onto the SDK `MediaErrorCode` union ('DEMUX' for parsing and
 * transport failures, 'UNSUPPORTED' for features the plugin does not support).
 */
export class HlsError extends Error {
  readonly code: 'DEMUX' | 'UNSUPPORTED';

  constructor(code: 'DEMUX' | 'UNSUPPORTED', message: string) {
    super(message);
    this.name = 'HlsError';
    this.code = code;
  }
}

/** Convenience factory for creating an `HlsError`. */
export function hlsError(code: 'DEMUX' | 'UNSUPPORTED', message: string): HlsError {
  return new HlsError(code, message);
}

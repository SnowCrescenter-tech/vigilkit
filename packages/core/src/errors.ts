import type { MediaErrorCode, MediaErrorInfo } from '@vigilkit/plugin-sdk';

export class VigilkitError extends Error {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message: string) {
    super(message);
    this.name = 'VigilkitError';
    this.code = code;
  }
}

export function mediaError(code: MediaErrorCode, message: string): MediaErrorInfo {
  return { code, message };
}

export type UniviewErrorCode = 'AUTH' | 'HTTP' | 'PARSE' | 'INVALID_ARGUMENT';

/** Typed error for the Uniview plugin surface. */
export class UniviewError extends Error {
  readonly code: UniviewErrorCode;
  readonly status?: number;

  constructor(code: UniviewErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'UniviewError';
    this.code = code;
    this.status = status;
  }
}

export type HikvisionErrorCode = 'AUTH' | 'HTTP' | 'PARSE' | 'INVALID_ARGUMENT';

/** Typed error for the Hikvision plugin surface. */
export class HikvisionError extends Error {
  readonly code: HikvisionErrorCode;
  readonly status?: number;

  constructor(code: HikvisionErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'HikvisionError';
    this.code = code;
    this.status = status;
  }
}

export type DahuaErrorCode = 'AUTH' | 'HTTP' | 'PARSE' | 'INVALID_ARGUMENT';

/** Typed error for the Dahua plugin surface. */
export class DahuaError extends Error {
  readonly code: DahuaErrorCode;
  readonly status?: number;

  constructor(code: DahuaErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'DahuaError';
    this.code = code;
    this.status = status;
  }
}

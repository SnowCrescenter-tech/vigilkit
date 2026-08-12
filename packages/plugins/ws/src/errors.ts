export class TransportError extends Error {
  readonly code: 'TRANSPORT' = 'TRANSPORT';

  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

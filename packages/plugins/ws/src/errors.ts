export class TransportError extends Error {
  readonly code = 'TRANSPORT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

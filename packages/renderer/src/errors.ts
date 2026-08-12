export class RendererError extends Error {
  readonly code = 'RENDERER' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RendererError';
  }
}

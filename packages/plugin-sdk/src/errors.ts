import type { MediaErrorCode } from './types.js';

export class PluginCollisionError extends Error {
  readonly code: MediaErrorCode = 'PLUGIN_COLLISION';

  constructor(message: string) {
    super(message);
    this.name = 'PluginCollisionError';
  }
}

export class PluginNotFoundError extends Error {
  readonly code: MediaErrorCode = 'UNSUPPORTED';

  constructor(message: string) {
    super(message);
    this.name = 'PluginNotFoundError';
  }
}
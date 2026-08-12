import { PluginCollisionError, PluginNotFoundError } from '@vigilkit/plugin-sdk';
import type { MediaErrorInfo } from '@vigilkit/plugin-sdk';

/** Extracts the URL scheme ('ws', 'wss', ...) or null when unparseable. */
export function schemeOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol.replace(/:$/, '');
  } catch {
    return null;
  }
}

/** Coerces a thrown plugin error into a MediaErrorInfo with its code. */
export function asMediaError(error: unknown): MediaErrorInfo {
  const message = error instanceof Error ? error.message : 'unknown error';
  if (error instanceof PluginCollisionError) {
    return { code: 'PLUGIN_COLLISION', message };
  }
  if (error instanceof PluginNotFoundError) {
    return { code: 'UNSUPPORTED', message };
  }
  return { code: 'UNSUPPORTED', message };
}

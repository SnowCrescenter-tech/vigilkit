import { UniviewError } from './errors.js';

/**
 * JSON helpers for the Uniview LightAPI.
 *
 * Unlike the Hikvision plugin (XML ISAPI), Uniview's LightAPI control plane
 * (`/LAPI/V1.0/...`) is RESTful HTTP + JSON with digest authentication. The
 * two helpers below keep the device client's parsing dependency-free and
 * tolerant of the small schema differences between IPC and NVR firmware.
 */

/**
 * Parses a LightAPI response body. Never throws a raw `SyntaxError`: a
 * malformed body raises `UniviewError('PARSE', ...)` so callers can handle it
 * with the plugin's typed error surface.
 */
export function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UniviewError('PARSE', `Invalid JSON from Uniview device: ${detail}`);
  }
}

/**
 * Safely walks a nested JSON value along a dotted path, including numeric
 * array indices (`channels.0.name`). Returns `undefined` for any missing
 * segment — never throws. Non-object / null / undefined values short-circuit
 * to `undefined`.
 */
function walkPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const item = current[Number.parseInt(segment, 10)];
      if (item === undefined) return undefined;
      current = item;
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/** Reads a string at a dotted path, or `undefined` if missing / not a string. */
export function getString(obj: unknown, path: string): string | undefined {
  const value = walkPath(obj, path);
  return typeof value === 'string' ? value : undefined;
}

/** Reads a number at a dotted path, or `undefined` if missing / not a number. */
export function getNumber(obj: unknown, path: string): number | undefined {
  const value = walkPath(obj, path);
  return typeof value === 'number' ? value : undefined;
}

/** Reads a boolean at a dotted path, or `undefined` if missing / not a boolean. */
export function getBoolean(obj: unknown, path: string): boolean | undefined {
  const value = walkPath(obj, path);
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * True when the SDP advertises at least one video media section. WHEP
 * responses must negotiate video; a response without `m=video` is treated as
 * an SDP parse failure (surfaced as UNSUPPORTED by the source).
 */
export function hasVideoMedia(sdp: string): boolean {
  return sdp.split(/\r?\n/).some((line) => line.trim().startsWith('m=video'));
}

/**
 * The PATCH URL of a WHEP session: the POST response `Location` header when
 * present (resolved against `base`), otherwise the resource URL itself.
 */
export function resolvePatchUrl(location: string | null, base: string | undefined, fallback: string): string {
  if (location === null || location === '') {
    return fallback;
  }
  try {
    return new URL(location, base ?? fallback).href;
  } catch {
    return fallback;
  }
}

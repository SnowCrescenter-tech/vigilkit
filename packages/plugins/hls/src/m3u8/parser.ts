import type { KeyInfo, Playlist, Segment, Variant } from './types.js';

interface PendingVariant {
  bandwidth?: number;
  resolution?: { width: number; height: number };
}

const IV_PATTERN = /^0x[0-9a-fA-F]{32}$/;

/**
 * Parses the `#EXT-X-KEY` attribute list (RFC 8216 §5.2). Returns the key to
 * apply to subsequent segments, or `undefined` when no key applies. Per spec
 * an unrecognized METHOD is ignored; since the plugin only implements
 * AES-128, any METHOD other than AES-128 — including NONE — disables
 * encryption, and a tag that cannot yield a valid AES-128 key (missing URI,
 * malformed IV) is treated the same way rather than guessing at an algorithm
 * or silently playing garbage ciphertext.
 */
function parseKeyInfo(text: string): KeyInfo | undefined {
  const attrs = parseAttributes(text);
  const method = (attrs.get('METHOD') ?? '').toUpperCase();
  if (method !== 'AES-128') return undefined;
  const uri = attrs.get('URI');
  if (uri === undefined || uri.length === 0) return undefined;
  const iv = attrs.get('IV');
  if (iv !== undefined && !IV_PATTERN.test(iv)) return undefined;
  const key: KeyInfo = { method: 'AES-128', uri };
  if (iv !== undefined) key.iv = iv;
  return key;
}

/** Parses `RESOLUTION=WxH` attribute values. */
function parseResolution(value: string | undefined): { width: number; height: number } | undefined {
  if (value === undefined) return undefined;
  const [w, h] = value.split('x');
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return { width, height };
}

/** Parses `KEY=VALUE,KEY=VALUE` attribute lists, stripping optional quotes. */
function parseAttributes(text: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const part of text.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    attrs.set(key, value);
  }
  return attrs;
}

function toOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Line-based m3u8 playlist parser. Tolerates a UTF-8 BOM and CRLF line
 * endings. Unknown `#EXT-X-*` tags are ignored. Parsing never throws: a
 * missing `#EXTM3U` header yields a best-effort empty `Playlist` (garbage or
 * truncated input must not take down the caller), and so does any other
 * malformed input.
 */
export function parseM3u8(text: string): Playlist {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);

  let master = false;
  let endList = false;
  let mediaSequence = 0;
  let targetDuration: number | undefined;
  let version: number | undefined;

  const segments: Segment[] = [];
  const variants: Variant[] = [];

  let pendingDuration: number | null = null;
  let pendingByterange: { length: number; offset: number } | undefined;
  let pendingVariant: PendingVariant | null = null;
  let lastByterangeEnd: number | undefined;
  let currentKey: KeyInfo | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        master = true;
        const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        pendingVariant = {
          bandwidth: toOptionalNumber(attrs.get('BANDWIDTH')),
          resolution: parseResolution(attrs.get('RESOLUTION')),
        };
      } else if (line.startsWith('#EXTINF:')) {
        const duration = Number.parseFloat(line.slice('#EXTINF:'.length));
        // A missing/unparseable duration (#EXTINF: with no number, NaN,
        // Infinity) must not produce a NaN-duration segment: treat it as no
        // pending EXTINF so the following URI is dropped like any orphan.
        // Negative durations are clamped to 0 — garbage, but never a crash.
        pendingDuration = Number.isFinite(duration) ? Math.max(0, duration) : null;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const [lengthText, offsetText] = line.slice('#EXT-X-BYTERANGE:'.length).split('@');
        const length = Number(lengthText);
        const offset = offsetText !== undefined ? Number(offsetText) : lastByterangeEnd ?? 0;
        if (Number.isFinite(length) && Number.isFinite(offset)) {
          pendingByterange = { length, offset };
          lastByterangeEnd = offset + length;
        }
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = toOptionalNumber(line.slice('#EXT-X-TARGETDURATION:'.length));
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = toOptionalNumber(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) ?? 0;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        if (line.slice('#EXT-X-PLAYLIST-TYPE:'.length) === 'VOD') endList = true;
      } else if (line === '#EXT-X-ENDLIST') {
        endList = true;
      } else if (line.startsWith('#EXT-X-VERSION:')) {
        version = toOptionalNumber(line.slice('#EXT-X-VERSION:'.length));
      } else if (line.startsWith('#EXT-X-KEY:')) {
        currentKey = parseKeyInfo(line.slice('#EXT-X-KEY:'.length));
      }
      // Any other #EXT-X-* tag is ignored.
      continue;
    }

    // A non-comment line is a URI: variant URI or segment URI.
    if (pendingVariant !== null) {
      const variant: Variant = { uri: line };
      if (pendingVariant.bandwidth !== undefined) variant.bandwidth = pendingVariant.bandwidth;
      if (pendingVariant.resolution !== undefined) variant.resolution = pendingVariant.resolution;
      variants.push(variant);
      pendingVariant = null;
    } else if (pendingDuration !== null) {
      const segment: Segment = { uri: line, duration: pendingDuration };
      if (pendingByterange !== undefined) {
        segment.byterange = pendingByterange;
        pendingByterange = undefined;
      }
      if (currentKey !== undefined) segment.key = currentKey;
      segments.push(segment);
      pendingDuration = null;
    }
  }

  // A missing #EXTM3U header no longer throws: arbitrary/truncated input must
  // never take down the caller, so parse whatever the text described. Callers
  // treat an empty best-effort playlist as unusable.
  return {
    type: master ? 'master' : 'media',
    targetDuration,
    mediaSequence,
    segments,
    variants,
    live: !endList,
    endList,
    version,
  };
}

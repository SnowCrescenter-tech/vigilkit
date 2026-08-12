import { hlsError } from '../errors.js';
import type { Playlist, Segment, Variant } from './types.js';

interface PendingVariant {
  bandwidth?: number;
  resolution?: { width: number; height: number };
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
 * endings. Unknown `#EXT-X-*` tags are ignored. A missing `#EXTM3U` header is
 * a hard error; otherwise even an empty playlist parses to an empty media
 * `Playlist`.
 */
export function parseM3u8(text: string): Playlist {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);

  let headerSeen = false;
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

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line.startsWith('#')) {
      if (line === '#EXTM3U') {
        headerSeen = true;
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        master = true;
        const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        pendingVariant = {
          bandwidth: toOptionalNumber(attrs.get('BANDWIDTH')),
          resolution: parseResolution(attrs.get('RESOLUTION')),
        };
      } else if (line.startsWith('#EXTINF:')) {
        const duration = Number.parseFloat(line.slice('#EXTINF:'.length));
        // A missing/unparseable duration (#EXTINF: with no number) must not
        // produce a NaN-duration segment: treat it as no pending EXTINF so the
        // following URI is dropped like any orphan.
        pendingDuration = Number.isFinite(duration) ? duration : null;
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
      segments.push(segment);
      pendingDuration = null;
    }
  }

  if (!headerSeen) {
    throw hlsError('DEMUX', 'missing #EXTM3U header');
  }

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

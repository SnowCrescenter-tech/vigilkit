import { HikvisionError } from './errors.js';

/**
 * Stream URL building for Hikvision devices.
 *
 * Hikvision exposes two media access styles:
 *  - RTSP (`rtsp://.../Streaming/Channels/{channel}{suffix}`), the standard for
 *    VLC/ffmpeg/media-source consumption; and
 *  - ISAPI HTTP preview (`/ISAPI/Streaming/channels/{channel}/httpPreview`),
 *    useful when RTSP is blocked.
 *
 * The channel suffix encodes the stream: `01` = main stream, `02` = sub stream.
 */

export interface StreamUrlOptions {
  /** Hostname or IP address (no scheme, no path). */
  host: string;
  /** Username for the device account. */
  username: string;
  /** Password for the device account. */
  password: string;
  /** 1-based channel number (default 1). */
  channel?: number;
  /** Which stream to address (default 'main'). */
  stream?: 'main' | 'sub';
  /** RTSP port (default 554). */
  rtspPort?: number;
  /** HTTP/HTTPS port for preview (default 80). */
  httpPort?: number;
  /** Use HTTPS for the ISAPI preview URL. */
  https?: boolean;
}

const STREAM_SUFFIX: Record<'main' | 'sub', string> = { main: '01', sub: '02' };

/** Validates and normalizes channel to a positive integer. */
export function normalizeChannel(channel?: number): number {
  const value = channel ?? 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new HikvisionError('INVALID_ARGUMENT', `Invalid channel number: ${channel}`);
  }
  return value;
}

function credentials(username: string, password: string): string {
  return `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
}

/**
 * Builds an RTSP stream URL.
 * Example: `rtsp://admin:12345@192.168.1.64:554/Streaming/Channels/101`
 */
export function rtspUrl(opts: StreamUrlOptions): string {
  const channel = normalizeChannel(opts.channel);
  const stream = opts.stream ?? 'main';
  const port = opts.rtspPort ?? 554;
  const suffix = STREAM_SUFFIX[stream];
  return `rtsp://${credentials(opts.username, opts.password)}@${opts.host}:${port}/Streaming/Channels/${channel}${suffix}`;
}

/**
 * Builds an ISAPI HTTP preview URL.
 * Example: `http://192.168.1.64/ISAPI/Streaming/channels/101/httpPreview`
 */
export function httpPreviewUrl(opts: StreamUrlOptions): string {
  const channel = normalizeChannel(opts.channel);
  const stream = opts.stream ?? 'main';
  const scheme = opts.https ? 'https' : 'http';
  const port = opts.httpPort ?? (opts.https ? 443 : 80);
  return `${scheme}://${opts.host}:${port}/ISAPI/Streaming/channels/${channel}${STREAM_SUFFIX[stream]}/httpPreview`;
}

/**
 * Builds a snapshot/picture URL (returns a single JPEG frame).
 * Example: `http://192.168.1.64/ISAPI/Streaming/channels/101/picture`
 */
export function snapshotUrl(opts: StreamUrlOptions): string {
  const channel = normalizeChannel(opts.channel);
  const scheme = opts.https ? 'https' : 'http';
  const port = opts.httpPort ?? (opts.https ? 443 : 80);
  return `${scheme}://${opts.host}:${port}/ISAPI/Streaming/channels/${channel}${STREAM_SUFFIX[opts.stream ?? 'main']}/picture`;
}

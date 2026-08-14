import { DahuaError } from './errors.js';

/**
 * Stream URL building for Dahua devices (HTTP CGI + RTSP templates).
 *
 * Dahua exposes:
 *  - RTSP (`rtsp://…/cam/realmonitor?channel=N&subtype=S`) — the standard
 *    VLC/ffmpeg/relay path; subtype 0 = main stream, 1/2 = extra streams.
 *  - RTSP-over-WebSocket (`ws://host/rtspoverwebsocket`) — the unique Dahua
 *    browser bridge: the camera speaks RTSP *inside* the WebSocket, so a
 *    browser page can consume RTSP without any relay server.
 *  - CGI snapshot / MJPEG (`/cgi-bin/snapshot.cgi`, `/cgi-bin/mjpg/video.cgi`).
 */

export interface DahuaRtspUrlOptions {
  /** Hostname or IP address (no scheme, no path). */
  host: string;
  /** Username for the device account. */
  username?: string;
  /** Password for the device account. */
  password?: string;
  /** 1-based channel number (default 1). */
  channel?: number;
  /** Stream index: 0 = main stream, 1/2 = extra (sub) streams (default 0). */
  subtype?: number;
  /** RTSP port (default 554). */
  rtspPort?: number;
}

export interface DahuaHttpUrlOptions {
  /** Hostname or IP address (no scheme, no path). */
  host: string;
  /** 1-based channel number (default 1). */
  channel?: number;
  /** HTTP/HTTPS port (default 80, or 443 when https). */
  port?: number;
  /** Use HTTPS (default false). */
  https?: boolean;
}

export interface DahuaWsUrlOptions {
  /** Hostname or IP address (no scheme, no path). */
  host: string;
  /** WebSocket port (optional; defaults to the device HTTP port, usually 80). */
  port?: number;
}

/** Validates and normalizes a channel to a positive integer (1-based). */
export function normalizeChannel(channel?: number): number {
  const value = channel ?? 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new DahuaError('INVALID_ARGUMENT', `Invalid channel number: ${channel}`);
  }
  return value;
}

/** Validates a stream subtype against an inclusive maximum. */
function normalizeSubtype(subtype: number | undefined, max: number): number {
  const value = subtype ?? 0;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new DahuaError('INVALID_ARGUMENT', `Invalid stream subtype: ${subtype}`);
  }
  return value;
}

/** Percent-encodes credentials for a URL authority, or the empty string. */
function credentials(username: string | undefined, password: string | undefined): string {
  if (username === undefined) return '';
  return `${encodeURIComponent(username)}:${encodeURIComponent(password ?? '')}@`;
}

/**
 * Builds an RTSP stream URL.
 * Example: `rtsp://admin:12345@192.168.1.64:554/cam/realmonitor?channel=1&subtype=0`
 */
export function rtspUrl(opts: DahuaRtspUrlOptions): string {
  const channel = normalizeChannel(opts.channel);
  const subtype = normalizeSubtype(opts.subtype, 2);
  const port = opts.rtspPort ?? 554;
  return `rtsp://${credentials(opts.username, opts.password)}${opts.host}:${port}/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
}

/**
 * Builds the static RTSP-over-WebSocket bridge URL — the unique Dahua browser
 * path. The camera speaks RTSP inside the WebSocket (the inner RTSP URL is
 * carried in the client's opening message), so no relay server is needed.
 * Example: `ws://192.168.1.64/rtspoverwebsocket`
 */
export function rtspOverWebSocketUrl(opts: DahuaWsUrlOptions): string {
  const port = opts.port === undefined ? '' : `:${opts.port}`;
  return `ws://${opts.host}${port}/rtspoverwebsocket`;
}

/** Builds the HTTP base for CGI endpoints. */
function httpBase(opts: DahuaHttpUrlOptions): string {
  const scheme = opts.https ? 'https' : 'http';
  const port = opts.port ?? (opts.https ? 443 : 80);
  return `${scheme}://${opts.host}:${port}`;
}

/**
 * Builds a snapshot URL (returns a single JPEG frame).
 * Example: `http://192.168.1.64/cgi-bin/snapshot.cgi?channel=1`
 */
export function snapshotUrl(opts: DahuaHttpUrlOptions): string {
  const channel = normalizeChannel(opts.channel);
  return `${httpBase(opts)}/cgi-bin/snapshot.cgi?channel=${channel}`;
}

/**
 * Builds an MJPEG stream URL. subtype 0 = main stream, 1 = extra stream.
 * Example: `http://192.168.1.64/cgi-bin/mjpg/video.cgi?channel=1&subtype=1`
 */
export function mjpegUrl(opts: DahuaHttpUrlOptions & { subtype?: number }): string {
  const channel = normalizeChannel(opts.channel);
  const subtype = normalizeSubtype(opts.subtype, 1);
  return `${httpBase(opts)}/cgi-bin/mjpg/video.cgi?channel=${channel}&subtype=${subtype}`;
}

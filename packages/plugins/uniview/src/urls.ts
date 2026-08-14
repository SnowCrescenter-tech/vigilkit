import { UniviewError } from './errors.js';

/**
 * Stream URL building for Uniview (UNV) devices.
 *
 * Uniview exposes (per docs/vendor-sdk-research.md §3.1):
 *  - RTSP, IPC form: `rtsp://…/media/video1` (main), `video2` (sub),
 *    `video3` (third).
 *  - RTSP, NVR form: `rtsp://…/unicast/c<channel>/s<0|1>/live`
 *    (channel 1-based, s0 = main, s1 = sub).
 *  - Snapshot: `http://host/images/snapshot.jpg` (the simple documented form).
 *  - MJPEG: `http://host/video/mjpeg/stream<1|2|3>`.
 */

/** Main / sub / third video streams (IPC: video1/video2/video3). */
export type UniviewStream = 'main' | 'sub' | 'third';

export interface UniviewRtspUrlOptions {
  /** Hostname or IP address (no scheme, no path). */
  host: string;
  /** Username for the device account. */
  username?: string;
  /** Password for the device account. */
  password?: string;
  /** 1-based channel number (default 1). */
  channel?: number;
  /** Stream to address (default 'main'). */
  stream?: UniviewStream;
  /** RTSP port (default 554). */
  rtspPort?: number;
  /** Use the NVR unicast template instead of the IPC media template. */
  nvr?: boolean;
}

export interface UniviewHttpUrlOptions {
  /** Hostname or IP address (no scheme, no path). */
  host: string;
  /** HTTP/HTTPS port (default 80, or 443 when https). */
  port?: number;
  /** Use HTTPS (default false). */
  https?: boolean;
}

export interface UniviewMjpegUrlOptions extends UniviewHttpUrlOptions {
  /** MJPEG stream index, 1..3 (default 1). */
  stream?: number;
}

/** Validates and normalizes a channel to a positive integer (1-based). */
export function normalizeChannel(channel?: number): number {
  const value = channel ?? 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new UniviewError('INVALID_ARGUMENT', `Invalid channel number: ${channel}`);
  }
  return value;
}

/**
 * Resolves the stream selector to its path suffix: IPC form uses
 * `video1|video2|video3`; NVR form uses `s0|s1` (no third stream on NVRs).
 */
function streamSuffix(stream: UniviewStream | undefined, nvr: boolean): string {
  const value = stream ?? 'main';
  if (value === 'main') return nvr ? 's0' : 'video1';
  if (value === 'sub') return nvr ? 's1' : 'video2';
  if (value === 'third') {
    if (nvr) {
      throw new UniviewError(
        'INVALID_ARGUMENT',
        `Invalid stream 'third' for NVR: NVRs expose only s0 (main) and s1 (sub)`,
      );
    }
    return 'video3';
  }
  throw new UniviewError('INVALID_ARGUMENT', `Invalid stream: ${String(stream)}`);
}

/** Percent-encodes credentials for a URL authority, or the empty string. */
function credentials(username: string | undefined, password: string | undefined): string {
  if (username === undefined) return '';
  return `${encodeURIComponent(username)}:${encodeURIComponent(password ?? '')}@`;
}

/**
 * Builds an RTSP stream URL.
 * IPC: `rtsp://admin:12345@192.168.1.64:554/media/video1`
 * NVR: `rtsp://admin:12345@192.168.1.64:554/unicast/c2/s0/live`
 */
export function rtspUrl(opts: UniviewRtspUrlOptions): string {
  const channel = normalizeChannel(opts.channel);
  const port = opts.rtspPort ?? 554;
  const auth = credentials(opts.username, opts.password);
  if (opts.nvr) {
    const sub = streamSuffix(opts.stream, true);
    return `rtsp://${auth}${opts.host}:${port}/unicast/c${channel}/${sub}/live`;
  }
  const media = streamSuffix(opts.stream, false);
  return `rtsp://${auth}${opts.host}:${port}/media/${media}`;
}

/** Builds the HTTP base for LightAPI / media endpoints. */
function httpBase(opts: UniviewHttpUrlOptions): string {
  const scheme = opts.https ? 'https' : 'http';
  const port = opts.port ?? (opts.https ? 443 : 80);
  return `${scheme}://${opts.host}:${port}`;
}

/**
 * Builds a snapshot URL (returns a single JPEG frame).
 * Example: `http://192.168.1.64/images/snapshot.jpg`
 */
export function snapshotUrl(opts: UniviewHttpUrlOptions): string {
  return `${httpBase(opts)}/images/snapshot.jpg`;
}

/**
 * Builds an MJPEG stream URL (when the stream codec is MJPEG).
 * Example: `http://192.168.1.64/video/mjpeg/stream1`
 */
export function mjpegUrl(opts: UniviewMjpegUrlOptions): string {
  const stream = opts.stream ?? 1;
  if (!Number.isInteger(stream) || stream < 1 || stream > 3) {
    throw new UniviewError('INVALID_ARGUMENT', `Invalid MJPEG stream index: ${opts.stream}`);
  }
  return `${httpBase(opts)}/video/mjpeg/stream${stream}`;
}

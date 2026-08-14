import { DahuaError } from './errors.js';

/**
 * PTZ control for Dahua devices via the `cgi-bin/ptz.cgi` HTTP CGI.
 *
 * Motion is a two-step protocol: `action=start&code=<CODE>` begins motion and
 * `action=stop&code=<CODE>` ends it (the camera keeps moving until the stop
 * command). There is no pan/tilt "stop" code — stopping always repeats the
 * moving direction's code with `action=stop` (same for zoom), which is why
 * `directionToCode('stop')` and `zoomToCode('stop')` throw.
 */

export type PtzDirection =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'upLeft'
  | 'upRight'
  | 'downLeft'
  | 'downRight'
  | 'stop';

export type ZoomDirection = 'in' | 'out' | 'stop';

const DIRECTION_CODES: Record<Exclude<PtzDirection, 'stop'>, string> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  upLeft: 'LeftUp',
  upRight: 'RightUp',
  downLeft: 'LeftDown',
  downRight: 'RightDown',
};

/** Maps a pan/tilt direction to its Dahua CGI `code` value. */
export function directionToCode(dir: PtzDirection): string {
  if (dir === 'stop') {
    throw new DahuaError(
      'INVALID_ARGUMENT',
      "Dahua has no pan/tilt 'stop' code; stop motion with ptzStopPath(channel, code) using the moving direction's code",
    );
  }
  return DIRECTION_CODES[dir];
}

/** Maps a zoom direction to its Dahua CGI `code` value (ZoomTele / ZoomWide). */
export function zoomToCode(dir: ZoomDirection): string {
  if (dir === 'in') return 'ZoomTele';
  if (dir === 'out') return 'ZoomWide';
  throw new DahuaError(
    'INVALID_ARGUMENT',
    "Dahua has no zoom 'stop' code; stop zooming with ptzStopPath(channel, 'ZoomTele' | 'ZoomWide')",
  );
}

function ptzPath(channel: number, code: string, action: 'start' | 'stop'): string {
  if (!Number.isInteger(channel) || channel < 1) {
    throw new DahuaError('INVALID_ARGUMENT', `Invalid channel number: ${channel}`);
  }
  if (typeof code !== 'string' || code.length === 0) {
    throw new DahuaError('INVALID_ARGUMENT', `Invalid PTZ code: ${code}`);
  }
  return `/cgi-bin/ptz.cgi?action=${action}&channel=${channel}&code=${code}&arg1=0&arg2=0&arg3=0`;
}

/** Builds the `action=start` CGI path for a PTZ code. */
export function ptzStartPath(channel: number, code: string): string {
  return ptzPath(channel, code, 'start');
}

/** Builds the `action=stop` CGI path for a PTZ code. */
export function ptzStopPath(channel: number, code: string): string {
  return ptzPath(channel, code, 'stop');
}

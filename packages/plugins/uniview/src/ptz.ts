import { UniviewError } from './errors.js';

/**
 * PTZ control for Uniview devices over the LightAPI (`/LAPI/V1.0`).
 *
 * The LightAPI continuous PTZ control is a `PUT` to
 * `/LAPI/V1.0/Channels/<id>/PTZCtrl/Continuous` with a JSON body carrying the
 * pan/tilt/zoom velocity triplet. This module builds the documented path
 * (`ptzPath`) and the JSON body (`ptzBody`); motion continues until a `stop`
 * body (all zeros) is PUT to the same path.
 *
 * Body field names: the LightAPI guide describes the PTZ control object with
 * PascalCase `Pan` / `Tilt` / `Zoom` members (matching the LightAPI's general
 * PascalCase JSON style, e.g. `DeviceInfo.Name`, `Channels[].Enable`), wrapped
 * in a `PTZ` object. If a firmware revision expects the lowercase variant,
 * only `ptzBody` needs to change — the device client consumes it as an opaque
 * string.
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

/** A pan/tilt/zoom velocity triplet (each in -1..1). */
export interface PtzVector {
  pan: number;
  tilt: number;
  zoom: number;
}

/** Maps a pan/tilt direction to its velocity triplet ('stop' = all zeros). */
export function directionToVector(dir: PtzDirection): PtzVector {
  switch (dir) {
    case 'up':
      return { pan: 0, tilt: 1, zoom: 0 };
    case 'down':
      return { pan: 0, tilt: -1, zoom: 0 };
    case 'left':
      return { pan: -1, tilt: 0, zoom: 0 };
    case 'right':
      return { pan: 1, tilt: 0, zoom: 0 };
    case 'upLeft':
      return { pan: -1, tilt: 1, zoom: 0 };
    case 'upRight':
      return { pan: 1, tilt: 1, zoom: 0 };
    case 'downLeft':
      return { pan: -1, tilt: -1, zoom: 0 };
    case 'downRight':
      return { pan: 1, tilt: -1, zoom: 0 };
    case 'stop':
      return { pan: 0, tilt: 0, zoom: 0 };
    default:
      throw new UniviewError('INVALID_ARGUMENT', `Invalid PTZ command: ${String(dir)}`);
  }
}

/** Maps a zoom direction to its velocity triplet ('stop' = all zeros). */
export function zoomToVector(dir: ZoomDirection): PtzVector {
  if (dir === 'in') return { pan: 0, tilt: 0, zoom: 1 };
  if (dir === 'out') return { pan: 0, tilt: 0, zoom: -1 };
  if (dir === 'stop') return { pan: 0, tilt: 0, zoom: 0 };
  throw new UniviewError('INVALID_ARGUMENT', `Invalid PTZ command: ${String(dir)}`);
}

function validateChannel(channel: number): void {
  if (!Number.isInteger(channel) || channel < 1) {
    throw new UniviewError('INVALID_ARGUMENT', `Invalid channel number: ${channel}`);
  }
}

/**
 * Builds the LightAPI continuous PTZ control path for a channel.
 * Example: `/LAPI/V1.0/Channels/1/PTZCtrl/Continuous`
 */
export function ptzPath(channel: number): string {
  validateChannel(channel);
  return `/LAPI/V1.0/Channels/${channel}/PTZCtrl/Continuous`;
}

/**
 * Builds the JSON PUT body for a PTZ command, e.g.
 * `{"PTZ":{"Pan":0,"Tilt":1,"Zoom":0}}` for 'up'. 'stop' zeroes all axes.
 */
export function ptzBody(cmd: PtzDirection | ZoomDirection): string {
  const vector = cmd === 'in' || cmd === 'out' ? zoomToVector(cmd) : directionToVector(cmd);
  return JSON.stringify({ PTZ: { Pan: vector.pan, Tilt: vector.tilt, Zoom: vector.zoom } });
}

/**
 * Builds the LightAPI control path for a continuous PTZ command and validates
 * the command (throws `UniviewError('INVALID_ARGUMENT')` for unknown values).
 */
export function ptzStartPath(channel: number, cmd: PtzDirection | ZoomDirection): string {
  validateChannel(channel);
  ptzBody(cmd);
  return ptzPath(channel);
}

import { HikvisionError } from './errors.js';

/**
 * PTZ control for Hikvision devices via the ISAPI continuous-control endpoint.
 *
 * `PUT /ISAPI/PTZCtrl/channels/{id}/continuous` with an XML `<PTZData>` body.
 * Pan/tilt/zoom range from -100 (full negative) to 100 (full positive). Sending
 * all-zero stops movement. This mirrors the values the Hikvision web UI sends
 * while a PTZ button is held, then a zero command on release.
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

export interface PtzMove {
  pan: number;
  tilt: number;
  zoom: number;
}

const DIRECTION_VECTORS: Record<PtzDirection, { pan: number; tilt: number }> = {
  up: { pan: 0, tilt: 1 },
  down: { pan: 0, tilt: -1 },
  left: { pan: -1, tilt: 0 },
  right: { pan: 1, tilt: 0 },
  upLeft: { pan: -1, tilt: 1 },
  upRight: { pan: 1, tilt: 1 },
  downLeft: { pan: -1, tilt: -1 },
  downRight: { pan: 1, tilt: -1 },
  stop: { pan: 0, tilt: 0 },
};

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 50;
  return Math.max(1, Math.min(100, Math.round(speed)));
}

/** Builds a pan/tilt movement command for a direction at the given speed. */
export function move(direction: PtzDirection, speed = 50): PtzMove {
  const vec = DIRECTION_VECTORS[direction];
  if (!vec) throw new HikvisionError('INVALID_ARGUMENT', `Unknown PTZ direction: ${direction}`);
  const s = clampSpeed(speed);
  return { pan: vec.pan * s, tilt: vec.tilt * s, zoom: 0 };
}

/** Builds a zoom command. `'in'` = tele/zoom-in (positive), `'out'` = wide. */
export function zoom(direction: ZoomDirection, speed = 50): PtzMove {
  const s = clampSpeed(speed);
  if (direction === 'in') return { pan: 0, tilt: 0, zoom: s };
  if (direction === 'out') return { pan: 0, tilt: 0, zoom: -s };
  return { pan: 0, tilt: 0, zoom: 0 };
}

/** Stops all PTZ motion. */
export function stop(): PtzMove {
  return { pan: 0, tilt: 0, zoom: 0 };
}

/** Serializes a `PtzMove` to the ISAPI continuous-control XML body. */
export function ptzDataXml(data: PtzMove): string {
  return (
    `<PTZData><pan>${data.pan}</pan><tilt>${data.tilt}</tilt><zoom>${data.zoom}</zoom></PTZData>`
  );
}

/** Returns the ISAPI continuous-control path for a channel (1-based). */
export function ptzControlPath(channel: number): string {
  if (!Number.isInteger(channel) || channel < 1) {
    throw new HikvisionError('INVALID_ARGUMENT', `Invalid channel number: ${channel}`);
  }
  return `/ISAPI/PTZCtrl/channels/${channel}/continuous`;
}

/** Returns the ISAPI preset-goto path. */
export function ptzPresetPath(channel: number, preset: number): string {
  if (!Number.isInteger(channel) || channel < 1) {
    throw new HikvisionError('INVALID_ARGUMENT', `Invalid channel number: ${channel}`);
  }
  if (!Number.isInteger(preset) || preset < 1) {
    throw new HikvisionError('INVALID_ARGUMENT', `Invalid preset number: ${preset}`);
  }
  return `/ISAPI/PTZCtrl/channels/${channel}/presets/${preset}/goto`;
}

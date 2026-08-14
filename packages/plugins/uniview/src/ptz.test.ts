import { describe, expect, it } from 'vitest';
import { ptzBody, ptzPath, ptzStartPath } from './ptz.js';
import { UniviewError } from './errors.js';

describe('ptzPath', () => {
  it('builds the LightAPI continuous PTZ path', () => {
    expect(ptzPath(1)).toBe('/LAPI/V1.0/Channels/1/PTZCtrl/Continuous');
    expect(ptzPath(12)).toBe('/LAPI/V1.0/Channels/12/PTZCtrl/Continuous');
  });

  it('rejects invalid channels', () => {
    expect(() => ptzPath(0)).toThrow(UniviewError);
    expect(() => ptzPath(-1)).toThrow(/channel/i);
    expect(() => ptzPath(1.5)).toThrow(/channel/i);
  });
});

describe('ptzBody', () => {
  it('maps pan/tilt directions to Pan/Tilt values', () => {
    expect(ptzBody('up')).toBe('{"PTZ":{"Pan":0,"Tilt":1,"Zoom":0}}');
    expect(ptzBody('down')).toBe('{"PTZ":{"Pan":0,"Tilt":-1,"Zoom":0}}');
    expect(ptzBody('left')).toBe('{"PTZ":{"Pan":-1,"Tilt":0,"Zoom":0}}');
    expect(ptzBody('right')).toBe('{"PTZ":{"Pan":1,"Tilt":0,"Zoom":0}}');
  });

  it('combines pan and tilt for diagonal directions', () => {
    expect(ptzBody('upLeft')).toBe('{"PTZ":{"Pan":-1,"Tilt":1,"Zoom":0}}');
    expect(ptzBody('upRight')).toBe('{"PTZ":{"Pan":1,"Tilt":1,"Zoom":0}}');
    expect(ptzBody('downLeft')).toBe('{"PTZ":{"Pan":-1,"Tilt":-1,"Zoom":0}}');
    expect(ptzBody('downRight')).toBe('{"PTZ":{"Pan":1,"Tilt":-1,"Zoom":0}}');
  });

  it('maps zoom directions to Zoom values', () => {
    expect(ptzBody('in')).toBe('{"PTZ":{"Pan":0,"Tilt":0,"Zoom":1}}');
    expect(ptzBody('out')).toBe('{"PTZ":{"Pan":0,"Tilt":0,"Zoom":-1}}');
  });

  it('maps stop to all zeros', () => {
    expect(ptzBody('stop')).toBe('{"PTZ":{"Pan":0,"Tilt":0,"Zoom":0}}');
  });

  it('produces a valid JSON document for every command', () => {
    const commands = [
      'up', 'down', 'left', 'right', 'upLeft', 'upRight', 'downLeft', 'downRight', 'stop', 'in', 'out',
    ] as const;
    for (const cmd of commands) {
      const parsed = JSON.parse(ptzBody(cmd)) as { PTZ: Record<string, number> };
      expect(parsed.PTZ).toBeDefined();
      for (const axis of ['Pan', 'Tilt', 'Zoom']) {
        expect(typeof parsed.PTZ[axis]).toBe('number');
      }
    }
  });
});

describe('ptzStartPath', () => {
  it('returns the continuous control path for a valid command', () => {
    expect(ptzStartPath(3, 'up')).toBe('/LAPI/V1.0/Channels/3/PTZCtrl/Continuous');
  });

  it('rejects invalid commands', () => {
    expect(() => ptzStartPath(1, 'sideways' as never)).toThrow(/command/i);
  });

  it('rejects invalid channels', () => {
    expect(() => ptzStartPath(0, 'up')).toThrow(/channel/i);
  });
});

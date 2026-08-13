import { describe, expect, it } from 'vitest';
import { move, ptzControlPath, ptzDataXml, ptzPresetPath, stop, zoom } from './ptz.js';

describe('move', () => {
  it('maps directions to sign vectors scaled by speed', () => {
    expect(move('right', 100)).toEqual({ pan: 100, tilt: 0, zoom: 0 });
    expect(move('left', 100)).toEqual({ pan: -100, tilt: 0, zoom: 0 });
    expect(move('up', 50)).toEqual({ pan: 0, tilt: 50, zoom: 0 });
    expect(move('down', 50)).toEqual({ pan: 0, tilt: -50, zoom: 0 });
    expect(move('upRight', 10)).toEqual({ pan: 10, tilt: 10, zoom: 0 });
    expect(move('downLeft', 10)).toEqual({ pan: -10, tilt: -10, zoom: 0 });
  });

  it('clamps speed to [1, 100] and defaults to 50', () => {
    expect(move('right')).toEqual({ pan: 50, tilt: 0, zoom: 0 });
    expect(move('right', 999)).toEqual({ pan: 100, tilt: 0, zoom: 0 });
    expect(move('right', 0)).toEqual({ pan: 1, tilt: 0, zoom: 0 });
    expect(move('right', -5)).toEqual({ pan: 1, tilt: 0, zoom: 0 });
  });
});

describe('zoom', () => {
  it('zoom-in is positive, zoom-out negative', () => {
    expect(zoom('in', 60)).toEqual({ pan: 0, tilt: 0, zoom: 60 });
    expect(zoom('out', 60)).toEqual({ pan: 0, tilt: 0, zoom: -60 });
    expect(zoom('stop')).toEqual({ pan: 0, tilt: 0, zoom: 0 });
  });
});

describe('stop', () => {
  it('returns all-zero', () => expect(stop()).toEqual({ pan: 0, tilt: 0, zoom: 0 }));
});

describe('ptzDataXml', () => {
  it('serializes a move to the ISAPI XML body', () => {
    expect(ptzDataXml({ pan: 50, tilt: -20, zoom: 0 })).toBe(
      '<PTZData><pan>50</pan><tilt>-20</tilt><zoom>0</zoom></PTZData>',
    );
  });
});

describe('paths', () => {
  it('builds the continuous-control path', () => {
    expect(ptzControlPath(1)).toBe('/ISAPI/PTZCtrl/channels/1/continuous');
  });

  it('builds the preset-goto path', () => {
    expect(ptzPresetPath(2, 5)).toBe('/ISAPI/PTZCtrl/channels/2/presets/5/goto');
  });

  it('rejects invalid channels and presets', () => {
    expect(() => ptzControlPath(0)).toThrow(/channel/i);
    expect(() => ptzPresetPath(1, 0)).toThrow(/preset/i);
  });
});

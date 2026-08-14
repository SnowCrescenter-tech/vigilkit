import { describe, expect, it } from 'vitest';
import { directionToCode, ptzStartPath, ptzStopPath, zoomToCode } from './ptz.js';

describe('directionToCode', () => {
  it('maps directions to Dahua CGI codes', () => {
    expect(directionToCode('up')).toBe('Up');
    expect(directionToCode('down')).toBe('Down');
    expect(directionToCode('left')).toBe('Left');
    expect(directionToCode('right')).toBe('Right');
    expect(directionToCode('upLeft')).toBe('LeftUp');
    expect(directionToCode('upRight')).toBe('RightUp');
    expect(directionToCode('downLeft')).toBe('LeftDown');
    expect(directionToCode('downRight')).toBe('RightDown');
  });

  it("rejects 'stop': Dahua stops via action=stop, not a code", () => {
    expect(() => directionToCode('stop')).toThrow(/stop/i);
  });
});

describe('zoomToCode', () => {
  it('maps zoom directions to Dahua CGI codes', () => {
    expect(zoomToCode('in')).toBe('ZoomTele');
    expect(zoomToCode('out')).toBe('ZoomWide');
  });

  it("rejects 'stop': stop zooming with action=stop", () => {
    expect(() => zoomToCode('stop')).toThrow(/stop/i);
  });
});

describe('ptzStartPath', () => {
  it('builds the start CGI path', () => {
    expect(ptzStartPath(1, 'Right')).toBe(
      '/cgi-bin/ptz.cgi?action=start&channel=1&code=Right&arg1=0&arg2=0&arg3=0',
    );
  });

  it('rejects invalid channels', () => {
    expect(() => ptzStartPath(0, 'Up')).toThrow(/channel/i);
    expect(() => ptzStartPath(1.5, 'Up')).toThrow(/channel/i);
  });

  it('rejects empty codes', () => {
    expect(() => ptzStartPath(1, '')).toThrow(/code/i);
  });
});

describe('ptzStopPath', () => {
  it('builds the stop CGI path with the moving direction code', () => {
    expect(ptzStopPath(2, 'LeftUp')).toBe(
      '/cgi-bin/ptz.cgi?action=stop&channel=2&code=LeftUp&arg1=0&arg2=0&arg3=0',
    );
  });

  it('rejects invalid channels', () => {
    expect(() => ptzStopPath(-1, 'Up')).toThrow(/channel/i);
  });
});

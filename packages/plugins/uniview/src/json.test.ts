import { describe, expect, it } from 'vitest';
import { getBoolean, getNumber, getString, parseJsonResponse } from './json.js';
import { UniviewError } from './errors.js';

describe('parseJsonResponse', () => {
  it('parses a valid JSON document', () => {
    expect(parseJsonResponse('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonResponse('[1, 2, 3]')).toEqual([1, 2, 3]);
    expect(parseJsonResponse('null')).toBeNull();
  });

  it('throws UniviewError(PARSE) on malformed JSON', () => {
    try {
      parseJsonResponse('{not json');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UniviewError);
      expect((err as UniviewError).code).toBe('PARSE');
    }
  });

  it('throws UniviewError(PARSE) on empty or whitespace-only input', () => {
    expect(() => parseJsonResponse('')).toThrow(UniviewError);
    expect(() => parseJsonResponse('   ')).toThrow(UniviewError);
  });

  it('surfaces the JSON.parse error message', () => {
    try {
      parseJsonResponse('{broken');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('Invalid JSON');
    }
  });
});

const DOC = {
  DeviceInfo: { Name: 'Front Gate Cam', Model: 'IPC3616SR3-DUF', SerialNumber: 'ABCD1234', Version: 'V1.0.0' },
  channels: [{ name: 'Cam 01', enabled: true }, { name: 'Cam 02', enabled: false }],
  meta: { counts: { video: 2 } },
};

describe('getString / getNumber / getBoolean', () => {
  it('walks nested dotted paths', () => {
    expect(getString(DOC, 'DeviceInfo.Name')).toBe('Front Gate Cam');
    expect(getString(DOC, 'DeviceInfo.Model')).toBe('IPC3616SR3-DUF');
    expect(getNumber(DOC, 'meta.counts.video')).toBe(2);
    expect(getBoolean(DOC, 'channels.0.enabled')).toBe(true);
    expect(getBoolean(DOC, 'channels.1.enabled')).toBe(false);
  });

  it('accesses array elements by numeric index', () => {
    expect(getString(DOC, 'channels.0.name')).toBe('Cam 01');
    expect(getString(DOC, 'channels.1.name')).toBe('Cam 02');
  });

  it('returns undefined for missing paths (no throw)', () => {
    expect(getString(DOC, 'DeviceInfo.Nope')).toBeUndefined();
    expect(getNumber(DOC, 'DeviceInfo.Name')).toBeUndefined();
    expect(getBoolean(DOC, 'meta.counts')).toBeUndefined();
    expect(getString(DOC, 'missing.deep.path')).toBeUndefined();
    expect(getString(DOC, 'channels.5.name')).toBeUndefined();
    expect(getString(undefined, 'a.b')).toBeUndefined();
  });

  it('returns undefined when the value type does not match', () => {
    expect(getNumber(DOC, 'DeviceInfo.Name')).toBeUndefined();
    expect(getBoolean(DOC, 'DeviceInfo.Name')).toBeUndefined();
    expect(getString(DOC, 'meta.counts.video')).toBeUndefined();
  });
});

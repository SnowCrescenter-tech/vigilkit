import { describe, expect, it } from 'vitest';
import { parseScriptData } from './amf0.js';
import { DemuxError } from './errors.js';

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function amfString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return new Uint8Array([0x02, ...u16(bytes.length), ...bytes]);
}

function amfNumber(n: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n, false);
  // AMF0 number value = marker 0x00 followed by the big-endian double.
  return new Uint8Array([0x00, ...new Uint8Array(buf)]);
}

function amfBool(v: boolean): Uint8Array {
  return new Uint8Array([0x01, v ? 1 : 0]);
}

function ecmaEntry(name: string, value: Uint8Array): Uint8Array {
  const bytes = new TextEncoder().encode(name);
  return concat(new Uint8Array([...u16(bytes.length)]), bytes, value);
}

function onMetaData(entries: Uint8Array[]): Uint8Array {
  const body = concat(
    new Uint8Array([0x08, ...u32(entries.length)]),
    ...entries,
  );
  return concat(amfString('onMetaData'), body);
}

describe('parseScriptData', () => {
  it('parses an ECMA array with numbers, strings, and booleans', () => {
    const data = onMetaData([
      ecmaEntry('width', amfNumber(1280)),
      ecmaEntry('height', amfNumber(720)),
      ecmaEntry('title', amfString('demo')),
      ecmaEntry('hasVideo', amfBool(true)),
    ]);
    const meta = parseScriptData(data);
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
    expect(meta.title).toBe('demo');
    expect(meta.hasVideo).toBe(true);
  });

  it('extracts width/height from an onMetaData ECMA array', () => {
    const data = onMetaData([ecmaEntry('width', amfNumber(1920)), ecmaEntry('height', amfNumber(1080))]);
    const meta = parseScriptData(data);
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
  });

  it('skips an unknown value marker inside the ECMA array', () => {
    const data = onMetaData([
      ecmaEntry('width', amfNumber(1280)),
      ecmaEntry('weird', new Uint8Array([0x0b])), // unknown AMF marker
      ecmaEntry('height', amfNumber(720)),
    ]);
    const meta = parseScriptData(data);
    expect(meta.width).toBe(1280);
  });

  it('parses a strict array value (marker 0x0a) without an end-of-object marker', () => {
    // strict array with one number value; no trailing 00 00 09 (ffmpeg style)
    const strictArray = new Uint8Array([0x0a, 0x00, 0x00, 0x00, 0x01, ...amfNumber(123.5)]);
    const data = onMetaData([ecmaEntry('duration', amfNumber(10)), ecmaEntry('points', strictArray)]);
    const meta = parseScriptData(data);
    expect(meta.duration).toBe(10);
    expect(Array.isArray(meta.points)).toBe(true);
  });

  it('returns {} for a script whose name is not onMetaData', () => {
    const data = concat(amfString('@setDataFrame'), amfNumber(1));
    expect(parseScriptData(data)).toEqual({});
  });

  it('throws DemuxError when the first value is not a string', () => {
    const data = concat(amfNumber(1), amfNumber(2));
    expect(() => parseScriptData(data)).toThrow(DemuxError);
  });

  it('throws DemuxError when the name string length overruns the buffer', () => {
    expect(() => parseScriptData(new Uint8Array([0x02, 0xff, 0xff, 0x41]))).toThrow(DemuxError);
  });
});

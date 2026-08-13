import { describe, expect, it } from 'vitest';
import { i420ToRgba } from './i420-to-rgba.js';

/**
 * Builds a tight I420 frame with the given Y/U/V fill values.
 * `width*height` Y bytes, then `ceil(w/2)*ceil(h/2)` U bytes, then V.
 */
function i420Frame(width: number, height: number, y: number, u: number, v: number): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const cW = Math.ceil(width / 2);
  const cH = Math.ceil(height / 2);
  const data = new Uint8Array(width * height + 2 * cW * cH);
  data.fill(y, 0, width * height);
  data.fill(u, width * height, width * height + cW * cH);
  data.fill(v, width * height + cW * cH);
  return { width, height, data };
}

function rgbAt(rgba: Uint8Array, px: number): [number, number, number] {
  const i = px * 4;
  return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!];
}

describe('i420ToRgba', () => {
  it('produces one RGBA pixel (opaque) per luma sample', () => {
    const frame = i420Frame(2, 2, 0, 128, 128);
    const rgba = i420ToRgba(frame);
    expect(rgba.length).toBe(2 * 2 * 4);
    for (let px = 0; px < 4; px++) {
      expect(rgbAt(rgba, px)).toEqual([0, 0, 0]); // black: limited-range Y=16 clamp -> 0
      expect(rgba[px * 4 + 3]).toBe(255);
    }
  });

  it('maps a mid-gray luma to gray (limited range)', () => {
    const frame = i420Frame(2, 2, 126, 128, 128); // ~50% limited-range gray
    const rgba = i420ToRgba(frame);
    const [r, g, b] = rgbAt(rgba, 0);
    // BT.601 limited: Y=126 -> (298*(126-16))>>8 = 128
    expect([r, g, b]).toEqual([128, 128, 128]);
  });

  it('clamps out-of-range BT.601 results', () => {
    // Max luma with neutral chroma stays at 255.
    const frame = i420Frame(2, 2, 235, 128, 128); // limited-range white
    const rgba = i420ToRgba(frame);
    expect(rgbAt(rgba, 0)).toEqual([255, 255, 255]);
  });

  it('subsamples chroma across 2x2 luma blocks', () => {
    // 4x4 luma all 126; chroma all neutral -> every pixel is gray 128.
    const frame = i420Frame(4, 4, 126, 128, 128);
    const rgba = i420ToRgba(frame);
    for (let px = 0; px < 16; px++) {
      expect(rgbAt(rgba, px)).toEqual([128, 128, 128]);
    }
  });

  it('handles odd dimensions (ceil chroma planes)', () => {
    const frame = i420Frame(3, 3, 126, 128, 128);
    const rgba = i420ToRgba(frame);
    expect(rgba.length).toBe(3 * 3 * 4);
    expect(rgbAt(rgba, 0)).toEqual([128, 128, 128]);
  });
});

import { describe, expect, it } from 'vitest';
import { FakeImage } from './fake-libde265.fixture.js';
import { yuvToRgba } from './yuv-to-rgba.js';

describe('yuvToRgba (canvas fallback)', () => {
  it('converts a full-range I420 image to exact RGBA values', () => {
    const img = new FakeImage(0n, 2, 2, 1, 8, true);
    img.getImagePlane(0).bytes.fill(255); // white luma
    const white = yuvToRgba(img, 2, 2);
    expect(white).toEqual(
      new Uint8Array([
        255, 255, 255, 255, 255, 255, 255, 255,
        255, 255, 255, 255, 255, 255, 255, 255,
      ]),
    );
    img.getImagePlane(0).bytes.fill(16); // near-black luma
    const dark = yuvToRgba(img, 2, 2);
    expect(dark).toEqual(
      new Uint8Array([
        16, 16, 16, 255, 16, 16, 16, 255,
        16, 16, 16, 255, 16, 16, 16, 255,
      ]),
    );
  });
});

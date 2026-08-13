import type { Dav1dYuvFrame } from './dav1d-loader.js';

/**
 * Converts a tight-packed 8-bit 4:2:0 I420 frame (as returned by the dav1d
 * wrapper: `width*height` Y bytes, then `ceil(w/2)*ceil(h/2)` U bytes, then
 * the same for V) to packed RGBA (one byte per channel) using a BT.601
 * limited-range matrix. Correct but slow — used only by the canvas
 * `VideoFrame` fallback, never on the hot path.
 */
export function i420ToRgba(frame: Dav1dYuvFrame): Uint8Array {
  const { width, height, data } = frame;
  const cW = Math.ceil(width / 2);
  const cH = Math.ceil(height / 2);
  const ySize = width * height;
  const uSize = cW * cH;
  const u = data.subarray(ySize, ySize + uSize);
  const v = data.subarray(ySize + uSize, ySize + 2 * uSize);

  const rgba = new Uint8Array(width * height * 4);
  let offset = 0;
  for (let py = 0; py < height; py++) {
    const cy = py >> 1;
    for (let px = 0; px < width; px++) {
      const cx = px >> 1;
      const yy = data[py * width + px]!;
      const uu = u[cy * cW + cx]! - 128;
      const vv = v[cy * cW + cx]! - 128;
      const c = yy - 16;
      const r = (298 * c + 409 * vv + 128) >> 8;
      const g = (298 * c - 100 * uu - 208 * vv + 128) >> 8;
      const b = (298 * c + 516 * uu + 128) >> 8;
      rgba[offset++] = clamp(r);
      rgba[offset++] = clamp(g);
      rgba[offset++] = clamp(b);
      rgba[offset++] = 255;
    }
  }
  return rgba;
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

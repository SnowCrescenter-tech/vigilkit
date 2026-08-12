import type { Libde265Image, Libde265ImagePlane } from './libde265-loader.js';

/**
 * Reconstructs a full plane view. The wrapper's `bytes` slice covers only
 * `width * height * bitsPerPixel / 8` bytes from the plane start, which is
 * exact for 8-bit rows but truncated for 10+ bit samples (stored 16-bit) and
 * omits row padding when the pixel width is not 16-aligned. The underlying
 * plane is `stride * height` bytes; since `bytes` shares the wasm heap, a
 * wider view over the same buffer recovers the full plane.
 */
function fullPlaneView(plane: Libde265ImagePlane): Uint8Array {
  return new Uint8Array(plane.bytes.buffer, plane.bytes.byteOffset, plane.stride * plane.height);
}

/** Reads the sample at (x, y), shifting 10+ bit samples down to 8-bit display range. */
function readSample(
  plane: Uint8Array,
  x: number,
  y: number,
  stride: number,
  sampleBytes: number,
  shift: number,
): number {
  const offset = y * stride + x * sampleBytes;
  if (sampleBytes === 1) {
    return plane[offset]!;
  }
  const value = (plane[offset]! << 8) | plane[offset + 1]!;
  return value >> shift;
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Converts a planar libde265 image to packed RGBA (one byte per channel).
 * Reads rows at each plane's byte `stride`, subsamples chroma per the chroma
 * format, and applies a BT.601 matrix (limited or full range). Correct but
 * slow — used only by the canvas `VideoFrame` fallback, never on the hot path.
 */
export function yuvToRgba(image: Libde265Image, width: number, height: number): Uint8Array {
  const mono = image.chromaFormat === 0;
  const yPlane = image.getImagePlane(0);
  const uPlane = mono ? null : image.getImagePlane(1);
  const vPlane = mono ? null : image.getImagePlane(2);
  const y = fullPlaneView(yPlane);
  const u = uPlane === null ? null : fullPlaneView(uPlane);
  const v = vPlane === null ? null : fullPlaneView(vPlane);

  const bits = image.getBitsPerPixel(0);
  const sampleBytes = bits > 8 ? 2 : 1;
  const shift = bits > 8 ? bits - 8 : 0;
  const subW = image.chromaFormat === 3 ? 1 : 2; // 4:4:4 has no horizontal subsampling
  const subH = image.chromaFormat === 1 ? 2 : 1; // 4:2:0 subsamples vertically too

  const rgba = new Uint8Array(width * height * 4);
  let offset = 0;
  for (let py = 0; py < height; py++) {
    const cy = subH === 2 ? py >> 1 : py;
    for (let px = 0; px < width; px++) {
      const cx = subW === 2 ? px >> 1 : px;
      const yy = readSample(y, px, py, yPlane.stride, sampleBytes, shift);
      const uu = u === null ? 128 : readSample(u, cx, cy, uPlane!.stride, sampleBytes, shift);
      const vv = v === null ? 128 : readSample(v, cx, cy, vPlane!.stride, sampleBytes, shift);
      const d = uu - 128;
      const e = vv - 128;
      let r: number;
      let g: number;
      let b: number;
      if (image.isFullRange) {
        r = yy + ((359 * e) >> 8);
        g = yy - ((88 * d) >> 8) - ((183 * e) >> 8);
        b = yy + ((454 * d) >> 8);
      } else {
        const c = yy - 16;
        r = (298 * c + 409 * e + 128) >> 8;
        g = (298 * c - 100 * d - 208 * e + 128) >> 8;
        b = (298 * c + 516 * d + 128) >> 8;
      }
      rgba[offset++] = clamp(r);
      rgba[offset++] = clamp(g);
      rgba[offset++] = clamp(b);
      rgba[offset++] = 255;
    }
  }
  return rgba;
}

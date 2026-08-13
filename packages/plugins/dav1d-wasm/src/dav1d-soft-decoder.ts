import type { EncodedVideoChunkData, MediaErrorCode, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import type { VideoCodecDecoder } from 'vigilkit';
import type { Dav1dInstance, Dav1dModule, Dav1dYuvFrame } from './dav1d-loader.js';
import { i420ToRgba } from './i420-to-rgba.js';

const AV1_CODEC = /^av01/i;

/**
 * Soft AV1 decoder backed by the vendored dav1d WASM module (BSD-2-Clause
 * core, CC0 wrapper), satisfying vigilkit's `VideoCodecDecoder` contract so
 * the core routing decoder can use it as a drop-in soft backend.
 *
 * Stream contract: `decode()` must receive one AV1 temporal unit (the OBU
 * payload of a single frame) per chunk — the same granularity an IVF demuxer
 * hands out after its 4-byte-size / 8-byte-pts frame headers. This matches
 * the wrapper's frame-at-a-time `decodeFrameAsYUV(obu)` API.
 *
 * Init note: the wrapper instantiates the wasm asynchronously and each
 * `create()` owns an independent dav1d context (reference frames are per
 * context), so `module.create()` is awaited here; chunks that arrive before
 * the wasm is ready are buffered and drained once it resolves. This mirrors
 * the routing decoder's own probe-time buffering and keeps the decode()
 * contract synchronous.
 */
export class Dav1dSoftDecoder implements VideoCodecDecoder {
  private readonly module: Dav1dModule;
  private instance: Dav1dInstance | null = null;
  private readonly buffered: EncodedVideoChunkData[] = [];
  private outputCb: ((frame: VideoFrame, ptsUs: number) => void) | null = null;
  private errorCb: ((info: MediaErrorInfo) => void) | null = null;
  private pending = 0;
  private closed = false;
  private initPromise: Promise<void> | null = null;

  constructor(module: Dav1dModule) {
    this.module = module;
    void this.initInstance();
  }

  private initInstance(): Promise<void> {
    if (this.initPromise !== null) {
      return this.initPromise;
    }
    this.initPromise = this.module
      .create()
      .then((instance) => {
        if (this.closed) {
          instance.unsafeCleanup();
          return;
        }
        this.instance = instance;
        this.drain();
      })
      .catch((error) => {
        this.fail('DECODE', `dav1d: module init failed: ${errorMessage(error)}`);
      });
    return this.initPromise;
  }

  onOutput(cb: (frame: VideoFrame, ptsUs: number) => void): void {
    this.outputCb = cb;
  }

  onError(cb: (info: MediaErrorInfo) => void): void {
    this.errorCb = cb;
  }

  configure(config: VideoDecoderConfig): void {
    if (!AV1_CODEC.test(config.codec)) {
      this.fail('UNSUPPORTED', `not an AV1 codec: ${config.codec}`);
    }
  }

  decode(chunk: EncodedVideoChunkData): void {
    if (this.closed) {
      return;
    }
    this.pending++;
    if (this.instance !== null) {
      this.decodeNow(this.instance, chunk);
    } else {
      // wasm still instantiating: hold the chunk, drain on init resolution.
      this.buffered.push(chunk);
    }
  }

  flush(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (this.instance !== null) {
      this.drain();
      return Promise.resolve();
    }
    // Wait for the (already started) instantiation, then drain what arrived
    // in the meantime.
    return this.initInstance().then(() => {
      if (!this.closed) {
        this.drain();
      }
    });
  }

  reset(): void {
    if (this.closed) {
      return;
    }
    // The wrapper has no reset API: a fresh context is the analogue of
    // libde265's decoder reset (reference frames and parameter state drop).
    this.instance = null;
    this.initPromise = null;
    this.buffered.length = 0;
    this.pending = 0;
    void this.initInstance();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.instance !== null) {
      this.instance.unsafeCleanup();
      this.instance = null;
    }
    this.buffered.length = 0;
    this.pending = 0;
  }

  get queueSize(): number {
    return this.pending;
  }

  private drain(): void {
    if (this.instance === null) {
      return;
    }
    for (const chunk of this.buffered) {
      if (this.closed) {
        return;
      }
      this.decodeNow(this.instance, chunk);
    }
    this.buffered.length = 0;
  }

  private decodeNow(instance: Dav1dInstance, chunk: EncodedVideoChunkData): void {
    // Callers (decode / drain) pass the guarded, non-null instance.
    try {
      const yuv = instance.decodeFrameAsYUV(chunk.data);
      const frame = this.buildFrame(yuv, chunk.timestamp);
      this.pending = Math.max(0, this.pending - 1);
      this.outputCb?.(frame, chunk.timestamp);
    } catch (error) {
      this.fail('DECODE', `dav1d: frame decode failed: ${errorMessage(error)}`);
    }
  }

  private buildFrame(yuv: Dav1dYuvFrame, ptsUs: number): VideoFrame {
    const FrameCtor = (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;
    if (FrameCtor === undefined) {
      // Environments without WebCodecs (e.g. Node 22 smoke): deliver a
      // count-only null frame so the pipeline can still count output. The
      // cast is required by the interface, which is only ever driven with a
      // real VideoFrame in browsers.
      return null as unknown as VideoFrame;
    }
    try {
      return this.buildPlanarFrame(FrameCtor, yuv, ptsUs);
    } catch {
      try {
        // e.g. Chromium rejecting the buffer: fall back to an RGBA canvas
        // frame before surfacing a failure.
        return this.buildCanvasFrame(FrameCtor, yuv, ptsUs);
      } catch {
        this.fail('DECODE', 'dav1d: unable to construct a VideoFrame from the decoded picture');
        return null as unknown as VideoFrame;
      }
    }
  }

  /**
   * Direct planar I420 VideoFrame — the zero-conversion hot path. The wrapper
   * returns a tight 8-bit 4:2:0 copy (no row padding), which maps 1:1 onto
   * WebCodecs' I420 format: Y at offset 0 stride w, U/V at `w*h`/`w*h+uSize`
   * with stride `ceil(w/2)`.
   */
  private buildPlanarFrame(
    FrameCtor: typeof VideoFrame,
    yuv: Dav1dYuvFrame,
    ptsUs: number,
  ): VideoFrame {
    const { width, height, data } = yuv;
    const cW = Math.ceil(width / 2);
    const ySize = width * height;
    const uSize = cW * Math.ceil(height / 2);
    return new FrameCtor(data.buffer, {
      format: 'I420',
      codedWidth: width,
      codedHeight: height,
      timestamp: ptsUs,
      layout: [
        { offset: 0, stride: width },
        { offset: ySize, stride: cW },
        { offset: ySize + uSize, stride: cW },
      ],
    });
  }

  /** Slow fallback: YUV -> RGBA -> canvas -> VideoFrame(canvas). */
  private buildCanvasFrame(
    FrameCtor: typeof VideoFrame,
    yuv: Dav1dYuvFrame,
    ptsUs: number,
  ): VideoFrame {
    const rgba = i420ToRgba(yuv);
    const canvas = document.createElement('canvas');
    canvas.width = yuv.width;
    canvas.height = yuv.height;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('dav1d: 2d canvas context unavailable');
    }
    const imageData = context.createImageData(yuv.width, yuv.height);
    imageData.data.set(rgba);
    context.putImageData(imageData, 0, 0);
    return new FrameCtor(canvas, { timestamp: ptsUs });
  }

  private fail(code: MediaErrorCode, message: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pending = 0;
    this.errorCb?.({ code, message });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

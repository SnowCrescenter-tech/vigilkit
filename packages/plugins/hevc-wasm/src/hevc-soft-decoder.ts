import type { EncodedVideoChunkData, MediaErrorCode, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { parseHvcC } from '@vigilkit/media-utils';
import type { VideoCodecDecoder } from 'vigilkit';
import type {
  Libde265Decoder,
  Libde265Image,
  Libde265ImagePlane,
  Libde265Module,
} from './libde265-loader.js';
import { annexBFrame, asUint8Array, chunkFramingToAnnexB, concatBytes, selfDelimitingAnnexB } from './hevc-framing.js';
import { yuvToRgba } from './yuv-to-rgba.js';

const HEVC_CODEC = /^(hvc1|hev1|hevc)/i;

/**
 * Soft HEVC decoder backed by the vendored libde265 WASM module, satisfying
 * vigilkit's `VideoCodecDecoder` contract so the core routing decoder can use
 * it as a drop-in soft backend.
 *
 * Stream contract: `decode()` must receive an HEVC elementary stream in
 * Annex-B framing (00 00 01 start codes). Demuxer output (FLV Enhanced-RTMP
 * and TS stream_type 0x24) arrives 4-byte length-prefixed and is converted
 * here; Annex-B input (the raw-ES demo path) passes through unchanged.
 * `configure()` validates the codec and, when the config carries an hvcC
 * `description`, extracts its VPS/SPS/PPS and prepends them to the first
 * pushed chunk — demuxers emit only slice NALUs, and libde265 cannot decode
 * without the parameter sets.
 *
 * Worker note: libde265 decode is compute-intensive and synchronous; run the
 * whole plugin in a Web Worker in production to avoid blocking the main thread.
 */
export class HevcSoftDecoder implements VideoCodecDecoder {
  private readonly module: Libde265Module;
  private readonly decoder: Libde265Decoder;
  private outputCb: ((frame: VideoFrame, ptsUs: number) => void) | null = null;
  private errorCb: ((info: MediaErrorInfo) => void) | null = null;
  private pending = 0;
  private closed = false;
  /** Annex-B framed VPS/SPS/PPS from the hvcC description (null when absent). */
  private parameterSets: Uint8Array | null = null;
  private paramsPushed = false;
  /** True once any chunk reached pushData (first keyframe must not flush). */
  private hasPushed = false;

  constructor(module: Libde265Module) {
    this.module = module;
    this.decoder = new module.Decoder();
  }

  onOutput(cb: (frame: VideoFrame, ptsUs: number) => void): void {
    this.outputCb = cb;
  }

  onError(cb: (info: MediaErrorInfo) => void): void {
    this.errorCb = cb;
  }

  configure(config: VideoDecoderConfig): void {
    if (!HEVC_CODEC.test(config.codec)) {
      this.fail('UNSUPPORTED', `not an HEVC codec: ${config.codec}`);
      return;
    }
    this.parameterSets = null;
    this.paramsPushed = false;
    this.hasPushed = false;
    // Demuxer output carries only slice NALUs: the VPS/SPS/PPS live in the
    // hvcC `description` (FLV SequenceStart / TS parameter-set PES) and must
    // be prepended to the stream, or libde265 cannot decode the slices.
    if (config.description !== undefined) {
      try {
        const nalus = parseHvcC(asUint8Array(config.description)).arrays.flatMap((array) => array.nalus);
        if (nalus.length > 0) {
          this.parameterSets = annexBFrame(nalus);
        }
      } catch (error) {
        this.fail(
          'UNSUPPORTED',
          `malformed hvcC description: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  decode(chunk: EncodedVideoChunkData): void {
    if (this.closed) {
      return;
    }
    this.pending++;
    let data = chunkFramingToAnnexB(chunk.data);
    if (this.parameterSets !== null && !this.paramsPushed) {
      this.paramsPushed = true;
      data = concatBytes(this.parameterSets, data);
    }
    // Every pushed buffer must be self-delimiting (begin with a complete
    // start code): the raw-ES demo path splits Annex-B AT start codes, so
    // its chunks begin mid-start-code (`00 00 00` or `01`). After the
    // decoder is flushed, a mid-start-code chunk would misalign libde265's
    // NAL-boundary tracking.
    data = selfDelimitingAnnexB(data);
    // libde265 releases decoded pictures only when the decoder is flushed,
    // and the engine never flushes mid-stream — so nothing would ever reach
    // the renderer. Force the previous access unit out before every push
    // instead: flushData() outputs all buffered pictures while the decoder
    // keeps them available as references (verified: inter pictures decode
    // cleanly after a flush), keeping `pending` near zero so the scheduler's
    // backpressure never stalls the pipeline.
    if (this.hasPushed) {
      const flushError = this.decoder.flushData();
      if (!this.module.isOk(flushError)) {
        this.fail('DECODE', this.errorText(flushError));
        return;
      }
      this.drain();
    }
    this.hasPushed = true;
    // Demuxer timestamps are µs doubles; the HLS TS demuxer's PTS
    // discontinuity offset can yield fractional values (e.g. synthetic
    // 30 fps spacing), which BigInt() rejects — round to the nearest µs.
    const pushError = this.decoder.pushData(data, BigInt(Math.round(chunk.timestamp)));
    if (!this.module.isOk(pushError)) {
      this.fail('DECODE', this.errorText(pushError));
      return;
    }
    this.drain();
  }

  flush(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    const flushError = this.decoder.flushData();
    if (!this.module.isOk(flushError)) {
      this.fail('DECODE', this.errorText(flushError));
      return Promise.resolve();
    }
    // Pictures for the final access units are only released after flushData();
    // drain synchronously so every frame is delivered before the promise
    // resolves (verified: the interlaced fixture outputs 2 frames here).
    this.drain();
    return Promise.resolve();
  }

  reset(): void {
    this.pending = 0;
    this.decoder.reset();
    // libde265's reset drops its parameter-set state; the next chunk must
    // carry the VPS/SPS/PPS again.
    this.paramsPushed = false;
    this.hasPushed = false;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.decoder.delete();
  }

  get queueSize(): number {
    return this.pending;
  }

  /**
   * Drives the pull-model decode loop: keep calling `decode()` while it
   * reports progress (`more`), pull every available picture, and stop on a
   * hard error or on WAITING_FOR_INPUT_DATA (more bytes needed). Warning codes
   * (>= 1000) are OK and do not stop the loop.
   */
  private drain(): void {
    let more = true;
    while (more) {
      const result = this.decoder.decode();
      more = result.more;
      if (!this.module.isOk(result.error)) {
        if (result.error === this.module.Error.ERROR_WAITING_FOR_INPUT_DATA) {
          return;
        }
        this.fail('DECODE', this.errorText(result.error));
        return;
      }
      const image = this.decoder.getNextPicture();
      if (image !== null) {
        this.handleImage(image);
      }
    }
  }

  private handleImage(image: Libde265Image): void {
    try {
      const ptsUs = Number(image.pts);
      const codedWidth = image.getWidth(0);
      const codedHeight = image.getHeight(0);
      const frame = this.buildFrame(image, codedWidth, codedHeight, ptsUs);
      this.pending = Math.max(0, this.pending - 1);
      this.outputCb?.(frame, ptsUs);
    } finally {
      // Mandatory: the decoder's picture buffer must be released or decode()
      // starts failing with ERROR_IMAGE_BUFFER_FULL.
      image.delete();
    }
  }

  private buildFrame(
    image: Libde265Image,
    codedWidth: number,
    codedHeight: number,
    ptsUs: number,
  ): VideoFrame {
    const FrameCtor = (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;
    if (FrameCtor === undefined) {
      // Environments without WebCodecs (e.g. Node 22 smoke): deliver a
      // count-only null frame so the pipeline can still count output. The
      // cast is required by the interface, which is only ever driven with a
      // real VideoFrame in browsers.
      return null as unknown as VideoFrame;
    }
    try {
      const planar = this.buildPlanarFrame(FrameCtor, image, codedWidth, codedHeight, ptsUs);
      if (planar !== null) {
        return planar;
      }
      return this.buildCanvasFrame(FrameCtor, image, codedWidth, codedHeight, ptsUs);
    } catch {
      // e.g. Chromium rejecting a misaligned I420 buffer or a missing canvas:
      // surface the failure instead of throwing through the decode call.
      this.fail('DECODE', 'libde265: unable to construct a VideoFrame from the decoded picture');
      return null as unknown as VideoFrame;
    }
  }

  /**
   * Direct planar VideoFrame (I420/I422/I444) — the zero-conversion hot path.
   * Requires 8-bit samples and planes whose byte stride equals the sample
   * width: the wrapper's `bytes` slice is then the complete plane. Anything
   * else (10+ bit, mono, padded/misaligned strides) returns null so the caller
   * falls back to the canvas path.
   */
  private buildPlanarFrame(
    FrameCtor: typeof VideoFrame,
    image: Libde265Image,
    codedWidth: number,
    codedHeight: number,
    ptsUs: number,
  ): VideoFrame | null {
    const format = planarVideoFormat(image.chromaFormat, image.getBitsPerPixel(0));
    if (format === null) {
      return null;
    }
    const planes: Libde265ImagePlane[] = [
      image.getImagePlane(0),
      image.getImagePlane(1),
      image.getImagePlane(2),
    ];
    if (planes.some((plane) => plane.stride !== plane.width)) {
      return null;
    }
    const total = planes.reduce((sum, plane) => sum + plane.bytes.byteLength, 0);
    const buffer = new ArrayBuffer(total);
    const view = new Uint8Array(buffer);
    const layout: { offset: number; stride: number }[] = [];
    let offset = 0;
    for (const plane of planes) {
      view.set(plane.bytes, offset);
      layout.push({ offset, stride: plane.stride });
      offset += plane.bytes.byteLength;
    }
    return new FrameCtor(buffer, { format, codedWidth, codedHeight, timestamp: ptsUs, layout });
  }

  /** Slow fallback: YUV -> RGBA -> canvas -> VideoFrame(canvas). */
  private buildCanvasFrame(
    FrameCtor: typeof VideoFrame,
    image: Libde265Image,
    codedWidth: number,
    codedHeight: number,
    ptsUs: number,
  ): VideoFrame {
    const rgba = yuvToRgba(image, codedWidth, codedHeight);
    const canvas = document.createElement('canvas');
    canvas.width = codedWidth;
    canvas.height = codedHeight;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('libde265: 2d canvas context unavailable');
    }
    const imageData = context.createImageData(codedWidth, codedHeight);
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

  private errorText(error: number): string {
    return this.module.getErrorText(error);
  }
}

function planarVideoFormat(
  chromaFormat: number,
  bitsPerPixel: number,
): 'I420' | 'I422' | 'I444' | null {
  if (bitsPerPixel !== 8) {
    return null; // 10+ bit samples need the RGBA canvas path
  }
  switch (chromaFormat) {
    case 1: // module.Chroma.420
      return 'I420';
    case 2: // module.Chroma.422
      return 'I422';
    case 3: // module.Chroma.444
      return 'I444';
    default:
      return null; // mono has no planar VideoFrame format
  }
}

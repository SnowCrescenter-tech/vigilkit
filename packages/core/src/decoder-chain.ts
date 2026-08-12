import type { EncodedVideoChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { mediaError } from './errors.js';
import { VideoDecoderWrapper } from './decoder.js';
import type { VideoCodecDecoder, VideoDecoderHandlers } from './decoder.js';

/**
 * Factory for a soft (WASM/JS) decoder backend. `supports(codec)` is a
 * synchronous prefix/codec check (e.g. `/^(hvc1|hev1|hevc)/i`); `create()`
 * returns a fresh decoder instance that satisfies `VideoCodecDecoder`.
 */
export interface SoftVideoDecoderFactory {
  id: string;
  create(): VideoCodecDecoder;
  supports(codec: string): boolean;
}

export interface CodecRoutingOptions {
  /**
   * Builds a raw WebCodecs decoder. The wrapper's output/error wiring is
   * passed in because the native decoder's callbacks are fixed at
   * construction; the no-arg form `() => VideoDecoder` is assignable here.
   */
  createWebCodecs: (handlers: VideoDecoderHandlers) => VideoDecoder;
  softFactory?: SoftVideoDecoderFactory;
  forceSoft?: boolean;
}

type RoutingState = 'idle' | 'probing' | 'ready' | 'failed' | 'closed';

/**
 * Routes codec decoding to WebCodecs or to a soft decoder factory.
 *
 * `configure` is async-safe: while the `isConfigSupported` probe is in flight,
 * `decode` calls are buffered and flushed through the chosen implementation in
 * order once it is configured. Subscribers registered before the impl exists
 * are re-bound to it when it becomes ready. Routing that yields no decoder
 * surfaces an UNSUPPORTED error; DECODE errors from the impl pass through.
 */
export class CodecRoutingDecoder implements VideoCodecDecoder {
  private impl: VideoCodecDecoder | null = null;
  private outputCb: ((frame: VideoFrame, ptsUs: number) => void) | null = null;
  private errorCb: ((info: MediaErrorInfo) => void) | null = null;
  private readonly pending: EncodedVideoChunkData[] = [];
  private state: RoutingState = 'idle';
  private readonly opts: CodecRoutingOptions;

  constructor(opts: CodecRoutingOptions) {
    this.opts = opts;
  }

  configure(config: VideoDecoderConfig): void {
    if (this.state === 'closed') {
      return;
    }
    const soft = this.opts.softFactory;
    if (this.opts.forceSoft && soft !== undefined && soft.supports(config.codec)) {
      this.activateSoft(config);
      return;
    }
    const probe = this.probeSupport(config);
    if (probe === undefined) {
      this.activateWebCodecs(config);
      return;
    }
    this.state = 'probing';
    probe.then((supported) => {
      if (this.state === 'closed') {
        return;
      }
      if (supported) {
        this.activateWebCodecs(config);
      } else if (soft !== undefined && soft.supports(config.codec)) {
        this.activateSoft(config);
      } else {
        this.fail(config.codec);
      }
    });
  }

  decode(chunk: EncodedVideoChunkData): void {
    if (this.state === 'closed') {
      return;
    }
    if (this.impl !== null) {
      this.impl.decode(chunk);
      return;
    }
    // idle or probing: hold the chunk until the chosen impl is configured.
    this.pending.push(chunk);
  }

  flush(): Promise<void> {
    if (this.state === 'closed') {
      return Promise.resolve();
    }
    if (this.impl !== null) {
      return this.impl.flush();
    }
    // Nothing configured yet: nothing to drain, resolve immediately.
    return Promise.resolve();
  }

  reset(): void {
    if (this.state === 'closed') {
      return;
    }
    if (this.impl !== null) {
      this.impl.reset();
    }
    this.pending.length = 0;
  }

  close(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    if (this.impl !== null) {
      this.impl.close();
      this.impl = null;
    }
    this.pending.length = 0;
  }

  get queueSize(): number {
    // +1 keeps scheduler backpressure engaged while an impl is being chosen.
    if (this.impl !== null) {
      return this.impl.queueSize + 1;
    }
    return this.pending.length + 1;
  }

  onOutput(cb: (frame: VideoFrame, ptsUs: number) => void): void {
    this.outputCb = cb;
    if (this.impl !== null) {
      this.impl.onOutput(cb);
    }
  }

  onError(cb: (info: MediaErrorInfo) => void): void {
    this.errorCb = cb;
    if (this.impl !== null) {
      this.impl.onError(cb);
    }
  }

  private activateWebCodecs(config: VideoDecoderConfig): void {
    if (this.state === 'closed') {
      return;
    }
    this.activateImpl(new VideoDecoderWrapper(this.opts.createWebCodecs), config);
  }

  private activateSoft(config: VideoDecoderConfig): void {
    if (this.state === 'closed') {
      return;
    }
    const soft = this.opts.softFactory;
    if (soft === undefined) {
      this.fail(config.codec);
      return;
    }
    this.activateImpl(soft.create(), config);
  }

  private activateImpl(impl: VideoCodecDecoder, config: VideoDecoderConfig): void {
    if (this.state === 'closed') {
      // Closed while probing: drop the freshly built impl without leaking it.
      impl.close();
      return;
    }
    this.impl = impl;
    if (this.outputCb !== null) {
      impl.onOutput(this.outputCb);
    }
    if (this.errorCb !== null) {
      impl.onError(this.errorCb);
    }
    try {
      impl.configure(config);
    } catch {
      this.errorCb?.(mediaError('DECODE', 'decoder configure failed'));
    }
    for (const chunk of this.pending) {
      impl.decode(chunk);
    }
    this.pending.length = 0;
    this.state = 'ready';
  }

  private fail(codec: string): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'failed';
    this.pending.length = 0;
    this.errorCb?.(mediaError('UNSUPPORTED', `no decoder available for codec "${codec}"`));
  }

  private probeSupport(config: VideoDecoderConfig): Promise<boolean> | undefined {
    const ctor = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
    if (ctor === undefined || typeof ctor.isConfigSupported !== 'function') {
      return undefined;
    }
    try {
      return ctor.isConfigSupported(config).then(
        (support) => support.supported === true,
        // A throwing probe is treated as supported (WebCodecs path).
        () => true,
      );
    } catch {
      return Promise.resolve(true);
    }
  }
}

/** Small factory: a routing decoder is the default pipeline decoder. */
export function buildDecoder(opts: CodecRoutingOptions): VideoCodecDecoder {
  return new CodecRoutingDecoder(opts);
}

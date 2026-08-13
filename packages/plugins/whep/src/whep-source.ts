import type { DemuxerEvent, MediaSource, SourceOptions } from '@vigilkit/plugin-sdk';
import type { EncodedPipelineOptions } from './whep-encoded-pipeline.js';
import { EncodedMediaPipeline } from './whep-encoded-pipeline.js';
import { hasVideoMedia, resolvePatchUrl } from './whep-sdp.js';

/**
 * Structural view of a MediaStreamTrackProcessor (not in the TS DOM lib).
 * The WHEP source reads decoded `VideoFrame`s from `readable` and calls
 * `destroy()` on stop.
 */
export interface TrackProcessorLike {
  readonly readable: ReadableStream<VideoFrame>;
  destroy(): void;
}

export interface WhepSourceOptions extends SourceOptions {
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable RTCPeerConnection constructor for tests. Defaults to globalThis.RTCPeerConnection. */
  RTCPeerConnectionCtor?: new (configuration?: RTCConfiguration) => RTCPeerConnection;
  /** Injectable MediaStreamTrackProcessor constructor for tests. Defaults to globalThis.MediaStreamTrackProcessor. */
  MediaStreamTrackProcessorCtor?: new (init: { track: MediaStreamTrack }) => TrackProcessorLike;
  /**
   * When true, captures the encoded (RTP) media via `RTCRtpScriptTransform`
   * insertable streams instead of decoded `VideoFrame`s, feeding the engine's
   * encoded decode chain. **Chromium-only**: `RTCRtpScriptTransform` has no
   * Firefox or Safari support. Defaults to false (the direct-frame path).
   */
  encoded?: boolean;
  /** Injectable RTCRtpScriptTransform constructor for tests. Defaults to globalThis.RTCRtpScriptTransform. */
  RTCRtpScriptTransformCtor?: new (worker: Worker, options?: Record<string, unknown>) => unknown;
  /** Injectable worker factory for tests. Defaults to an inline blob worker. */
  createWorker?: () => Worker;
  /** Base URL used to resolve a relative `Location` header from the POST response. */
  location?: string;
}

interface WhepHandshake {
  /** Server SDP: an answer (201) or a counter-offer (406). */
  sdp: string;
  /** True when the server sent a counter-offer the client must answer. */
  offer: boolean;
  /** WHEP session URL for PATCH requests. */
  patchUrl: string;
  /** ETag from the POST response; bound to PATCHes via If-Match. */
  etag: string | null;
}

/** Error tagged UNSUPPORTED; everything else thrown by the source is TRANSPORT. */
class WhepUnsupportedError extends Error {
  readonly code = 'UNSUPPORTED' as const;
}

/**
 * WHEP (WebRTC-HTTP Egress Protocol) media source. Per draft-ietf-wish-whep:
 * POSTs an SDP offer to the resource URL, adopts the server's SDP answer (or,
 * on a 406 counter-offer, answers it via PATCH), trickles ICE candidates via
 * PATCH, and emits decoded `VideoFrame`s as `{ type: 'frame' }` events.
 * The engine renders the frames (they must never be closed by the source).
 */
export class WhepSource implements MediaSource {
  private readonly listeners = new Set<(event: DemuxerEvent) => void>();
  private stopped = false;
  private controller: AbortController | null = null;
  private pc: RTCPeerConnection | null = null;
  private processor: TrackProcessorLike | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private patchUrl: string | null = null;
  private etag: string | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private encodedPipeline: EncodedMediaPipeline | null = null;

  constructor(
    private readonly url: string,
    private readonly options: WhepSourceOptions = {},
  ) {}

  start(): void {
    if (this.stopped) return;
    void this.connect().catch((error) => {
      if (this.stopped) return;
      const info =
        error instanceof WhepUnsupportedError
          ? { code: 'UNSUPPORTED' as const, message: errorMessage(error) }
          : { code: 'TRANSPORT' as const, message: errorMessage(error) };
      this.dispatch({ type: 'error', error: info });
    });
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    const pc = this.pc;
    this.pc = null;
    if (pc !== null) pc.close();
    const processor = this.processor;
    this.processor = null;
    if (processor !== null) processor.destroy();
    const reader = this.reader;
    this.reader = null;
    if (reader !== null) void reader.cancel().catch(() => {});
    const pipeline = this.encodedPipeline;
    this.encodedPipeline = null;
    if (pipeline !== null) pipeline.detach();
  }

  onEvent(listener: (event: DemuxerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async connect(): Promise<void> {
    const encoded = this.options.encoded === true;
    const rtcCtor = this.options.RTCPeerConnectionCtor ?? globalThis.RTCPeerConnection;
    const processorCtor = this.options.MediaStreamTrackProcessorCtor ?? globalThis.MediaStreamTrackProcessor;
    const transformCtor = this.options.RTCRtpScriptTransformCtor ?? globalThis.RTCRtpScriptTransform;
    const usesDefaultWorker = this.options.createWorker === undefined;
    if (
      typeof rtcCtor === 'undefined' ||
      (!encoded && typeof processorCtor === 'undefined') ||
      (encoded && (typeof transformCtor === 'undefined' || (usesDefaultWorker && typeof globalThis.Worker === 'undefined')))
    ) {
      throw new WhepUnsupportedError('WebRTC or MediaStreamTrackProcessor is unavailable in this browser');
    }
    const pc = new rtcCtor();
    this.pc = pc;
    pc.ontrack = (event) => {
      if (encoded) this.handleTrackEncoded(event.track);
      else this.handleTrack(event.track, processorCtor);
    };
    pc.onicecandidate = (event) => {
      if (event.candidate !== null) this.queueCandidate(event.candidate.toJSON());
    };
    pc.oniceconnectionstatechange = () => this.handleIceState(pc);

    if (encoded) {
      // Reserve both m-lines so the SDP answer carries the audio+video
      // sections the encoded path feeds (RTCRtpScriptTransform is applied per
      // receiver, and only exists for m-lines present in the negotiated SDP).
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const handshake = await this.postOffer(pc.localDescription?.sdp ?? offer.sdp ?? '');
    this.patchUrl = handshake.patchUrl;
    this.etag = handshake.etag;
    try {
      await pc.setRemoteDescription({ type: handshake.offer ? 'offer' : 'answer', sdp: handshake.sdp });
    } catch (error) {
      throw new WhepUnsupportedError(`server returned invalid SDP: ${errorMessage(error)}`);
    }
    if (handshake.offer) {
      // The server rejected our offer (406) and sent a counter-offer: answer
      // it and send the answer back via PATCH (draft-ietf-wish-whep §4.3).
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.patchAnswer(answer.sdp ?? '');
    }
    if (encoded) {
      // Emit the SDP-provided configs (sprop-parameter-sets / Opus rtpmap)
      // before any frames: the workers are wired lazily on `ontrack`.
      this.encodedPipeline = new EncodedMediaPipeline(handshake.sdp, {
        emit: (event) => this.dispatch(event),
        RTCRtpScriptTransformCtor: this.options.RTCRtpScriptTransformCtor,
        createWorker: this.options.createWorker,
      });
    }
    await this.flushCandidates();
  }

  private async postOffer(sdp: string): Promise<WhepHandshake> {
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdp,
    });
    // A 406 is a valid WHEP response carrying a counter-offer (draft-ietf-wish-whep
    // §4.3): the client must answer it via PATCH. Every other non-2xx is fatal.
    if (!response.ok && response.status !== 406) {
      throw new Error(`WHEP POST failed (HTTP ${response.status})`);
    }
    const text = await response.text();
    if (!hasVideoMedia(text)) {
      throw new WhepUnsupportedError('WHEP response contains no video media section');
    }
    return {
      sdp: text,
      offer: response.status === 406,
      patchUrl: resolvePatchUrl(response.headers.get('Location'), this.options.location, this.url),
      etag: response.headers.get('ETag'),
    };
  }

  private async patchAnswer(sdp: string): Promise<void> {
    const patchUrl = this.patchUrl;
    if (patchUrl === null) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
    if (this.etag !== null) headers['If-Match'] = this.etag;
    const response = await this.fetch(patchUrl, { method: 'PATCH', headers, body: sdp });
    if (!response.ok && !this.stopped) {
      this.dispatch({
        type: 'error',
        error: { code: 'TRANSPORT', message: `WHEP answer PATCH failed (HTTP ${response.status})` },
      });
    }
  }

  private queueCandidate(candidate: RTCIceCandidateInit): void {
    if (this.patchUrl === null) {
      this.pendingCandidates.push(candidate);
      return;
    }
    void this.patchCandidate(candidate);
  }

  private async flushCandidates(): Promise<void> {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate === undefined) continue;
      await this.patchCandidate(candidate);
    }
  }

  private async patchCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const patchUrl = this.patchUrl;
    if (patchUrl === null) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/trickle-ice-sdpfrag' };
    if (this.etag !== null) headers['If-Match'] = this.etag;
    const response = await this.fetch(patchUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ candidate }),
    });
    if (!response.ok && !this.stopped) {
      this.dispatch({
        type: 'error',
        error: { code: 'TRANSPORT', message: `WHEP candidate PATCH failed (HTTP ${response.status})` },
      });
    }
  }

  private handleIceState(pc: RTCPeerConnection): void {
    if (this.stopped || this.pc !== pc) return;
    const state = pc.iceConnectionState;
    if (state === 'failed' || state === 'disconnected') {
      this.dispatch({ type: 'error', error: { code: 'TRANSPORT', message: `ICE connection ${state}` } });
    }
  }

  private handleTrack(
    track: MediaStreamTrack,
    ctor: new (init: { track: MediaStreamTrack }) => TrackProcessorLike,
  ): void {
    if (this.stopped) return;
    const processor = new ctor({ track });
    this.processor = processor;
    const reader = processor.readable.getReader();
    this.reader = reader;
    void this.readLoop(reader);
  }

  /**
   * Encoded path: attaches an `RTCRtpScriptTransform` to the track's receiver
   * via the encoded pipeline (which also owns the assembled event stream).
   */
  private handleTrackEncoded(track: MediaStreamTrack): void {
    if (this.stopped) return;
    const pc = this.pc;
    if (pc === null) return;
    this.encodedPipeline?.attachReceiver(pc, track);
  }

  private async readLoop(reader: ReadableStreamDefaultReader<VideoFrame>): Promise<void> {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        if (this.stopped) {
          // A frame that arrives after stop() is dropped and closed locally;
          // the engine owns every frame that was handed to it.
          result.value.close();
          break;
        }
        this.dispatch({ type: 'frame', frame: result.value });
      }
    } catch {
      // The reader was canceled by stop() (or the stream errored); the loop
      // must never throw into the engine.
    }
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    return fetchImpl(url, { ...init, signal: this.signal() });
  }

  private signal(): AbortSignal {
    if (this.controller === null) this.controller = new AbortController();
    return this.controller.signal;
  }

  private dispatch(event: DemuxerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

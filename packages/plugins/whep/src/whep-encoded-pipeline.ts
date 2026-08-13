import type { DemuxerEvent } from '@vigilkit/plugin-sdk';
import { buildAvcC, codecStringFromSps } from '@vigilkit/media-utils';
import type { EncodedAssemblerOptions, EncodedFrameMessage } from './whep-encoded.js';
import { EncodedMediaAssembler } from './whep-encoded.js';
import { parseSdpMedia } from './whep-sdp.js';

/**
 * Captures the encoded (RTP) media of a WHEP session via `RTCRtpScriptTransform`
 * insertable streams. Owns the transform workers + receiver bindings and the
 * main-thread `EncodedMediaAssembler`; the source only drives WHEP signalling
 * and delegates the media surface to this class. Chromium-only.
 */
export interface EncodedPipelineOptions {
  /** Forwards assembled demuxer events to the source's listeners. */
  emit: (event: DemuxerEvent) => void;
  /** Injectable RTCRtpScriptTransform constructor for tests. */
  RTCRtpScriptTransformCtor?: new (worker: Worker, options?: Record<string, unknown>) => unknown;
  /** Injectable worker factory for tests. Defaults to an inline blob worker. */
  createWorker?: () => Worker;
}

export class EncodedMediaPipeline {
  private readonly assembler: EncodedMediaAssembler;
  private readonly transformCtor: new (worker: Worker, options?: Record<string, unknown>) => unknown | undefined;
  private readonly createWorker: () => Worker;
  private readonly workers: Worker[] = [];
  private readonly receivers: RTCRtpReceiver[] = [];
  private detached = false;

  constructor(sdp: string, options: EncodedPipelineOptions) {
    this.transformCtor = options.RTCRtpScriptTransformCtor ?? globalThis.RTCRtpScriptTransform;
    this.createWorker = options.createWorker ?? defaultTransformWorker;
    this.assembler = new EncodedMediaAssembler(options.emit, buildSdpConfigs(sdp));
  }

  /**
   * Attaches an `RTCRtpScriptTransform` to the receiver carrying `track`. The
   * transform worker forwards every encoded frame to the main-thread
   * assembler (and never writes back to `transformer.writable`, so the
   * engine's decode chain owns the bitstream). The receiver's decoded track
   * stays black; it is never read in this mode.
   */
  attachReceiver(pc: RTCPeerConnection, track: MediaStreamTrack): void {
    if (this.detached) return;
    const receiver = pc.getReceivers().find((candidate) => candidate.track === track);
    if (receiver === undefined) return;
    const transformCtor = this.transformCtor;
    if (transformCtor === undefined) return;
    const worker = this.createWorker();
    const transform = new transformCtor(worker, { operation: 'encoded' });
    receiver.transform = transform as RTCRtpTransform;
    worker.onmessage = (event: MessageEvent) => this.handleMessage(event.data as EncodedFrameMessage);
    this.workers.push(worker);
    this.receivers.push(receiver);
  }

  handleMessage(message: EncodedFrameMessage): void {
    if (this.detached) return;
    this.assembler.handleEncodedMessage(message);
  }

  /** Terminates the workers and detaches the receiver transforms. Idempotent. */
  detach(): void {
    this.detached = true;
    for (const worker of this.workers.splice(0)) {
      worker.terminate();
    }
    for (const receiver of this.receivers.splice(0)) {
      receiver.transform = null;
    }
  }
}

/** SDP-derived configs (sprop-parameter-sets / Opus rtpmap) emitted before frames. */
function buildSdpConfigs(sdp: string): EncodedAssemblerOptions {
  const media = parseSdpMedia(sdp);
  const opts: EncodedAssemblerOptions = {};
  const video = media.find((entry) => entry.kind === 'video');
  if (video?.spsB64 !== undefined && video.ppsB64 !== undefined) {
    const sps = decodeBase64(video.spsB64);
    const pps = decodeBase64(video.ppsB64);
    if (sps.length >= 4 && pps.length > 0) {
      opts.videoConfigFromSdp = { codec: codecStringFromSps(sps), description: buildAvcC(sps, pps, 4) };
    }
  }
  const audio = media.find((entry) => entry.kind === 'audio');
  if (audio?.codec.toLowerCase() === 'opus' && audio.sampleRate !== undefined) {
    opts.audioConfigFromSdp = {
      codec: 'opus',
      sampleRate: audio.sampleRate,
      numberOfChannels: audio.channels ?? 2,
    };
  }
  return opts;
}

/**
 * The thin receive-transform worker. On `rtctransform` it reads every encoded
 * frame from the transformer's `readable`, posts `{ kind, type?, metadata,
 * data }` to the main thread (the frame's `data` ArrayBuffer is TRANSFERRED),
 * and never writes back to `transformer.writable` — the bitstream is owned by
 * the engine's decode chain from here on. Duck-typing (`type` is present only
 * on video frames) keeps the script environment-agnostic.
 */
const TRANSFORM_WORKER_SOURCE = `
self.onrtctransform = function (event) {
  const reader = event.transformer.readable.getReader();
  const pump = function () {
    reader.read().then(function (result) {
      if (result.done) return;
      const frame = result.value;
      const kind = typeof frame.type === 'string' ? 'video' : 'audio';
      const message = { kind: kind, metadata: frame.getMetadata(), data: frame.data };
      if (kind === 'video') message.type = frame.type;
      self.postMessage(message, [frame.data]);
      pump();
    });
  };
  pump();
};
`;

function defaultTransformWorker(): Worker {
  const url = URL.createObjectURL(new Blob([TRANSFORM_WORKER_SOURCE], { type: 'text/javascript' }));
  return new Worker(url);
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

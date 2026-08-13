import { vi } from 'vitest';
import type { WhepSourceOptions } from './whep-source.js';
import { WhepSource } from './whep-source.js';
import { RESOURCE_URL } from './whep-test-fixtures.js';
import { FakeRtc } from './whep-test-fixtures.js';

// Realistic H.264 parameter sets (same shapes as the HLS fixtures): SPS is
// baseline profile, level 3.1 → codec avc1.42001f.
export const SPS = [0x67, 0x42, 0x00, 0x1f, 0x95, 0xa8, 0x14, 0x01, 0x6e, 0x90];
export const PPS = [0x68, 0xce, 0x06, 0xe2];
export const IDR = [0x65, 0x88, 0x84, 0x00, 0x00]; // NAL type 5

/** Annex-B (start-code) framing — the format Chromium delivers per access unit. */
export function annexB(...nalus: number[][]): ArrayBuffer {
  const parts: Uint8Array[] = [];
  for (const nalu of nalus) {
    parts.push(Uint8Array.from([0, 0, 0, 1]), Uint8Array.from(nalu));
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out.buffer;
}

const spsB64 = Buffer.from(SPS).toString('base64');
const ppsB64 = Buffer.from(PPS).toString('base64');

/** Server answer carrying both m-lines with codec params (H264 + Opus). */
export const ENCODED_ANSWER_SDP = [
  'v=0',
  'o=- 2 2 IN IP4 127.0.0.1',
  's=-',
  'c=IN IP4 127.0.0.1',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 H264/90000',
  `a=fmtp:96 packetization-mode=1; sprop-parameter-sets=${spsB64},${ppsB64}`,
  'a=mid:0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=mid:1',
  '',
].join('\r\n');

/** Controllable Worker stand-in: emitMessage drives the pipeline's onmessage. */
export class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();

  emitMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

/** Records the worker + options an injected RTCRtpScriptTransform was built with. */
export class FakeTransform {
  worker: Worker;
  options: Record<string, unknown> | undefined;

  constructor(worker: Worker, options?: Record<string, unknown>) {
    this.worker = worker;
    this.options = options;
  }
}

export function makeEncodedSource(
  fetchImpl: typeof fetch,
  overrides: WhepSourceOptions = {},
): { source: WhepSource; rtc: FakeRtc; worker: FakeWorker; transform: FakeTransform } {
  const rtc = new FakeRtc();
  const worker = new FakeWorker();
  const transform = new FakeTransform(worker as unknown as Worker, { operation: 'encoded' });
  // `new` must hand connect()/handleTrack the pre-built fakes, not fresh ones.
  const rtcCtor = class extends FakeRtc {
    constructor() {
      super();
      return rtc;
    }
  };
  const transformCtor = (function (createdWorker: Worker, options?: Record<string, unknown>) {
    transform.worker = createdWorker;
    transform.options = options;
    return transform;
  }) as unknown as new (worker: Worker, options?: Record<string, unknown>) => unknown;
  const source = new WhepSource(RESOURCE_URL, {
    fetchImpl,
    encoded: true,
    RTCPeerConnectionCtor: rtcCtor as unknown as new (configuration?: RTCConfiguration) => RTCPeerConnection,
    RTCRtpScriptTransformCtor: transformCtor,
    createWorker: () => worker as unknown as Worker,
    ...overrides,
  });
  return { source, rtc, worker, transform };
}

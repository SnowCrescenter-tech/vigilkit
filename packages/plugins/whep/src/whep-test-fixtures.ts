import { vi } from 'vitest';
import type { WhepSourceOptions } from './whep-source.js';
import { WhepSource } from './whep-source.js';
import type { TrackProcessorLike } from './whep-source.js';

export const OFFER_SDP = [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:0',
  '',
].join('\r\n');

export const ANSWER_SDP = [
  'v=0',
  'o=- 2 2 IN IP4 127.0.0.1',
  's=-',
  'c=IN IP4 127.0.0.1',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:0',
  '',
].join('\r\n');

export const CLIENT_ANSWER_SDP = [
  'v=0',
  'o=- 3 3 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:0',
  '',
].join('\r\n');

export const NO_VIDEO_SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

export const RESOURCE_URL = 'https://whep.example/session';

export class FakeFrame {
  closed = false;

  constructor(readonly id: number) {}

  close(): void {
    this.closed = true;
  }
}

export class FakeRtc {
  localDescription: RTCSessionDescription | null = null;
  iceConnectionState: RTCIceConnectionState = 'new';
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  readonly close = vi.fn();
  readonly createOffer = vi.fn(async () => ({ type: 'offer', sdp: OFFER_SDP }));
  readonly createAnswer = vi.fn(async () => ({ type: 'answer', sdp: CLIENT_ANSWER_SDP }));
  readonly setLocalDescription = vi.fn(async (desc: RTCSessionDescriptionInit) => {
    this.localDescription = { type: desc.type, sdp: desc.sdp ?? '' } as RTCSessionDescription;
  });
  readonly setRemoteDescription = vi.fn(async (_desc: RTCSessionDescriptionInit) => {});

  emitTrack(track: MediaStreamTrack): void {
    this.ontrack?.({ track });
  }

  emitCandidate(candidate: RTCIceCandidate | null): void {
    this.onicecandidate?.({ candidate });
  }

  emitIceState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

/** Controllable reader: pushFrame resolves the loop's pending read(). */
export class FakeReader {
  readonly cancel = vi.fn(async () => {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) {
      resolve({ done: true, value: undefined });
    }
  });
  private closed = false;
  private readonly pending: Array<{ done: boolean; value?: FakeFrame }> = [];
  private readonly waiters: Array<(result: { done: boolean; value?: FakeFrame }) => void> = [];

  async read(): Promise<{ done: boolean; value?: FakeFrame }> {
    const next = this.pending.shift();
    if (next !== undefined) return next;
    if (this.closed) return { done: true, value: undefined };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  pushFrame(frame: FakeFrame): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: frame });
    } else {
      this.pending.push({ done: false, value: frame });
    }
  }
}

export class FakeProcessor {
  readonly destroy = vi.fn();

  constructor(readonly reader: FakeReader) {}

  get readable(): ReadableStream<VideoFrame> {
    return { getReader: () => this.reader } as unknown as ReadableStream<VideoFrame>;
  }
}

export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function makeFetch(options: {
  postStatus?: number;
  answerSdp?: string;
  location?: string | null;
  etag?: string | null;
  patchOk?: boolean;
} = {}): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const { postStatus = 201, answerSdp = ANSWER_SDP, location = '/whep/session/1', etag = 'sess-1', patchOk = true } = options;
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: init?.body ?? null,
    });
    if (method === 'POST') {
      const headers = new Headers();
      if (location !== null) headers.set('Location', location);
      if (etag !== null) headers.set('ETag', etag);
      return {
        ok: postStatus >= 200 && postStatus < 300,
        status: postStatus,
        headers,
        text: async () => answerSdp,
      } as Response;
    }
    return {
      ok: patchOk,
      status: patchOk ? 200 : 500,
      headers: new Headers(),
      text: async () => '',
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function makeSource(fetchImpl: typeof fetch, overrides?: WhepSourceOptions): {
  source: WhepSource;
  rtc: FakeRtc;
  reader: FakeReader;
  processor: FakeProcessor;
} {
  const rtc = new FakeRtc();
  const reader = new FakeReader();
  const processor = new FakeProcessor(reader);
  // `new` must hand connect() the pre-built fakes, not fresh instances.
  const rtcCtor = class extends FakeRtc {
    constructor() {
      super();
      return rtc;
    }
  };
  const processorCtor = class extends FakeProcessor {
    constructor(_init: { track: MediaStreamTrack }) {
      super(reader);
      return processor;
    }
  };
  const source = new WhepSource(RESOURCE_URL, {
    fetchImpl,
    RTCPeerConnectionCtor: rtcCtor as unknown as new (configuration?: RTCConfiguration) => RTCPeerConnection,
    MediaStreamTrackProcessorCtor: processorCtor as unknown as new (init: { track: MediaStreamTrack }) => TrackProcessorLike,
    ...overrides,
  });
  return { source, rtc, reader, processor };
}

export function fakeTrack(): MediaStreamTrack {
  return { kind: 'video', id: 'whep-track' } as unknown as MediaStreamTrack;
}

export function fakeCandidate(value: string): RTCIceCandidate {
  return { toJSON: () => ({ candidate: value }) } as unknown as RTCIceCandidate;
}

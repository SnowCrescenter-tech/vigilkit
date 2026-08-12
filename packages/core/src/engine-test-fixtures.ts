import { vi } from 'vitest';
import type {
  Demuxer,
  DemuxerEvent,
  MediaErrorInfo,
  MediaSource,
  SourcePlugin,
  Transport,
  TransportEvent,
} from '@vigilkit/plugin-sdk';
import { FakeSoftDecoder } from './fake-video-decoder.fixture.js';
import type { SoftVideoDecoderFactory } from './decoder-chain.js';
import type { RendererSurface } from './types.js';

export class FakeTransport implements Transport {
  closed = false;
  connectCount = 0;
  private listener: ((event: TransportEvent) => void) | null = null;

  connect(): void {
    this.connectCount++;
    this.listener?.({ type: 'open' });
  }

  close(): void {
    this.closed = true;
  }

  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emitData(data: Uint8Array): void {
    this.listener?.({ type: 'data', data });
  }
}

/**
 * Transport whose events are driven manually by the test. Unlike FakeTransport
 * it does not emit 'open' from connect(), so tests can exercise the connecting
 * window (timeouts, destroy-during-connect, close-before-open).
 */
export class ManualTransport implements Transport {
  closed = false;
  connectCount = 0;
  private listener: ((event: TransportEvent) => void) | null = null;

  connect(): void {
    this.connectCount++;
  }

  close(): void {
    this.closed = true;
  }

  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emitOpen(): void {
    this.listener?.({ type: 'open' });
  }

  emitData(data: Uint8Array): void {
    this.listener?.({ type: 'data', data });
  }

  emitClose(code = 1000): void {
    this.listener?.({ type: 'close', code });
  }

  emitError(error: MediaErrorInfo): void {
    this.listener?.({ type: 'error', error });
  }
}

/** Demuxer that turns transport bytes into a sequence-header + video chunks. */
export class DataDemuxer implements Demuxer {
  closed = false;
  private listener: ((event: DemuxerEvent) => void) | null = null;
  private emittedHeader = false;

  push(data: Uint8Array): void {
    if (!this.emittedHeader) {
      this.emittedHeader = true;
      this.listener?.({
        type: 'sequence-header',
        config: { codec: 'vp8', codedWidth: 640, codedHeight: 480 },
      });
    }
    const ptsUs = Math.round(performance.now() * 1000);
    this.listener?.({ type: 'video', chunk: { type: 'delta', timestamp: ptsUs, data } });
  }

  flush(): void {}

  onEvent(listener: (event: DemuxerEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeDemuxer implements Demuxer {
  closed = false;
  private listener: ((event: DemuxerEvent) => void) | null = null;

  push(): void {}

  flush(): void {}

  onEvent(listener: (event: DemuxerEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeMediaSource implements MediaSource {
  startCount = 0;
  stopped = false;
  private listener: ((event: DemuxerEvent) => void) | null = null;

  constructor(private readonly codec = 'vp8') {}

  start(): void {
    this.startCount++;
    this.listener?.({
      type: 'metadata',
      metadata: { hasAudio: false, hasVideo: true, codec: this.codec },
    });
    this.listener?.({
      type: 'sequence-header',
      config: { codec: this.codec, codedWidth: 640, codedHeight: 480 },
    });
    const ptsUs = Math.round(performance.now() * 1000);
    this.listener?.({
      type: 'video',
      chunk: { type: 'key', timestamp: ptsUs, data: new Uint8Array([1, 2, 3]) },
    });
  }

  stop(): void {
    this.stopped = true;
  }

  onEvent(listener: (event: DemuxerEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emitError(error: MediaErrorInfo): void {
    this.listener?.({ type: 'error', error });
  }
}

export function makeSourcePlugin(codec = 'vp8'): { plugin: SourcePlugin; get: () => FakeMediaSource | null } {
  let current: FakeMediaSource | null = null;
  return {
    plugin: {
      type: 'source',
      id: 'hls',
      mimeTypes: ['application/vnd.apple.mpegurl'],
      schemes: ['http', 'https'],
      create: (): MediaSource => {
        current = new FakeMediaSource(codec);
        return current;
      },
    },
    get: () => current,
  };
}

export function makeSoftFactory(): {
  factory: SoftVideoDecoderFactory;
  get: () => FakeSoftDecoder | null;
} {
  let current: FakeSoftDecoder | null = null;
  return {
    factory: {
      id: 'fake-soft',
      supports: (codec) => /^(hvc1|hev1|hevc)/i.test(codec),
      create: () => {
        current = new FakeSoftDecoder();
        return current;
      },
    },
    get: () => current,
  };
}

export function fakeRenderer(): RendererSurface {
  return {
    renderMode: 'canvas2d',
    draw: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

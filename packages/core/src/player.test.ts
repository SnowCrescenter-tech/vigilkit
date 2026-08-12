import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPlayer } from './player.js';
import { FakeEncodedVideoChunk, FakeVideoDecoder } from './fake-video-decoder.fixture.js';
import type {
  Demuxer,
  DemuxerEvent,
  MediaErrorInfo,
  Plugin,
  Transport,
  TransportEvent,
} from '@vigilkit/plugin-sdk';
import type { RendererSurface } from './types.js';

class FakeTransport implements Transport {
  readonly url: string;
  closed = false;
  connectCount = 0;
  private listener: ((event: TransportEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

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

  emitError(error: MediaErrorInfo): void {
    this.listener?.({ type: 'error', error });
  }
}

class FakeDemuxer implements Demuxer {
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

  emitError(error: MediaErrorInfo): void {
    this.listener?.({ type: 'error', error });
  }
}

interface Harness {
  transport: () => FakeTransport | null;
  demuxer: () => FakeDemuxer | null;
  plugins: Plugin[];
  renderer: RendererSurface;
}

function makeHarness(): Harness {
  const holder: { transport: FakeTransport | null; demuxer: FakeDemuxer | null } = {
    transport: null,
    demuxer: null,
  };
  const renderer: RendererSurface = {
    renderMode: 'canvas2d',
    draw: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
  const plugins: Plugin[] = [
    {
      type: 'transport',
      id: 'fake-ws',
      schemes: ['ws', 'wss'],
      create: (url: string): Transport => {
        holder.transport = new FakeTransport(url);
        return holder.transport;
      },
    },
    {
      type: 'demuxer',
      id: 'fake-flv',
      mimeTypes: ['video/x-flv'],
      schemes: ['flv'],
      create: (): Demuxer => {
        holder.demuxer = new FakeDemuxer();
        return holder.demuxer;
      },
    },
  ];
  return { transport: () => holder.transport, demuxer: () => holder.demuxer, plugins, renderer };
}

describe('createPlayer', () => {
  beforeEach(() => {
    FakeVideoDecoder.resetInstances();
    vi.useFakeTimers();
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('play pipes transport data through the demuxer and emits frames', () => {
    const { transport, plugins, renderer } = makeHarness();
    const player = createPlayer({ url: 'ws://host/stream', demuxer: 'flv', plugins, renderer });
    const frames: { frame: VideoFrame; ptsUs: number }[] = [];
    player.on('frame', (e) => frames.push(e));
    player.play();
    expect(player.getStats().state).toBe('playing');
    transport()!.emitData(new Uint8Array([1, 2, 3]));
    vi.advanceTimersByTime(100);
    expect(frames.length).toBeGreaterThan(0);
    expect(player.getStats().framesDecoded).toBeGreaterThan(0);
    expect(renderer.draw).toHaveBeenCalled();
  });

  it('surfaces transport errors as TRANSPORT and sets state error', () => {
    const { transport, plugins, renderer } = makeHarness();
    const player = createPlayer({ url: 'ws://host/stream', demuxer: 'flv', plugins, renderer });
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    player.play();
    transport()!.emitError({ code: 'TRANSPORT', message: 'socket closed' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('TRANSPORT');
    expect(player.getStats().state).toBe('error');
    expect(transport()!.closed).toBe(true);
  });

  it('surfaces demuxer errors as DEMUX', () => {
    const { demuxer, plugins, renderer } = makeHarness();
    const player = createPlayer({ url: 'ws://host/stream', demuxer: 'flv', plugins, renderer });
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    player.play();
    demuxer()!.emitError({ code: 'DEMUX', message: 'bad signature' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('DEMUX');
    expect(player.getStats().state).toBe('error');
  });

  it('surfaces decoder errors as DECODE', () => {
    const { transport, plugins, renderer } = makeHarness();
    const player = createPlayer({ url: 'ws://host/stream', demuxer: 'flv', plugins, renderer });
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    player.play();
    transport()!.emitData(new Uint8Array([1]));
    const fake = FakeVideoDecoder.instances.at(-1);
    expect(fake).toBeDefined();
    fake!.triggerError(new Error('decode exploded'));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('DECODE');
    expect(player.getStats().state).toBe('error');
  });

  it('resolves transport and demuxer plugins by scheme', () => {
    const { transport, demuxer, plugins, renderer } = makeHarness();
    const player = createPlayer({ url: 'wss://host/stream', demuxer: 'flv', plugins, renderer });
    player.play();
    expect(transport()).not.toBeNull();
    expect(demuxer()).not.toBeNull();
    expect(transport()!.url).toBe('wss://host/stream');
    expect(player.getStats().state).toBe('playing');
  });

  it('errors with UNSUPPORTED when no transport matches the url scheme', () => {
    const { transport, plugins, renderer } = makeHarness();
    const player = createPlayer({ url: 'rtsp://host/stream', demuxer: 'flv', plugins, renderer });
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    player.play();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('UNSUPPORTED');
    expect(transport()).toBeNull();
    expect(player.getStats().state).toBe('error');
  });

  it('destroy tears down everything and stops further events', () => {
    const { transport, demuxer, plugins, renderer } = makeHarness();
    const player = createPlayer({ url: 'ws://host/stream', demuxer: 'flv', plugins, renderer });
    const frames: { frame: VideoFrame; ptsUs: number }[] = [];
    player.on('frame', (e) => frames.push(e));
    player.play();
    transport()!.emitData(new Uint8Array([1]));
    vi.advanceTimersByTime(30);
    expect(frames.length).toBe(1);
    player.destroy();
    expect(transport()!.closed).toBe(true);
    expect(demuxer()!.closed).toBe(true);
    expect(renderer.destroy).toHaveBeenCalled();
    transport()!.emitData(new Uint8Array([2]));
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBe(1);
    expect(player.getStats().state).toBe('stopped');
  });

  it('pause stops stats progression but keeps the connection', () => {
    const { transport, plugins, renderer } = makeHarness();
    const player = createPlayer({ url: 'ws://host/stream', demuxer: 'flv', plugins, renderer });
    player.play();
    transport()!.emitData(new Uint8Array([1]));
    vi.advanceTimersByTime(30);
    const decodedAfterFirst = player.getStats().framesDecoded;
    expect(decodedAfterFirst).toBeGreaterThan(0);
    player.pause();
    expect(player.getStats().state).toBe('paused');
    expect(transport()!.closed).toBe(false);
    transport()!.emitData(new Uint8Array([2]));
    vi.advanceTimersByTime(1000);
    expect(player.getStats().framesDecoded).toBe(decodedAfterFirst);
  });
});

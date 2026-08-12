import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPlayer } from './player.js';
import { FakeEncodedVideoChunk, FakeVideoDecoder } from './fake-video-decoder.fixture.js';
import {
  DataDemuxer,
  FakeDemuxer,
  FakeMediaSource,
  FakeTransport,
  ManualTransport,
  fakeRenderer,
  makeSoftFactory,
  makeSourcePlugin,
} from './engine-test-fixtures.js';
import type { Demuxer, MediaErrorInfo, Plugin, SourceOptions, SourcePlugin, Transport } from '@vigilkit/plugin-sdk';
import type { PlayerOptions, RendererSurface } from './types.js';

/** Transport-path harness: a ManualTransport + a DataDemuxer behind plugins. */
function makeDemuxerPipeline(
  transport: Transport,
  renderer: RendererSurface = fakeRenderer(),
  pump?: PlayerOptions['pump'],
): {
  player: ReturnType<typeof createPlayer>;
  demuxer: () => Demuxer | null;
} {  const holder: { demuxer: Demuxer | null } = { demuxer: null };
  const transportPlugin: Plugin = {
    type: 'transport',
    id: 'fake-ws',
    schemes: ['ws', 'wss'],
    create: () => transport,
  };
  const demuxerPlugin: Plugin = {
    type: 'demuxer',
    id: 'fake-flv',
    mimeTypes: ['video/x-flv'],
    schemes: ['flv'],
    create: () => {
      holder.demuxer = new DataDemuxer();
      return holder.demuxer;
    },
  };
  const player = createPlayer({
    url: 'ws://host/stream',
    demuxer: 'flv',
    plugins: [transportPlugin, demuxerPlugin],
    renderer,
    pump,
  });
  return { player, demuxer: () => holder.demuxer };
}

/** Renderer whose draw() is a typed vitest mock (draw: vi.fn() infers Mock). */
function mockRenderer() {
  return {
    renderMode: 'canvas2d' as const,
    draw: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

describe('Engine source plugins', () => {
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

  it('plays a source plugin stream: metadata/sequence-header/video frames render', () => {
    const src = makeSourcePlugin();
    const renderer = fakeRenderer();
    const player = createPlayer({
      url: 'hls://host/stream.m3u8',
      demuxer: 'hls',
      plugins: [src.plugin],
      renderer,
    });
    const frames: { frame: VideoFrame; ptsUs: number }[] = [];
    player.on('frame', (e) => frames.push(e));
    player.play();
    vi.advanceTimersByTime(100);
    expect(src.get()).not.toBeNull();
    expect(src.get()!.startCount).toBe(1);
    expect(frames.length).toBeGreaterThan(0);
    expect(player.getStats().framesDecoded).toBeGreaterThan(0);
    expect(renderer.draw).toHaveBeenCalled();
  });

  it('destroy() stops the source', () => {
    const src = makeSourcePlugin();
    const player = createPlayer({
      url: 'hls://host/stream.m3u8',
      demuxer: 'hls',
      plugins: [src.plugin],
      renderer: fakeRenderer(),
    });
    player.play();
    player.destroy();
    expect(src.get()!.stopped).toBe(true);
  });

  it('surfaces source errors as an error event with state error', () => {
    const src = makeSourcePlugin();
    const player = createPlayer({
      url: 'hls://host/stream.m3u8',
      demuxer: 'hls',
      plugins: [src.plugin],
      renderer: fakeRenderer(),
    });
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    player.play();
    src.get()!.emitError({ code: 'DEMUX', message: 'bad manifest' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('DEMUX');
    expect(player.getStats().state).toBe('error');
    expect(src.get()!.stopped).toBe(true);
  });

  it('resolves a source plugin by URL scheme when demuxer id does not match', () => {
    const src = makeSourcePlugin();
    const renderer = fakeRenderer();
    const player = createPlayer({
      url: 'hls://host/stream.m3u8',
      demuxer: 'does-not-exist',
      plugins: [src.plugin],
      renderer,
    });
    player.play();
    vi.advanceTimersByTime(100);
    expect(src.get()).not.toBeNull();
    expect(player.getStats().state).toBe('playing');
    expect(renderer.draw).toHaveBeenCalled();
  });

  it('prefers the demuxer plugin over a source plugin when both match', () => {
    const src = makeSourcePlugin();
    let demuxer: FakeDemuxer | null = null;
    const demuxerPlugin: Plugin = {
      type: 'demuxer',
      id: 'hls-demuxer',
      mimeTypes: ['application/x-mpegurl'],
      schemes: ['hls'],
      create: () => {
        demuxer = new FakeDemuxer();
        return demuxer;
      },
    };
    const transportPlugin: Plugin = {
      type: 'transport',
      id: 'fake-ws',
      schemes: ['ws', 'wss'],
      create: () => new FakeTransport(),
    };
    const player = createPlayer({
      url: 'ws://host/stream',
      demuxer: 'hls',
      plugins: [transportPlugin, demuxerPlugin, src.plugin],
      renderer: fakeRenderer(),
    });
    player.play();
    expect(demuxer).not.toBeNull();
    expect(src.get()).toBeNull();
    expect(player.getStats().state).toBe('playing');
  });

  it('passes sourceOptions through to the source plugin create()', () => {
    let receivedOptions: SourceOptions | undefined;
    let source: FakeMediaSource | null = null;
    const plugin: SourcePlugin = {
      type: 'source',
      id: 'hls',
      mimeTypes: ['application/vnd.apple.mpegurl'],
      schemes: ['http', 'https'],
      create: (_url, options) => {
        receivedOptions = options;
        source = new FakeMediaSource();
        return source;
      },
    };
    const player = createPlayer({
      url: 'hls://host/stream.m3u8',
      demuxer: 'hls',
      plugins: [plugin],
      renderer: fakeRenderer(),
      sourceOptions: { variant: 'highest' },
    });
    player.play();
    expect(receivedOptions).toEqual({ variant: 'highest' });
    expect(source).not.toBeNull();
  });

  it('uses the soft decoder when forceSoft is set and the factory supports the codec', () => {
    const src = makeSourcePlugin('hvc1.1.6.L123.90');
    const soft = makeSoftFactory();
    const renderer = fakeRenderer();
    const player = createPlayer({
      url: 'hls://host/stream.m3u8',
      demuxer: 'hls',
      plugins: [src.plugin],
      renderer,
      softDecoder: { factory: soft.factory },
      forceSoft: true,
    });
    player.play();
    vi.advanceTimersByTime(100);
    expect(soft.get()).not.toBeNull();
    expect(FakeVideoDecoder.instances).toHaveLength(0);
    expect(player.getStats().framesDecoded).toBeGreaterThan(0);
    expect(renderer.draw).toHaveBeenCalled();
  });

  it('accepts a webgpu render surface without a dedicated renderer yet', () => {
    const src = makeSourcePlugin();
    const renderer: RendererSurface = {
      renderMode: 'webgpu',
      draw: vi.fn(),
      resize: vi.fn(),
      destroy: vi.fn(),
    };
    const player = createPlayer({
      url: 'hls://host/stream.m3u8',
      demuxer: 'hls',
      plugins: [src.plugin],
      renderer,
    });
    player.play();
    vi.advanceTimersByTime(100);
    expect(renderer.draw).toHaveBeenCalled();
  });
});

describe('Engine transport pipeline', () => {
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

  it('a transport that never opens surfaces a TRANSPORT connect-timeout error', () => {
    const transport = new ManualTransport();
    const { player } = makeDemuxerPipeline(transport);
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    player.play();
    expect(player.getStats().state).toBe('connecting');
    vi.advanceTimersByTime(10_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('TRANSPORT');
    expect(errors[0]?.message).toBe('connect timeout');
    expect(player.getStats().state).toBe('error');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a clean transport close transitions to stopped and stops decoding', () => {
    const transport = new ManualTransport();
    const { player } = makeDemuxerPipeline(transport);
    const errors: MediaErrorInfo[] = [];
    const frames: { frame: VideoFrame; ptsUs: number }[] = [];
    player.on('error', (e) => errors.push(e));
    player.on('frame', (e) => frames.push(e));
    player.play();
    transport.emitOpen();
    expect(player.getStats().state).toBe('playing');
    transport.emitData(new Uint8Array([1]));
    vi.advanceTimersByTime(30);
    const decodedBeforeClose = player.getStats().framesDecoded;
    expect(decodedBeforeClose).toBeGreaterThan(0);
    transport.emitClose(1000);
    expect(player.getStats().state).toBe('stopped');
    expect(errors).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(player.getStats().framesDecoded).toBe(decodedBeforeClose);
    expect(player.getStats().framesDropped).toBe(0);
  });

  it('a transport plugin whose create() throws surfaces a TRANSPORT error instead of throwing from play()', () => {
    const transportPlugin: Plugin = {
      type: 'transport',
      id: 'fake-ws',
      schemes: ['ws', 'wss'],
      create: () => {
        throw new Error('malformed ws url');
      },
    };
    const demuxerPlugin: Plugin = {
      type: 'demuxer',
      id: 'fake-flv',
      mimeTypes: ['video/x-flv'],
      schemes: ['flv'],
      create: () => new DataDemuxer(),
    };
    const player = createPlayer({
      url: 'ws://host/stream',
      demuxer: 'flv',
      plugins: [transportPlugin, demuxerPlugin],
      renderer: fakeRenderer(),
    });
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    expect(() => player.play()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('TRANSPORT');
    expect(errors[0]?.message).toBe('malformed ws url');
    expect(player.getStats().state).toBe('error');
  });

  it('a demuxer plugin whose create() throws surfaces an UNSUPPORTED error instead of throwing from play()', () => {
    const transportPlugin: Plugin = {
      type: 'transport',
      id: 'fake-ws',
      schemes: ['ws', 'wss'],
      create: () => new ManualTransport(),
    };
    const demuxerPlugin: Plugin = {
      type: 'demuxer',
      id: 'fake-flv',
      mimeTypes: ['video/x-flv'],
      schemes: ['flv'],
      create: () => {
        throw new Error('no demuxer for stream');
      },
    };
    const player = createPlayer({
      url: 'ws://host/stream',
      demuxer: 'flv',
      plugins: [transportPlugin, demuxerPlugin],
      renderer: fakeRenderer(),
    });
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    expect(() => player.play()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('UNSUPPORTED');
    expect(errors[0]?.message).toBe('no demuxer for stream');
    expect(player.getStats().state).toBe('error');
  });

  it('a source plugin whose create() throws surfaces an UNSUPPORTED error instead of throwing from play()', () => {
    const sourcePlugin: SourcePlugin = {
      type: 'source',
      id: 'hls',
      mimeTypes: ['application/vnd.apple.mpegurl'],
      schemes: ['http', 'https'],
      create: () => {
        throw new Error('manifest plugin exploded');
      },
    };
    const player = createPlayer({
      url: 'hls://host/stream.m3u8',
      demuxer: 'hls',
      plugins: [sourcePlugin],
      renderer: fakeRenderer(),
    });
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    expect(() => player.play()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('UNSUPPORTED');
    expect(errors[0]?.message).toBe('manifest plugin exploded');
    expect(player.getStats().state).toBe('error');
  });

  it('a renderer whose draw() throws surfaces a RENDERER error', () => {
    const transport = new ManualTransport();
    const renderer = mockRenderer();
    renderer.draw.mockImplementation(() => {
      throw new Error('gpu exploded');
    });
    const { player } = makeDemuxerPipeline(transport, renderer);
    const errors: MediaErrorInfo[] = [];
    player.on('error', (e) => errors.push(e));
    player.play();
    transport.emitOpen();
    transport.emitData(new Uint8Array([1]));
    vi.advanceTimersByTime(30);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('RENDERER');
    expect(errors[0]?.message).toBe('gpu exploded');
    expect(player.getStats().state).toBe('error');
  });

  it('play() after pause resumes the pump and reaches playing', () => {
    const transport = new ManualTransport();
    const { player } = makeDemuxerPipeline(transport);
    const frames: { frame: VideoFrame; ptsUs: number }[] = [];
    player.on('frame', (e) => frames.push(e));
    player.play();
    transport.emitOpen();
    transport.emitData(new Uint8Array([1]));
    vi.advanceTimersByTime(30);
    const decodedAfterFirst = player.getStats().framesDecoded;
    expect(decodedAfterFirst).toBeGreaterThan(0);
    player.pause();
    expect(player.getStats().state).toBe('paused');
    transport.emitData(new Uint8Array([2]));
    vi.advanceTimersByTime(100);
    expect(player.getStats().framesDecoded).toBe(decodedAfterFirst);
    player.play();
    expect(player.getStats().state).toBe('playing');
    transport.emitData(new Uint8Array([3]));
    vi.advanceTimersByTime(100);
    expect(player.getStats().framesDecoded).toBeGreaterThan(decodedAfterFirst);
  });

  it('play() after an error restarts the pipeline with fresh transport/demuxer', () => {
    const holder: { transport: ManualTransport | null; demuxer: DataDemuxer | null } = {
      transport: null,
      demuxer: null,
    };
    const transportPlugin: Plugin = {
      type: 'transport',
      id: 'fake-ws',
      schemes: ['ws', 'wss'],
      create: () => {
        holder.transport = new ManualTransport();
        return holder.transport;
      },
    };
    const demuxerPlugin: Plugin = {
      type: 'demuxer',
      id: 'fake-flv',
      mimeTypes: ['video/x-flv'],
      schemes: ['flv'],
      create: () => {
        holder.demuxer = new DataDemuxer();
        return holder.demuxer;
      },
    };
    const player = createPlayer({
      url: 'ws://host/stream',
      demuxer: 'flv',
      plugins: [transportPlugin, demuxerPlugin],
      renderer: fakeRenderer(),
    });
    player.play();
    const firstTransport = holder.transport!;
    const firstDemuxer = holder.demuxer!;
    firstTransport.emitOpen();
    firstTransport.emitError({ code: 'TRANSPORT', message: 'socket died' });
    expect(player.getStats().state).toBe('error');
    const frames: { frame: VideoFrame; ptsUs: number }[] = [];
    player.on('frame', (e) => frames.push(e));
    player.play();
    expect(player.getStats().state).toBe('connecting');
    expect(holder.transport).not.toBe(firstTransport);
    expect(holder.demuxer).not.toBe(firstDemuxer);
    expect(firstTransport.closed).toBe(true);
    expect(firstDemuxer.closed).toBe(true);
    holder.transport!.emitOpen();
    expect(player.getStats().state).toBe('playing');
    holder.transport!.emitData(new Uint8Array([1]));
    vi.advanceTimersByTime(100);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('destroy() during connecting is safe and suppresses late open/data', () => {
    const transport = new ManualTransport();
    const { player } = makeDemuxerPipeline(transport);
    const frames: { frame: VideoFrame; ptsUs: number }[] = [];
    const errors: MediaErrorInfo[] = [];
    player.on('frame', (e) => frames.push(e));
    player.on('error', (e) => errors.push(e));
    player.play();
    expect(player.getStats().state).toBe('connecting');
    player.destroy();
    expect(player.getStats().state).toBe('stopped');
    expect(transport.closed).toBe(true);
    expect(() => {
      transport.emitOpen();
      transport.emitData(new Uint8Array([1]));
    }).not.toThrow();
    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    expect(errors).toHaveLength(0);
    expect(player.getStats().state).toBe('stopped');
  });
});

describe('Engine pump', () => {
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

  it('ticks via an injected one-shot rAF driver (one request per tick)', () => {
    const src = makeSourcePlugin();
    const renderer = fakeRenderer();
    const pending = new Map<number, () => void>();
    let nextId = 1;
    const fireNext = (): void => {
      const entry = pending.entries().next();
      if (entry.done) {
        return;
      }
      const [id, cb] = entry.value;
      pending.delete(id);
      cb();
    };
    const player = createPlayer({
      url: 'hls://host/stream.m3u8',
      demuxer: 'hls',
      plugins: [src.plugin],
      renderer,
      pump: {
        requestFrame: (cb) => {
          const id = nextId++;
          pending.set(id, cb);
          return id;
        },
        cancelFrame: (id) => pending.delete(id),
      },
    });
    const frames: { frame: VideoFrame; ptsUs: number }[] = [];
    player.on('frame', (e) => frames.push(e));
    player.play();
    expect(pending.size).toBe(1); // the pump requested its first frame
    fireNext();
    expect(pending.size).toBe(1); // re-armed after the tick
    expect(frames).toHaveLength(1);
    expect(renderer.draw).toHaveBeenCalled();
    player.destroy();
    expect(pending.size).toBe(0); // stop canceled the pending request
  });

  it('interval-style pump drivers keep the pipeline draining under fake timers', () => {
    const transport = new ManualTransport();
    const renderer = fakeRenderer();
    const { player } = makeDemuxerPipeline(transport, renderer, {
      requestFrame: (cb) => setTimeout(cb, 30),
      cancelFrame: (id) => clearTimeout(id),
    });
    const frames: { frame: VideoFrame; ptsUs: number }[] = [];
    player.on('frame', (e) => frames.push(e));
    player.play();
    transport.emitOpen();
    transport.emitData(new Uint8Array([1]));
    vi.advanceTimersByTime(29);
    expect(frames).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(frames).toHaveLength(1);
    transport.emitData(new Uint8Array([2]));
    vi.advanceTimersByTime(30);
    expect(frames).toHaveLength(2);
  });
});
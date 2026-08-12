import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPlayer } from './player.js';
import { Engine } from './engine.js';
import { FakeEncodedVideoChunk, FakeVideoDecoder } from './fake-video-decoder.fixture.js';
import {
  FakeAudioContext,
  FakeAudioDecoder,
  FakeEncodedAudioChunk,
} from './fake-audio.fixture.js';
import {
  DataDemuxer,
  FakeDemuxer,
  FakeMediaSource,
  FakeTransport,
  ManualAudioDemuxer,
  ManualTransport,
  fakeRenderer,
  makeAudioSourcePlugin,
  makeSoftFactory,
  makeSourcePlugin,
} from './engine-test-fixtures.js';
import type { Demuxer, DemuxerEvent, MediaErrorInfo, MediaSource, Plugin, SourceOptions, SourcePlugin, Transport } from '@vigilkit/plugin-sdk';
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

/** MediaSource emitting a single direct-decoded `frame` event on start(). */
class FrameSource implements MediaSource {
  stopped = false;
  private listener: ((event: DemuxerEvent) => void) | null = null;

  constructor(private readonly frame: VideoFrame) {}

  start(): void {
    this.listener?.({ type: 'frame', frame: this.frame });
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
}

function makeFrameSourcePlugin(frame: VideoFrame): SourcePlugin {
  return {
    type: 'source',
    id: 'whep',
    mimeTypes: ['application/whep'],
    schemes: [],
    create: () => new FrameSource(frame),
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

  it('a frame event draws on the renderer and closes when the renderer is null', () => {
    const drawnFrame = { close: vi.fn() } as unknown as VideoFrame;
    const renderer = fakeRenderer();
    const player = createPlayer({
      url: 'https://example.invalid/whep',
      demuxer: 'whep',
      plugins: [makeFrameSourcePlugin(drawnFrame)],
      renderer,
    });
    player.play();
    // The renderer owns the frame: drawn, not closed by the engine.
    expect(renderer.draw).toHaveBeenCalledWith(drawnFrame);
    expect(drawnFrame.close).not.toHaveBeenCalled();
    expect(player.getStats().framesDecoded).toBe(1);

    const closedFrame = { close: vi.fn() } as unknown as VideoFrame;
    const player2 = createPlayer({
      url: 'https://example.invalid/whep',
      demuxer: 'whep',
      plugins: [makeFrameSourcePlugin(closedFrame)],
      renderer: null,
    });
    player2.play();
    expect(closedFrame.close).toHaveBeenCalledOnce();
    expect(player2.getStats().framesDecoded).toBe(1);
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

describe('Engine audio pipeline', () => {
  beforeEach(() => {
    FakeVideoDecoder.resetInstances();
    FakeAudioDecoder.resetInstances();
    FakeAudioContext.resetInstances();
    vi.useFakeTimers();
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
    vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const AUDIO_CONFIG: AudioDecoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate: 48000,
    numberOfChannels: 2,
  };

  /** Transport-path harness with an injectable fake AudioDecoder factory. */
  function makeAudioEngine(
    transport: Transport,
    opts: { audio?: boolean; now?: () => number } = {},
  ): { engine: Engine; demuxer: () => ManualAudioDemuxer | null } {
    const holder: { demuxer: ManualAudioDemuxer | null } = { demuxer: null };
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
        holder.demuxer = new ManualAudioDemuxer();
        return holder.demuxer;
      },
    };
    const engine = new Engine(
      {
        url: 'ws://host/stream',
        demuxer: 'flv',
        plugins: [transportPlugin, demuxerPlugin],
        renderer: fakeRenderer(),
        audio: opts.audio,
        now: opts.now,
      },
      undefined,
      (handlers) => new FakeAudioDecoder(handlers) as unknown as AudioDecoder,
    );
    return { engine, demuxer: () => holder.demuxer };
  }

  it('audio-config + audio chunks drive the AudioDecoder and AudioOutput', () => {
    const transport = new ManualTransport();
    const { engine, demuxer } = makeAudioEngine(transport);
    const errors: MediaErrorInfo[] = [];
    engine.on('error', (e) => errors.push(e));
    engine.play();
    transport.emitOpen();
    demuxer()!.emitAudioConfig(AUDIO_CONFIG);
    demuxer()!.emitAudio({ type: 'key', timestamp: 1_000_000, data: new Uint8Array([0x21, 0x10]) });
    demuxer()!.emitAudio({ type: 'delta', timestamp: 2_000_000, data: new Uint8Array([0x22, 0x10]) });
    expect(FakeAudioDecoder.instances).toHaveLength(1);
    expect(FakeAudioDecoder.instances[0]!.configureCalls).toEqual([AUDIO_CONFIG]);
    expect(FakeAudioDecoder.instances[0]!.decodeCalls).toHaveLength(2);
    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.buffers).toHaveLength(2);
    expect(ctx.sources).toHaveLength(2);
    expect(engine.getStats().audioFramesDecoded).toBe(2);
    expect(errors).toHaveLength(0);
  });

  it('audio:false ignores audio events entirely', () => {
    const transport = new ManualTransport();
    const { engine, demuxer } = makeAudioEngine(transport, { audio: false });
    const errors: MediaErrorInfo[] = [];
    engine.on('error', (e) => errors.push(e));
    engine.play();
    transport.emitOpen();
    demuxer()!.emitAudioConfig(AUDIO_CONFIG);
    demuxer()!.emitAudio({ type: 'key', timestamp: 1_000_000, data: new Uint8Array([1]) });
    expect(FakeAudioDecoder.instances).toHaveLength(0);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(engine.getStats().audioFramesDecoded).toBe(0);
    expect(errors).toHaveLength(0);
  });

  it('first audio activation re-bases the video clock (resync)', () => {
    const transport = new ManualTransport();
    let wallMs = 0;
    const { engine, demuxer } = makeAudioEngine(transport, { now: () => wallMs });
    engine.play();
    transport.emitOpen();
    // A video chunk establishes a wall-clock base first.
    demuxer()!.emitSequenceHeader({ codec: 'vp8', codedWidth: 640, codedHeight: 480 });
    demuxer()!.emitVideo({ type: 'key', timestamp: 1_000_000, data: new Uint8Array([1]) });
    vi.advanceTimersByTime(30);
    expect(engine.getStats().framesDecoded).toBe(1);
    // Audio activates: decode + schedule flips the master to audio media time.
    demuxer()!.emitAudioConfig(AUDIO_CONFIG);
    demuxer()!.emitAudio({ type: 'key', timestamp: 5_000_000, data: new Uint8Array([1]) });
    expect(engine.getStats().audioFramesDecoded).toBe(1);
    const ctx = FakeAudioContext.instances[0]!;
    // Advance the audio master clock; the wall clock jumps far ahead too.
    ctx.currentTime = 10;
    wallMs = 1_000_000;
    // Master time is now 5_000_000 + (10 - 0.25) * 1e6 = 14_750_000 碌s.
    demuxer()!.emitVideo({ type: 'delta', timestamp: 14_750_000, data: new Uint8Array([2]) });
    vi.advanceTimersByTime(30);
    // Without the resync this chunk would be hopelessly late vs the 0-based
    // clock and dropped.
    expect(engine.getStats().framesDropped).toBe(0);
    expect(engine.getStats().framesDecoded).toBe(2);
  });

  it('audio decoder error surfaces as a DECODE error event', () => {
    const transport = new ManualTransport();
    const { engine, demuxer } = makeAudioEngine(transport);
    const errors: MediaErrorInfo[] = [];
    engine.on('error', (e) => errors.push(e));
    engine.play();
    transport.emitOpen();
    demuxer()!.emitAudioConfig(AUDIO_CONFIG);
    FakeAudioDecoder.instances[0]!.triggerError(new Error('aac exploded'));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('DECODE');
    expect(errors[0]?.message).toBe('aac exploded');
    expect(engine.getStats().state).toBe('error');
  });

  it('audio-only stream reaches playing and counts audio frames', () => {
    const src = makeAudioSourcePlugin();
    const engine = new Engine(
      {
        url: 'hls://host/stream.m3u8',
        demuxer: 'hls',
        plugins: [src.plugin],
        renderer: fakeRenderer(),
      },
      undefined,
      (handlers) => new FakeAudioDecoder(handlers) as unknown as AudioDecoder,
    );
    engine.play();
    expect(engine.getStats().state).toBe('playing');
    expect(FakeAudioDecoder.instances).toHaveLength(1);
    expect(engine.getStats().audioFramesDecoded).toBeGreaterThan(0);
  });

  it('destroy() closes the audio pipeline', () => {
    const transport = new ManualTransport();
    const { engine, demuxer } = makeAudioEngine(transport);
    engine.play();
    transport.emitOpen();
    demuxer()!.emitAudioConfig(AUDIO_CONFIG);
    demuxer()!.emitAudio({ type: 'key', timestamp: 1_000_000, data: new Uint8Array([1]) });
    const fake = FakeAudioDecoder.instances[0]!;
    const ctx = FakeAudioContext.instances[0]!;
    engine.destroy();
    expect(fake.closed).toBe(true);
    expect(ctx.closeCount).toBe(1);
  });
});
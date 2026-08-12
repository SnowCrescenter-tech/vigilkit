import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPlayer } from './player.js';
import { FakeEncodedVideoChunk, FakeVideoDecoder } from './fake-video-decoder.fixture.js';
import {
  FakeDemuxer,
  FakeMediaSource,
  FakeTransport,
  fakeRenderer,
  makeSoftFactory,
  makeSourcePlugin,
} from './engine-test-fixtures.js';
import type { MediaErrorInfo, Plugin, SourceOptions, SourcePlugin } from '@vigilkit/plugin-sdk';
import type { RendererSurface } from './types.js';

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
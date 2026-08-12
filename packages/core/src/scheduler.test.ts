import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Scheduler } from './scheduler.js';
import { VideoDecoderWrapper } from './decoder.js';
import type { EncodedVideoChunkData } from '@vigilkit/plugin-sdk';
import {
  FakeEncodedVideoChunk,
  FakeVideoDecoder,
  FakeVideoFrame,
} from './fake-video-decoder.fixture.js';
import type { RendererSurface } from './types.js';

function fakeRenderer(): RendererSurface {
  return {
    renderMode: 'webgl2',
    draw: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeScheduler(
  renderer: RendererSurface | null,
  opts: { latencyBudgetMs?: number; now?: () => number } = {},
) {
  let fake: FakeVideoDecoder | null = null;
  const wrapper = new VideoDecoderWrapper((handlers) => {
    fake = new FakeVideoDecoder(handlers);
    return fake as unknown as VideoDecoder;
  });
  wrapper.configure({ codec: 'vp8' });
  const scheduler = new Scheduler(wrapper, renderer, opts);
  return { scheduler, wrapper, getFake: () => fake };
}

function chunk(timestamp: number): EncodedVideoChunkData {
  return { type: 'delta', timestamp, data: new Uint8Array([timestamp]) };
}

describe('Scheduler', () => {
  beforeEach(() => {
    FakeVideoDecoder.resetInstances();
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
  });

  it('consumes chunks in pts order', () => {
    const renderer = fakeRenderer();
    const { scheduler, getFake } = makeScheduler(renderer, { now: () => 0 });
    scheduler.enqueue(chunk(3000));
    scheduler.enqueue(chunk(1000));
    scheduler.enqueue(chunk(2000));
    scheduler.tick();
    scheduler.tick();
    scheduler.tick();
    const timestamps = getFake()!.decodeCalls.map((c) => c.timestamp);
    expect(timestamps).toEqual([1000, 2000, 3000]);
  });

  it('stops pulling when the decoder is at the high-water mark', () => {
    const renderer = fakeRenderer();
    const { scheduler, getFake } = makeScheduler(renderer, { now: () => 0 });
    getFake()!.decodeQueueSize = 10;
    scheduler.enqueue(chunk(1000));
    scheduler.tick();
    expect(getFake()!.decodeCalls).toHaveLength(0);
    getFake()!.decodeQueueSize = 5;
    scheduler.tick();
    expect(getFake()!.decodeCalls).toHaveLength(1);
  });

  it('drops chunks older than the latency budget and increments framesDropped', () => {
    let nowMs = 0;
    const renderer = fakeRenderer();
    const { scheduler } = makeScheduler(renderer, { now: () => nowMs, latencyBudgetMs: 1000 });
    scheduler.enqueue(chunk(2000));
    nowMs = 1_000_000;
    scheduler.tick();
    expect(scheduler.getStats().framesDropped).toBe(1);
    expect(scheduler.getStats().framesDecoded).toBe(0);
  });

  it('calls renderer.draw once per rendered frame', () => {
    const renderer = fakeRenderer();
    const { scheduler, getFake } = makeScheduler(renderer, { now: () => 0 });
    scheduler.enqueue(chunk(1000));
    scheduler.enqueue(chunk(2000));
    scheduler.tick();
    scheduler.tick();
    expect(renderer.draw).toHaveBeenCalledTimes(2);
    expect(getFake()!.decodeCalls).toHaveLength(2);
  });

  it('closes the frame when no renderer is attached', () => {
    const { scheduler, getFake } = makeScheduler(null, { now: () => 0 });
    scheduler.enqueue(chunk(1000));
    scheduler.tick();
    const frame = getFake()!.outputFrames[0] as unknown as FakeVideoFrame;
    expect(frame.closeCount).toBe(1);
  });

  it('counts framesDecoded, framesDropped and computes rolling fps', () => {
    let nowMs = 0;
    const renderer = fakeRenderer();
    const { scheduler } = makeScheduler(renderer, { now: () => nowMs });
    scheduler.enqueue(chunk(1000));
    scheduler.enqueue(chunk(2000));
    nowMs = 100;
    scheduler.tick();
    nowMs = 200;
    scheduler.tick();
    const stats = scheduler.getStats();
    expect(stats.framesDecoded).toBe(2);
    expect(stats.framesDropped).toBe(0);
    expect(stats.fps).toBe(2);
    scheduler.enqueue(chunk(3000));
    nowMs = 1_000_000;
    scheduler.tick();
    expect(scheduler.getStats().framesDropped).toBe(1);
  });

  it('does not decode anything when no chunks are buffered', () => {
    const { scheduler, getFake } = makeScheduler(fakeRenderer(), { now: () => 0 });
    scheduler.tick();
    expect(getFake()!.decodeCalls).toHaveLength(0);
    expect(scheduler.getStats().framesDecoded).toBe(0);
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Scheduler } from './scheduler.js';
import { VideoDecoderWrapper } from './decoder.js';
import type { EncodedVideoChunkData, MediaErrorInfo } from '@vigilkit/plugin-sdk';
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
  opts: {
    latencyBudgetMs?: number;
    now?: () => number;
    onError?: (info: MediaErrorInfo) => void;
    stallThresholdMs?: number;
    fatalStallMs?: number;
    onStalled?: () => void;
  } = {},
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

  it('drop-late boundary: a chunk at exactly now - latencyBudget is kept, not dropped', () => {
    let nowMs = 0;
    const renderer = fakeRenderer();
    const { scheduler, getFake } = makeScheduler(renderer, { now: () => nowMs, latencyBudgetMs: 1000 });
    scheduler.enqueue(chunk(2000)); // base: pts 2000 at wall 0
    nowMs = 1000; // lateness == -1000 == -budget -> break, keep
    scheduler.tick();
    expect(scheduler.getStats().framesDropped).toBe(0);
    expect(getFake()!.decodeCalls).toHaveLength(1);
  });

  it('drop-late boundary: a chunk one ms past now - latencyBudget is dropped', () => {
    let nowMs = 0;
    const renderer = fakeRenderer();
    const { scheduler, getFake } = makeScheduler(renderer, { now: () => nowMs, latencyBudgetMs: 1000 });
    scheduler.enqueue(chunk(2000));
    nowMs = 1001; // lateness == -1001 < -budget -> drop
    scheduler.tick();
    expect(scheduler.getStats().framesDropped).toBe(1);
    expect(getFake()!.decodeCalls).toHaveLength(0);
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

  it('a renderer whose draw() throws surfaces a RENDERER error and subsequent ticks continue', () => {
    const draw = vi.fn();
    draw.mockImplementationOnce(() => {
      throw new Error('draw exploded');
    });
    const renderer: RendererSurface = {
      renderMode: 'webgl2',
      draw,
      resize: vi.fn(),
      destroy: vi.fn(),
    };
    const errors: MediaErrorInfo[] = [];
    const { scheduler, getFake } = makeScheduler(renderer, {
      now: () => 0,
      onError: (info) => errors.push(info),
    });
    scheduler.enqueue(chunk(1000));
    scheduler.enqueue(chunk(2000));
    scheduler.tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('RENDERER');
    expect(errors[0]?.message).toBe('draw exploded');
    expect(getFake()!.decodeCalls).toHaveLength(1);
    scheduler.tick();
    expect(errors).toHaveLength(1);
    expect(renderer.draw).toHaveBeenCalledTimes(2);
    expect(scheduler.getStats().framesDecoded).toBe(2);
  });

  it('resync re-bases the clock on the next enqueue', () => {
    let nowMs = 0;
    const renderer = fakeRenderer();
    const { scheduler } = makeScheduler(renderer, { now: () => nowMs, latencyBudgetMs: 1000 });
    scheduler.enqueue(chunk(1000)); // base: pts 1000 @ wall 0
    scheduler.tick();
    expect(scheduler.getStats().framesDecoded).toBe(1);
    // Same pts far in the future: without a re-base it is hopelessly late.
    nowMs = 10_000;
    scheduler.enqueue(chunk(1000));
    scheduler.tick();
    expect(scheduler.getStats().framesDropped).toBe(1);
    expect(scheduler.getStats().framesDecoded).toBe(1);
    // resync clears the base so the next enqueue re-bases to the new master.
    scheduler.resync();
    scheduler.enqueue(chunk(1000));
    scheduler.tick();
    expect(scheduler.getStats().framesDropped).toBe(1);
    expect(scheduler.getStats().framesDecoded).toBe(2);
  });

  it('declares a stall episode once data dries up past stallThresholdMs and accumulates rebufferMs', () => {
    let nowMs = 0;
    const onStalled = vi.fn();
    const { scheduler } = makeScheduler(fakeRenderer(), {
      now: () => nowMs,
      stallThresholdMs: 100,
      fatalStallMs: 10_000,
      onStalled,
    });
    scheduler.enqueue(chunk(1000));
    scheduler.tick(); // decodes the chunk; last data activity at now = 0
    nowMs = 150;
    scheduler.tick(); // idle past the threshold: episode 1 starts
    nowMs = 250;
    scheduler.tick(); // episode continues; rebuffer accrues between ticks
    const stats = scheduler.getStats();
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(stats.stalledCount).toBe(1);
    expect(stats.rebufferMs).toBeGreaterThan(0);
    expect(stats.rebufferMs).toBe(100);
  });

  it('clears a stall episode when data resumes and counts a second episode later', () => {
    let nowMs = 0;
    const onStalled = vi.fn();
    const { scheduler } = makeScheduler(fakeRenderer(), {
      now: () => nowMs,
      stallThresholdMs: 100,
      fatalStallMs: 10_000,
      onStalled,
    });
    scheduler.enqueue(chunk(1000));
    scheduler.tick(); // decode at now = 0
    nowMs = 150;
    scheduler.tick(); // episode 1 starts
    expect(scheduler.getStats().stalledCount).toBe(1);
    nowMs = 200;
    scheduler.enqueue(chunk(2000)); // data resumes; the episode clears
    nowMs = 250;
    scheduler.tick(); // decodes chunk(2000); gap since last data is 0
    expect(scheduler.getStats().stalledCount).toBe(1);
    nowMs = 400;
    scheduler.tick(); // idle past the threshold again: episode 2
    expect(scheduler.getStats().stalledCount).toBe(2);
    expect(onStalled).toHaveBeenCalledTimes(2);
  });

  it('does not declare a stall while the jitter buffer or decoder queue holds data', () => {
    let nowMs = 0;
    const onStalled = vi.fn();
    const { scheduler, getFake } = makeScheduler(fakeRenderer(), {
      now: () => nowMs,
      stallThresholdMs: 100,
      fatalStallMs: 10_000,
      onStalled,
    });
    scheduler.enqueue(chunk(1000));
    scheduler.enqueue(chunk(2000));
    nowMs = 500;
    scheduler.tick(); // decodes chunk(1000); chunk(2000) still buffered
    expect(onStalled).not.toHaveBeenCalled();
    scheduler.tick(); // decodes chunk(2000); jitter now empty
    getFake()!.decodeQueueSize = 5; // decoder still busy draining
    nowMs = 1000;
    scheduler.tick();
    expect(onStalled).not.toHaveBeenCalled();
    expect(scheduler.getStats().stalledCount).toBe(0);
  });

  it('currentBufferMs reflects the head-to-tail pts span of the jitter buffer', () => {
    const { scheduler } = makeScheduler(fakeRenderer(), { now: () => 0 });
    expect(scheduler.getStats().currentBufferMs).toBe(0);
    scheduler.enqueue(chunk(1_000_000));
    scheduler.enqueue(chunk(3_000_000));
    expect(scheduler.getStats().currentBufferMs).toBe(2000);
    scheduler.tick(); // consumes the head
    expect(scheduler.getStats().currentBufferMs).toBe(0);
    scheduler.tick(); // drains the tail
    expect(scheduler.getStats().currentBufferMs).toBe(0);
    scheduler.enqueue(chunk(5_000_000));
    scheduler.enqueue(chunk(5_000_000));
    expect(scheduler.getStats().currentBufferMs).toBe(0);
  });

  it('exposes stalledCount, rebufferMs and currentBufferMs in stats', () => {
    const { scheduler } = makeScheduler(fakeRenderer(), { now: () => 0 });
    const stats = scheduler.getStats();
    expect(stats.stalledCount).toBe(0);
    expect(stats.rebufferMs).toBe(0);
    expect(stats.currentBufferMs).toBe(0);
  });
});

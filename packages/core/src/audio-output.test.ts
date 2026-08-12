import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AudioOutput } from './audio-output.js';
import { FakeAudioContext, FakeAudioData } from './fake-audio.fixture.js';

function makeOutput(onError?: (info: unknown) => void): {
  output: AudioOutput;
  ctx: FakeAudioContext;
} {
  let fakeCtx: FakeAudioContext | null = null;
  // A function expression (not an arrow) so `new` returns the fake instance.
  const AudioContextCtor = (function () {
    fakeCtx = new FakeAudioContext();
    return fakeCtx;
  }) as unknown as typeof AudioContext;
  const output = new AudioOutput({ AudioContextCtor, onError });
  output.start();
  return { output, ctx: fakeCtx as unknown as FakeAudioContext };
}

function audioData(init: Partial<ConstructorParameters<typeof FakeAudioData>[0]> = {}) {
  return new FakeAudioData({
    timestamp: 1_000_000,
    numberOfFrames: 1024,
    numberOfChannels: 2,
    sampleRate: 48000,
    ...init,
  }) as unknown as AudioData;
}

describe('AudioOutput', () => {
  beforeEach(() => {
    FakeAudioContext.resetInstances();
  });

  it('schedules one buffer ~250ms ahead of currentTime with the right sizes', () => {
    const { output, ctx } = makeOutput();
    ctx.currentTime = 5;
    output.onAudioData(audioData());
    expect(ctx.buffers).toHaveLength(1);
    expect(ctx.buffers[0]!.numberOfChannels).toBe(2);
    expect(ctx.buffers[0]!.length).toBe(1024);
    expect(ctx.buffers[0]!.sampleRate).toBe(48000);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.startTime).toBeCloseTo(5.25);
    expect(ctx.sources[0]!.connected).toBe(true);
    expect(ctx.sources[0]!.buffer).toBe(ctx.buffers[0]);
  });

  it('scheduling stays monotonic even when currentTime goes backwards', () => {
    const { output, ctx } = makeOutput();
    ctx.currentTime = 0;
    output.onAudioData(audioData({ timestamp: 1000 }));
    ctx.currentTime = 100;
    output.onAudioData(audioData({ timestamp: 2000 }));
    ctx.currentTime = 10; // clock glitch
    output.onAudioData(audioData({ timestamp: 3000 }));
    expect(ctx.sources.map((s) => s.startTime)).toEqual([0.25, 100.25, 100.5]);
  });

  it('copies each f32-planar channel into the buffer channel data', () => {
    const { output, ctx } = makeOutput();
    output.onAudioData(audioData());
    const buffer = ctx.buffers[0]!;
    // FakeAudioData fills channel ch with ch + 1.
    expect(Array.from(buffer.channelData[0]!.slice(0, 3))).toEqual([1, 1, 1]);
    expect(Array.from(buffer.channelData[1]!.slice(0, 3))).toEqual([2, 2, 2]);
  });

  it('masterTimeUs derives from the first pts and advances with currentTime', () => {
    const { output, ctx } = makeOutput();
    ctx.currentTime = 5;
    output.onAudioData(audioData({ timestamp: 1_000_000 }));
    // First buffer is scheduled 0.25s ahead: media base lags the pts.
    expect(output.masterTimeUs()).toBe(1_000_000 + (5 - 5.25) * 1e6);
    ctx.currentTime = 6;
    expect(output.masterTimeUs()).toBe(1_000_000 + (6 - 5.25) * 1e6);
    expect(output.audioActive()).toBe(true);
  });

  it('audioActive is false until a buffer is scheduled', () => {
    const { output } = makeOutput();
    expect(output.audioActive()).toBe(false);
    expect(output.masterTimeUs()).toBe(0);
  });

  it('a suspended context reports audioActive false and attempts resume', () => {
    const { output, ctx } = makeOutput();
    ctx.state = 'suspended';
    output.onAudioData(audioData());
    expect(ctx.resumeCount).toBe(1);
    expect(output.audioActive()).toBe(false); // still suspended: no master time
    ctx.state = 'running';
    expect(output.audioActive()).toBe(true);
  });

  it('explicit resume is a no-op while running and keeps scheduling on suspension', () => {
    const { output, ctx } = makeOutput();
    output.resume();
    expect(ctx.resumeCount).toBe(0);
    ctx.state = 'suspended';
    output.resume();
    expect(ctx.resumeCount).toBe(1);
  });

  it('zero-frame AudioData is skipped without scheduling', () => {
    const { output, ctx } = makeOutput();
    output.onAudioData(audioData({ numberOfFrames: 0 }));
    expect(ctx.buffers).toHaveLength(0);
    expect(ctx.sources).toHaveLength(0);
  });

  it('reset clears the media base and schedule anchor for the next buffer', () => {
    const { output, ctx } = makeOutput();
    ctx.currentTime = 1;
    output.onAudioData(audioData({ timestamp: 1000 }));
    output.reset();
    expect(output.audioActive()).toBe(false);
    ctx.currentTime = 20;
    output.onAudioData(audioData({ timestamp: 5_000_000 }));
    expect(output.audioActive()).toBe(true);
    expect(output.masterTimeUs()).toBe(5_000_000 + (20 - 20.25) * 1e6);
    expect(ctx.sources.map((s) => s.startTime)).toEqual([1.25, 20.25]);
  });

  it('close is idempotent and stops scheduling', () => {
    const { output, ctx } = makeOutput();
    output.onAudioData(audioData());
    output.close();
    output.close();
    expect(ctx.closeCount).toBe(1);
    const buffersBefore = ctx.buffers.length;
    expect(() => output.onAudioData(audioData())).not.toThrow();
    expect(ctx.buffers).toHaveLength(buffersBefore);
  });

  it('start creates the context exactly once', () => {
    let fakeCtx: FakeAudioContext | null = null;
    const AudioContextCtor = (function () {
      fakeCtx = new FakeAudioContext();
      return fakeCtx;
    }) as unknown as typeof AudioContext;
    const output = new AudioOutput({ AudioContextCtor });
    output.start();
    output.start();
    expect(fakeCtx).not.toBeNull();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('surfaces a DECODE error when copyTo throws', () => {
    const onError = vi.fn();
    const { output } = makeOutput(onError);
    const data = audioData();
    (data as unknown as FakeAudioData).throwOnCopy = true;
    output.onAudioData(data);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'DECODE' });
  });

  it('is inert before start(): no context, no scheduling', () => {
    const AudioContextCtor = (function () {
      return new FakeAudioContext();
    }) as unknown as typeof AudioContext;
    const output = new AudioOutput({ AudioContextCtor });
    expect(() => output.onAudioData(audioData())).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});

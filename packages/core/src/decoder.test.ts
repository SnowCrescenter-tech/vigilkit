import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VideoDecoderWrapper } from './decoder.js';
import {
  FakeEncodedVideoChunk,
  FakeVideoDecoder,
} from './fake-video-decoder.fixture.js';

function makeWrapper() {
  let fake: FakeVideoDecoder | null = null;
  const wrapper = new VideoDecoderWrapper((handlers) => {
    fake = new FakeVideoDecoder(handlers);
    return fake as unknown as VideoDecoder;
  });
  return { wrapper, getFake: () => fake };
}

describe('VideoDecoderWrapper', () => {
  beforeEach(() => {
    FakeVideoDecoder.resetInstances();
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
  });

  it('configure creates the decoder and forwards the config', () => {
    const { wrapper, getFake } = makeWrapper();
    const config: VideoDecoderConfig = { codec: 'vp8', codedWidth: 640, codedHeight: 480 };
    wrapper.configure(config);
    expect(getFake()).not.toBeNull();
    expect(getFake()!.configureCalls).toEqual([config]);
  });

  it('decode builds an EncodedVideoChunk with correct type and timestamp', () => {
    const { wrapper, getFake } = makeWrapper();
    wrapper.configure({ codec: 'vp8' });
    wrapper.decode({ type: 'delta', timestamp: 5_000_000, data: new Uint8Array([1, 2, 3]) });
    const chunk = getFake()!.decodeCalls[0]!;
    expect(chunk).toBeInstanceOf(FakeEncodedVideoChunk);
    expect(chunk.type).toBe('delta');
    expect(chunk.timestamp).toBe(5_000_000);
  });

  it('output callback receives frames in order with their pts', () => {
    const { wrapper, getFake } = makeWrapper();
    const output = vi.fn();
    wrapper.onOutput(output);
    wrapper.configure({ codec: 'vp8' });
    wrapper.decode({ type: 'key', timestamp: 1000, data: new Uint8Array([1]) });
    wrapper.decode({ type: 'delta', timestamp: 2000, data: new Uint8Array([2]) });
    wrapper.decode({ type: 'delta', timestamp: 3000, data: new Uint8Array([3]) });
    expect(output).toHaveBeenCalledTimes(3);
    expect(output.mock.calls[0]?.[0]).toBe(getFake()!.outputFrames[0]);
    expect(output.mock.calls[0]?.[1]).toBe(1000);
    expect(output.mock.calls[1]?.[1]).toBe(2000);
    expect(output.mock.calls[2]?.[1]).toBe(3000);
  });

  it('surfaces a DECODE error when the decoder errors', () => {
    const { wrapper, getFake } = makeWrapper();
    const onError = vi.fn();
    wrapper.onError(onError);
    wrapper.configure({ codec: 'vp8' });
    getFake()!.triggerError(new Error('boom'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'DECODE' });
  });

  it('surfaces a DECODE error when configure throws', () => {
    const { wrapper, getFake } = makeWrapper();
    const onError = vi.fn();
    wrapper.onError(onError);
    wrapper.configure({ codec: 'vp8' });
    getFake()!.failConfigure = true;
    wrapper.configure({ codec: 'vp8' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'DECODE' });
  });

  it('queueSize tracks the underlying decodeQueueSize', () => {
    const { wrapper, getFake } = makeWrapper();
    expect(wrapper.queueSize).toBe(0);
    wrapper.configure({ codec: 'vp8' });
    getFake()!.decodeQueueSize = 7;
    expect(wrapper.queueSize).toBe(7);
  });

  it('close and reset are idempotent', () => {
    const { wrapper, getFake } = makeWrapper();
    wrapper.configure({ codec: 'vp8' });
    const fake = getFake()!;
    wrapper.reset();
    wrapper.reset();
    expect(fake.resetCount).toBe(2);
    wrapper.close();
    expect(fake.closed).toBe(true);
    expect(() => {
      wrapper.close();
      wrapper.reset();
    }).not.toThrow();
    expect(fake.resetCount).toBe(2);
  });

  it('flush resolves and forwards to the decoder', async () => {
    const { wrapper, getFake } = makeWrapper();
    wrapper.configure({ codec: 'vp8' });
    await expect(wrapper.flush()).resolves.toBeUndefined();
    expect(getFake()!.flushCount).toBe(1);
  });
});

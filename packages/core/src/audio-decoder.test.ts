import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AudioDecoderWrapper } from './audio-decoder.js';
import { FakeAudioDecoder, FakeEncodedAudioChunk } from './fake-audio.fixture.js';

function makeWrapper() {
  let fake: FakeAudioDecoder | null = null;
  const wrapper = new AudioDecoderWrapper((handlers) => {
    fake = new FakeAudioDecoder(handlers);
    return fake as unknown as AudioDecoder;
  });
  return { wrapper, getFake: () => fake };
}

describe('AudioDecoderWrapper', () => {
  beforeEach(() => {
    FakeAudioDecoder.resetInstances();
    vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
  });

  it('configure creates the decoder and forwards the config', () => {
    const { wrapper, getFake } = makeWrapper();
    const config: AudioDecoderConfig = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 };
    wrapper.configure(config);
    expect(getFake()).not.toBeNull();
    expect(getFake()!.configureCalls).toEqual([config]);
  });

  it('decode builds an EncodedAudioChunk with correct type and timestamp', () => {
    const { wrapper, getFake } = makeWrapper();
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    wrapper.decode({ type: 'delta', timestamp: 5_000_000, data: new Uint8Array([1, 2, 3]) });
    const chunk = getFake()!.decodeCalls[0]!;
    expect(chunk).toBeInstanceOf(FakeEncodedAudioChunk);
    expect(chunk.type).toBe('delta');
    expect(chunk.timestamp).toBe(5_000_000);
    // The DOM EncodedAudioChunk type exposes copyTo, not `data`: assert the
    // payload on the fake instance.
    const fakeChunk = chunk as unknown as FakeEncodedAudioChunk;
    expect(fakeChunk.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('output callback receives AudioData in order', () => {
    const { wrapper, getFake } = makeWrapper();
    const output = vi.fn();
    wrapper.onOutput(output);
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    wrapper.decode({ type: 'key', timestamp: 1000, data: new Uint8Array([1]) });
    wrapper.decode({ type: 'delta', timestamp: 2000, data: new Uint8Array([2]) });
    wrapper.decode({ type: 'delta', timestamp: 3000, data: new Uint8Array([3]) });
    expect(output).toHaveBeenCalledTimes(3);
    expect(output.mock.calls[0]?.[0]).toBe(getFake()!.outputData[0]);
    expect(output.mock.calls[1]?.[0]).toBe(getFake()!.outputData[1]);
    expect(output.mock.calls[2]?.[0]).toBe(getFake()!.outputData[2]);
  });

  it('outputs received before onOutput is registered are drained on registration', () => {
    const { wrapper, getFake } = makeWrapper();
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    wrapper.decode({ type: 'key', timestamp: 1000, data: new Uint8Array([1]) });
    expect(getFake()!.outputData).toHaveLength(1);
    const output = vi.fn();
    wrapper.onOutput(output);
    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]?.[0]).toBe(getFake()!.outputData[0]);
  });

  it('surfaces a DECODE error when the decoder errors', () => {
    const { wrapper, getFake } = makeWrapper();
    const onError = vi.fn();
    wrapper.onError(onError);
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    getFake()!.triggerError(new Error('boom'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'DECODE' });
  });

  it('surfaces a DECODE error when configure throws', () => {
    const { wrapper, getFake } = makeWrapper();
    const onError = vi.fn();
    wrapper.onError(onError);
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    getFake()!.failConfigure = true;
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'DECODE' });
  });

  it('decode before configure surfaces a DECODE error and forwards nothing', () => {
    const { wrapper, getFake } = makeWrapper();
    const onError = vi.fn();
    wrapper.onError(onError);
    wrapper.decode({ type: 'key', timestamp: 0, data: new Uint8Array([1]) });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'DECODE' });
    expect(getFake()).toBeNull();
  });

  it('queueSize tracks the underlying decodeQueueSize', () => {
    const { wrapper, getFake } = makeWrapper();
    expect(wrapper.queueSize).toBe(0);
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    getFake()!.decodeQueueSize = 7;
    expect(wrapper.queueSize).toBe(7);
  });

  it('close and reset are idempotent', () => {
    const { wrapper, getFake } = makeWrapper();
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
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

  it('close then configure creates a fresh decoder', () => {
    const { wrapper, getFake } = makeWrapper();
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    const first = getFake()!;
    wrapper.close();
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    const second = getFake()!;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(FakeAudioDecoder.instances).toHaveLength(2);
  });

  it('flush after close resolves without touching the decoder', async () => {
    const { wrapper, getFake } = makeWrapper();
    wrapper.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    const fake = getFake()!;
    wrapper.close();
    await expect(wrapper.flush()).resolves.toBeUndefined();
    expect(fake.flushCount).toBe(0);
  });
});

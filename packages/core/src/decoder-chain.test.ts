import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MediaErrorInfo } from '@vigilkit/plugin-sdk';
import { buildDecoder, CodecRoutingDecoder } from './decoder-chain.js';
import type { SoftVideoDecoderFactory } from './decoder-chain.js';
import type { VideoCodecDecoder, VideoDecoderHandlers } from './decoder.js';
import {
  FakeEncodedVideoChunk,
  FakeSoftDecoder,
  FakeVideoDecoder,
} from './fake-video-decoder.fixture.js';
import type { EncodedVideoChunkData } from '@vigilkit/plugin-sdk';

function webCodecsFactory(): { createWebCodecs: (h: VideoDecoderHandlers) => VideoDecoder; getFake: () => FakeVideoDecoder | null } {
  let fake: FakeVideoDecoder | null = null;
  return {
    createWebCodecs: (handlers) => {
      fake = new FakeVideoDecoder(handlers);
      return fake as unknown as VideoDecoder;
    },
    getFake: () => fake,
  };
}

function makeSoftFactory(): { factory: SoftVideoDecoderFactory; get: () => FakeSoftDecoder | null } {
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

function chunk(timestamp: number): EncodedVideoChunkData {
  return { type: 'delta', timestamp, data: new Uint8Array([timestamp]) };
}

const probeConfig = (codec: string): VideoDecoderConfig => ({ codec });

type Probe = (config: VideoDecoderConfig) => Promise<VideoDecoderSupport>;

function probeResult(supported: boolean) {
  return vi.fn<Probe>(async (config: VideoDecoderConfig) => ({ supported, config }));
}

/** A probe whose resolution is deferred until the test calls the resolver. */
function deferredProbe(): {
  isConfigSupported: Probe;
  resolve: (support: VideoDecoderSupport) => void;
} {
  let resolveProbe: ((value: VideoDecoderSupport) => void) | undefined;
  const isConfigSupported = vi.fn<Probe>(
    () =>
      new Promise<VideoDecoderSupport>((resolve) => {
        resolveProbe = resolve;
      }),
  );
  return {
    isConfigSupported,
    resolve: (support) => resolveProbe!(support),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CodecRoutingDecoder', () => {
  beforeEach(() => {
    FakeVideoDecoder.resetInstances();
    FakeSoftDecoder.resetInstances();
    FakeVideoDecoder.isConfigSupported = undefined;
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
  });

  it('routes avc1 with no soft factory to WebCodecs and decodes chunks in order', () => {
    const { createWebCodecs, getFake } = webCodecsFactory();
    const decoder = new CodecRoutingDecoder({ createWebCodecs });
    decoder.configure(probeConfig('avc1.42e01e'));
    decoder.decode(chunk(1000));
    decoder.decode(chunk(2000));
    const fake = getFake()!;
    expect(fake).not.toBeNull();
    expect(fake.configureCalls.map((c) => c.codec)).toEqual(['avc1.42e01e']);
    expect(fake.decodeCalls.map((c) => c.timestamp)).toEqual([1000, 2000]);
  });

  it('routes hvc1 to the soft factory when the probe reports unsupported', async () => {
    const { createWebCodecs } = webCodecsFactory();
    const soft = makeSoftFactory();
    FakeVideoDecoder.isConfigSupported = probeResult(false);
    const decoder = new CodecRoutingDecoder({ createWebCodecs, softFactory: soft.factory });
    decoder.configure(probeConfig('hvc1.1.6.L123.90'));
    await flushMicrotasks();
    const fake = soft.get()!;
    expect(fake).not.toBeNull();
    expect(fake.configureCalls.map((c) => c.codec)).toEqual(['hvc1.1.6.L123.90']);
    expect(FakeVideoDecoder.instances).toHaveLength(0);
  });

  it('prefers WebCodecs when the probe reports supported even with a soft factory', async () => {
    const { createWebCodecs, getFake } = webCodecsFactory();
    const soft = makeSoftFactory();
    FakeVideoDecoder.isConfigSupported = probeResult(true);
    const decoder = new CodecRoutingDecoder({ createWebCodecs, softFactory: soft.factory });
    decoder.configure(probeConfig('hvc1.1.6.L123.90'));
    await flushMicrotasks();
    expect(getFake()).not.toBeNull();
    expect(getFake()!.configureCalls.map((c) => c.codec)).toEqual(['hvc1.1.6.L123.90']);
    expect(soft.get()).toBeNull();
  });

  it('emits UNSUPPORTED when the probe fails and no soft factory handles the codec', async () => {
    const { createWebCodecs } = webCodecsFactory();
    FakeVideoDecoder.isConfigSupported = probeResult(false);
    const decoder = new CodecRoutingDecoder({ createWebCodecs });
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.configure(probeConfig('hvc1.1.6.L123.90'));
    await flushMicrotasks();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'UNSUPPORTED' });
    expect(FakeVideoDecoder.instances).toHaveLength(0);
  });

  it('buffers decodes issued while the probe is in flight and delivers them in order', async () => {
    const { createWebCodecs, getFake } = webCodecsFactory();
    const probe = deferredProbe();
    FakeVideoDecoder.isConfigSupported = probe.isConfigSupported;
    const decoder = new CodecRoutingDecoder({ createWebCodecs });
    decoder.configure(probeConfig('avc1.42e01e'));
    decoder.decode(chunk(1000));
    decoder.decode(chunk(2000));
    expect(getFake()).toBeNull();
    probe.resolve({ supported: true, config: probeConfig('avc1.42e01e') });
    await flushMicrotasks();
    const fake = getFake()!;
    expect(fake).not.toBeNull();
    expect(fake.decodeCalls.map((c) => c.timestamp)).toEqual([1000, 2000]);
  });

  it('forceSoft uses the soft decoder regardless of the probe result', async () => {
    const { createWebCodecs } = webCodecsFactory();
    const soft = makeSoftFactory();
    FakeVideoDecoder.isConfigSupported = probeResult(true);
    const decoder = new CodecRoutingDecoder({ createWebCodecs, softFactory: soft.factory, forceSoft: true });
    decoder.configure(probeConfig('hvc1.1.6.L123.90'));
    decoder.decode(chunk(1000));
    await flushMicrotasks();
    expect(soft.get()).not.toBeNull();
    expect(soft.get()!.decodeCalls.map((c) => c.timestamp)).toEqual([1000]);
    expect(FakeVideoDecoder.instances).toHaveLength(0);
  });

  it('close before the probe resolves emits no error and leaks no decoder', async () => {
    const { createWebCodecs, getFake } = webCodecsFactory();
    const probe = deferredProbe();
    FakeVideoDecoder.isConfigSupported = probe.isConfigSupported;
    const decoder = new CodecRoutingDecoder({ createWebCodecs });
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.configure(probeConfig('hvc1.1.6.L123.90'));
    decoder.close();
    probe.resolve({ supported: true, config: probeConfig('hvc1.1.6.L123.90') });
    await flushMicrotasks();
    expect(errors).toHaveLength(0);
    expect(getFake()).toBeNull();
    expect(FakeVideoDecoder.instances).toHaveLength(0);
  });

  it('reset routes to the active impl and clears buffered chunks', () => {
    const { createWebCodecs, getFake } = webCodecsFactory();
    const decoder = new CodecRoutingDecoder({ createWebCodecs });
    decoder.configure(probeConfig('avc1.42e01e'));
    decoder.reset();
    expect(getFake()!.resetCount).toBe(1);
  });

  it('decode after close does not throw', () => {
    const { createWebCodecs } = webCodecsFactory();
    const decoder = new CodecRoutingDecoder({ createWebCodecs });
    decoder.configure(probeConfig('avc1.42e01e'));
    decoder.close();
    expect(() => {
      decoder.decode(chunk(1000));
      decoder.flush();
    }).not.toThrow();
  });

  it('falls back to WebCodecs when the probe API is missing and surfaces native errors as DECODE', () => {
    const { createWebCodecs, getFake } = webCodecsFactory();
    const decoder = new CodecRoutingDecoder({ createWebCodecs });
    const errors: MediaErrorInfo[] = [];
    decoder.onError((info) => errors.push(info));
    decoder.configure(probeConfig('avc1.42e01e'));
    expect(getFake()).not.toBeNull();
    getFake()!.triggerError(new Error('decode exploded'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'DECODE' });
  });

  it('queueSize reflects pending chunks while configuring and the impl queue after', async () => {
    const { createWebCodecs, getFake } = webCodecsFactory();
    const probe = deferredProbe();
    FakeVideoDecoder.isConfigSupported = probe.isConfigSupported;
    const decoder = new CodecRoutingDecoder({ createWebCodecs });
    decoder.configure(probeConfig('avc1.42e01e'));
    expect(decoder.queueSize).toBe(1);
    decoder.decode(chunk(1000));
    expect(decoder.queueSize).toBe(2);
    probe.resolve({ supported: true, config: probeConfig('avc1.42e01e') });
    await flushMicrotasks();
    getFake()!.decodeQueueSize = 5;
    expect(decoder.queueSize).toBe(6);
  });

  it('buildDecoder returns a functioning VideoCodecDecoder', () => {
    const { createWebCodecs, getFake } = webCodecsFactory();
    const decoder: VideoCodecDecoder = buildDecoder({ createWebCodecs });
    decoder.configure(probeConfig('avc1.42e01e'));
    expect(getFake()).not.toBeNull();
  });
});

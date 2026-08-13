import { describe, expect, it, vi } from 'vitest';
import { Dav1dSoftDecoder } from './dav1d-soft-decoder.js';
import { createDav1dSoftFactory, dav1dSoftDecoderFactory } from './index.js';
import type { Dav1dModule } from './dav1d-loader.js';
import type { SoftVideoDecoderFactory } from 'vigilkit';

function fakeModule(): Dav1dModule {
  return {
    create: () =>
      Promise.resolve({
        decodeFrameAsYUV: () => ({ width: 16, height: 16, data: new Uint8Array(16 * 16 * 1.5) }),
        unsafeCleanup: () => {},
      }),
  };
}

describe('dav1dSoftDecoderFactory', () => {
  const factory: SoftVideoDecoderFactory = dav1dSoftDecoderFactory(fakeModule());

  it('exposes the dav1d id', () => {
    expect(factory.id).toBe('dav1d');
  });

  it('supports AV1 codecs and rejects others', () => {
    expect(factory.supports('av01.0.04M.08')).toBe(true);
    expect(factory.supports('av01.1.04M.08')).toBe(true);
    expect(factory.supports('av01.0.05M.08.08.0.000.01.01.01.01')).toBe(true);
    expect(factory.supports('avc1.64001f')).toBe(false);
    expect(factory.supports('vp09.00.10.08')).toBe(false);
    expect(factory.supports('hvc1.1.6.L120.90')).toBe(false);
  });

  it('creates fresh Dav1dSoftDecoder instances', () => {
    const a = factory.create();
    const b = factory.create();
    expect(a).toBeInstanceOf(Dav1dSoftDecoder);
    expect(a).not.toBe(b);
  });
});

describe('createDav1dSoftFactory', () => {
  it('loads the module and wraps it into a working factory', async () => {
    const wasmBytes = new Uint8Array([1, 2, 3]);
    const expected = await sha256Hex(wasmBytes);
    const create = vi.fn(async () => ({
      decodeFrameAsYUV: () => ({ width: 16, height: 16, data: new Uint8Array(16 * 16 * 1.5) }),
      unsafeCleanup: () => {},
    }));
    const importImpl = vi.fn(async () => ({ default: { create } }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => wasmBytes.buffer as ArrayBuffer,
    }));

    const factory = await createDav1dSoftFactory({
      esmUrl: 'https://example.test/dav1d-esm.js',
      wasmUrl: 'https://example.test/dav1d.wasm',
      sha256: expected,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      importImpl,
    });

    expect(factory.id).toBe('dav1d');
    expect(factory.supports('av01')).toBe(true);
    expect(factory.create()).toBeInstanceOf(Dav1dSoftDecoder);
    expect(importImpl).toHaveBeenCalledWith('https://example.test/dav1d-esm.js');
  });
});

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

import { describe, expect, it, vi } from 'vitest';
import { HevcSoftDecoder } from './hevc-soft-decoder.js';
import { hevcSoftDecoderFactory, createHevcSoftFactory } from './index.js';
import type { Libde265Module } from './libde265-loader.js';
import type { SoftVideoDecoderFactory } from 'vigilkit';

function fakeModule(): Libde265Module {
  return {
    Decoder: class {},
    Error: { OK: 0, ERROR_WAITING_FOR_INPUT_DATA: 13 },
    Chroma: { MONO: 0, 420: 1, 422: 2, 444: 3 },
    isOk: () => true,
    getErrorText: () => '',
  } as unknown as Libde265Module;
}

describe('hevcSoftDecoderFactory', () => {
  const factory: SoftVideoDecoderFactory = hevcSoftDecoderFactory(fakeModule());

  it('exposes the libde265 id', () => {
    expect(factory.id).toBe('libde265');
  });

  it('supports HEVC codecs and rejects others', () => {
    expect(factory.supports('hvc1.1.6.L120.90')).toBe(true);
    expect(factory.supports('hev1.1.6.L93.B0')).toBe(true);
    expect(factory.supports('hevc')).toBe(true);
    expect(factory.supports('avc1.64001f')).toBe(false);
    expect(factory.supports('vp09.00.10.08')).toBe(false);
  });

  it('creates fresh HevcSoftDecoder instances', () => {
    const a = factory.create();
    const b = factory.create();
    expect(a).toBeInstanceOf(HevcSoftDecoder);
    expect(a).not.toBe(b);
  });
});

describe('createHevcSoftFactory', () => {
  it('loads the module and wraps it into a working factory', async () => {
    const module = fakeModule();
    const wasmBytes = new Uint8Array([1, 2, 3]);
    const expected = await sha256Hex(wasmBytes);
    const importImpl = vi.fn(async () => ({
      default: async () => module,
    }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => wasmBytes.buffer as ArrayBuffer,
    }));

    const factory = await createHevcSoftFactory({
      esmUrl: 'https://example.test/libde265-esm.js',
      wasmUrl: 'https://example.test/libde265.wasm',
      sha256: expected,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      importImpl,
    });

    expect(factory.id).toBe('libde265');
    expect(factory.supports('hev1')).toBe(true);
    expect(factory.create()).toBeInstanceOf(HevcSoftDecoder);
    expect(importImpl).toHaveBeenCalledWith('https://example.test/libde265-esm.js');
  });
});

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

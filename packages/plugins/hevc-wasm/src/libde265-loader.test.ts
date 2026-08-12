import { describe, expect, it, vi } from 'vitest';
import { loadLibde265 } from './libde265-loader.js';
import type { Libde265Module } from './libde265-loader.js';

function fakeModule(): Libde265Module {
  return {
    Decoder: class {},
    Error: { OK: 0, ERROR_WAITING_FOR_INPUT_DATA: 13 },
    Chroma: { MONO: 0, 420: 1, 422: 2, 444: 3 },
    isOk: () => true,
    getErrorText: () => '',
  } as unknown as Libde265Module;
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fetchImpl that serves fixed wasm bytes and (optionally) esm text. */
function fileFetch(wasmBytes: Uint8Array, esmText?: string): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('.wasm')) {
      return { ok: true, arrayBuffer: async () => wasmBytes.buffer as ArrayBuffer } as Response;
    }
    if (esmText !== undefined) {
      return { ok: true, text: async () => esmText } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe('loadLibde265', () => {
  it('throws on a sha256 mismatch', async () => {
    const wasmBytes = new Uint8Array([1, 2, 3, 4]);
    await expect(
      loadLibde265({
        esmUrl: 'https://example.test/libde265-esm.js',
        wasmUrl: 'https://example.test/libde265.wasm',
        sha256: 'deadbeef',
        fetchImpl: fileFetch(wasmBytes),
      }),
    ).rejects.toThrow('libde265 sha256 mismatch');
  });

  it('instantiates the module via dynamic import when the sha matches', async () => {
    const wasmBytes = new Uint8Array([9, 9, 9, 9]);
    const expected = await sha256Hex(wasmBytes);
    const module = fakeModule();
    const importImpl = vi.fn(async () => ({
      default: async (options: { wasmBinary: ArrayBuffer }) => {
        expect(new Uint8Array(options.wasmBinary)).toEqual(wasmBytes);
        return module;
      },
    }));

    const loaded = await loadLibde265({
      esmUrl: 'https://example.test/libde265-esm.js',
      wasmUrl: 'https://example.test/libde265.wasm',
      sha256: expected,
      fetchImpl: fileFetch(wasmBytes),
      importImpl,
    });

    expect(loaded).toBe(module);
    expect(importImpl).toHaveBeenCalledWith('https://example.test/libde265-esm.js');
  });

  it('requires the sha256 pin even when import succeeds', async () => {
    const wasmBytes = new Uint8Array([5, 6, 7, 8]);
    await expect(
      loadLibde265({
        esmUrl: 'https://example.test/libde265-esm.js',
        wasmUrl: 'https://example.test/libde265.wasm',
        fetchImpl: fileFetch(wasmBytes),
        importImpl: vi.fn(async () => ({ default: async () => fakeModule() })),
      }),
    ).rejects.toThrow('sha256 pin is required');
  });

  it('verifies the ESM wrapper bytes (esmSha256) before import', async () => {
    const wasmBytes = new Uint8Array([5, 6, 7, 8]);
    const expected = await sha256Hex(wasmBytes);
    const esmBytes = new TextEncoder().encode('async function Module() {}');
    const esmExpected = await sha256Hex(esmBytes);
    const module = fakeModule();
    let esmEvaluated = false;

    const loaded = await loadLibde265({
      esmUrl: 'https://example.test/libde265-esm.js',
      wasmUrl: 'https://example.test/libde265.wasm',
      sha256: expected,
      esmSha256: esmExpected,
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('.wasm')) {
          return { ok: true, arrayBuffer: async () => wasmBytes.buffer as ArrayBuffer } as Response;
        }
        return { ok: true, arrayBuffer: async () => esmBytes.buffer as ArrayBuffer } as Response;
      }) as unknown as typeof fetch,
      importImpl: vi.fn(async (url: string) => {
        expect(url).toBe('https://example.test/libde265-esm.js');
        esmEvaluated = true;
        return { default: async () => module };
      }),
    });

    expect(loaded).toBe(module);
    expect(esmEvaluated).toBe(true);
  });

  it('rejects when the ESM wrapper sha does not match the pin', async () => {
    const wasmBytes = new Uint8Array([5, 6, 7, 8]);
    const expected = await sha256Hex(wasmBytes);
    const esmBytes = new TextEncoder().encode('tampered');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.wasm')) {
        return { ok: true, arrayBuffer: async () => wasmBytes.buffer as ArrayBuffer } as Response;
      }
      return { ok: true, arrayBuffer: async () => esmBytes.buffer as ArrayBuffer } as Response;
    }) as unknown as typeof fetch;

    await expect(
      loadLibde265({
        esmUrl: 'https://example.test/libde265-esm.js',
        wasmUrl: 'https://example.test/libde265.wasm',
        sha256: expected,
        esmSha256: 'deadbeef',
        fetchImpl,
        importImpl: vi.fn(async () => {
          throw new Error('should not evaluate');
        }),
      }),
    ).rejects.toThrow('ESM sha256 mismatch');
  });

  it('rejects when fetching the wasm fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      loadLibde265({
        esmUrl: 'https://example.test/libde265-esm.js',
        wasmUrl: 'https://example.test/libde265.wasm',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('network down');
  });
});

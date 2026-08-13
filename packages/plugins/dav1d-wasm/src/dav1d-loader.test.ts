import { describe, expect, it, vi } from 'vitest';
import { loadDav1d } from './dav1d-loader.js';

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('loadDav1d', () => {
  it('verifies the wasm sha256 and injects the verified bytes as wasmData', async () => {
    const wasmBytes = new Uint8Array([1, 2, 3, 4]);
    const expected = await sha256Hex(wasmBytes);
    const create = vi.fn(async () => ({ decodeFrameAsYUV: () => {}, unsafeCleanup: () => {} }));
    const importImpl = vi.fn(async () => ({ default: { create } }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => wasmBytes.buffer as ArrayBuffer,
    }));

    const module = await loadDav1d({
      esmUrl: 'https://example.test/dav1d-esm.js',
      wasmUrl: 'https://example.test/dav1d.wasm',
      sha256: expected,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      importImpl,
    });

    expect(importImpl).toHaveBeenCalledWith('https://example.test/dav1d-esm.js');
    await module.create();
    expect(create).toHaveBeenCalledWith({ wasmData: wasmBytes });
  });

  it('fails closed on a wasm sha256 mismatch', async () => {
    const wasmBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => wasmBytes.buffer as ArrayBuffer,
    }));

    await expect(
      loadDav1d({
        esmUrl: 'https://example.test/dav1d-esm.js',
        wasmUrl: 'https://example.test/dav1d.wasm',
        sha256: 'a'.repeat(64), // wrong pin
        fetchImpl: fetchImpl as unknown as typeof fetch,
        importImpl: async () => ({ default: { create: async () => ({}) } }),
      }),
    ).rejects.toThrow('dav1d sha256 mismatch');
  });

  it('fails when the wasm pin is missing', async () => {
    const wasmBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => wasmBytes.buffer as ArrayBuffer,
    }));

    await expect(
      loadDav1d({
        esmUrl: 'https://example.test/dav1d-esm.js',
        wasmUrl: 'https://example.test/dav1d.wasm',
        sha256: '',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        importImpl: async () => ({ default: { create: async () => ({}) } }),
      }),
    ).rejects.toThrow('dav1d sha256 mismatch');
  });

  it('verifies the ESM wrapper when an esmSha256 pin is supplied', async () => {
    const wasmBytes = new Uint8Array([1, 2, 3, 4]);
    const wasmSha = await sha256Hex(wasmBytes);
    const esmBytes = new Uint8Array([9, 9, 9]);
    const esmSha = await sha256Hex(esmBytes);
    let fetches = 0;
    const fetchImpl = vi.fn(async () => {
      fetches++;
      return {
        ok: true,
        arrayBuffer: async () => (fetches === 1 ? (wasmBytes.buffer as ArrayBuffer) : (esmBytes.buffer as ArrayBuffer)),
      };
    });
    const importImpl = vi.fn(async () => ({ default: { create: async () => ({}) } }));

    const module = await loadDav1d({
      esmUrl: 'https://example.test/dav1d-esm.js',
      wasmUrl: 'https://example.test/dav1d.wasm',
      sha256: wasmSha,
      esmSha256: esmSha,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      importImpl,
    });

    expect(fetches).toBe(2); // wasm + esm both fetched and verified
    await expect(module.create()).resolves.toBeDefined();
  });

  it('fails closed on an ESM sha256 mismatch', async () => {
    const wasmBytes = new Uint8Array([1, 2, 3, 4]);
    const wasmSha = await sha256Hex(wasmBytes);
    let fetches = 0;
    const fetchImpl = vi.fn(async () => {
      fetches++;
      return {
        ok: true,
        arrayBuffer: async () =>
          (fetches === 1 ? (wasmBytes.buffer as ArrayBuffer) : (new Uint8Array([9]).buffer as ArrayBuffer)),
      };
    });

    await expect(
      loadDav1d({
        esmUrl: 'https://example.test/dav1d-esm.js',
        wasmUrl: 'https://example.test/dav1d.wasm',
        sha256: wasmSha,
        esmSha256: 'b'.repeat(64),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        importImpl: async () => ({ default: { create: async () => ({}) } }),
      }),
    ).rejects.toThrow('dav1d ESM sha256 mismatch');
  });

  it('fails when the dynamic import exposes no { create } default export', async () => {
    const wasmBytes = new Uint8Array([1, 2, 3, 4]);
    const wasmSha = await sha256Hex(wasmBytes);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => wasmBytes.buffer as ArrayBuffer,
    }));

    await expect(
      loadDav1d({
        esmUrl: 'https://example.test/dav1d-esm.js',
        wasmUrl: 'https://example.test/dav1d.wasm',
        sha256: wasmSha,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        importImpl: async () => ({ default: {} }),
      }),
    ).rejects.toThrow('did not expose a { create } default export');
  });

  it('surfaces a wasm fetch failure', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }));
    await expect(
      loadDav1d({
        esmUrl: 'https://example.test/dav1d-esm.js',
        wasmUrl: 'https://example.test/dav1d.wasm',
        sha256: 'a'.repeat(64),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        importImpl: async () => ({ default: { create: async () => ({}) } }),
      }),
    ).rejects.toThrow('failed to fetch wasm');
  });
});

import type { SoftVideoDecoderFactory } from 'vigilkit';
import { Dav1dSoftDecoder } from './dav1d-soft-decoder.js';
import { loadDav1d } from './dav1d-loader.js';
import type { Dav1dModule } from './dav1d-loader.js';

const AV1_CODEC = /^av01/i;

/**
 * Factory for the dav1d soft AV1 decoder. The core's CodecRoutingDecoder
 * calls `create()` then configure/decode/... on the returned instance, so
 * this adapter is a drop-in soft backend alongside the native WebCodecs
 * decoder.
 *
 * The module must be loaded once (see `loadDav1d` / `createDav1dSoftFactory`)
 * and shared across decoder instances; each `create()` call instantiates its
 * own wasm context inside `Dav1dSoftDecoder`.
 */
export function dav1dSoftDecoderFactory(module: Dav1dModule): SoftVideoDecoderFactory {
  return {
    id: 'dav1d',
    supports: (codec) => AV1_CODEC.test(codec),
    create: () => new Dav1dSoftDecoder(module),
  };
}

export interface CreateDav1dSoftFactoryOptions {
  /** URL of the vendored ESM (file:// in Node, http(s):// in browsers). */
  esmUrl: string;
  /** URL of the dav1d.wasm binary. */
  wasmUrl: string;
  /** Expected hex SHA-256 of the wasm bytes (required). */
  sha256: string;
  /** Expected hex SHA-256 of the ESM wrapper bytes (recommended). */
  esmSha256?: string;
  /** Fetcher for wasm/ESM bytes; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Dynamic import of the ESM URL; defaults to `import(url)`. */
  importImpl?: (url: string) => Promise<unknown>;
}

/**
 * Convenience entry point: loads the vendored dav1d artifact (with SHA-256
 * pinning) and wraps it in a `SoftVideoDecoderFactory`.
 */
export async function createDav1dSoftFactory(
  options: CreateDav1dSoftFactoryOptions,
): Promise<SoftVideoDecoderFactory> {
  const module = await loadDav1d(options);
  return dav1dSoftDecoderFactory(module);
}

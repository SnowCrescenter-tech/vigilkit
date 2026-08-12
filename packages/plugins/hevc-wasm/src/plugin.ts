import type { SoftVideoDecoderFactory } from 'vigilkit';
import { HevcSoftDecoder } from './hevc-soft-decoder.js';
import { loadLibde265 } from './libde265-loader.js';
import type { Libde265Module } from './libde265-loader.js';

const HEVC_CODEC = /^(hvc1|hev1|hevc)/i;

/**
 * Factory for the libde265 soft HEVC decoder. The core's CodecRoutingDecoder
 * calls `create()` then configure/decode/... on the returned instance, so this
 * adapter is a drop-in soft backend alongside the native WebCodecs decoder.
 *
 * The module must be loaded once (see `loadLibde265` / `createHevcSoftFactory`)
 * and shared across decoder instances: libde265 decoders are cheap, the module
 * is not.
 */
export function hevcSoftDecoderFactory(module: Libde265Module): SoftVideoDecoderFactory {
  return {
    id: 'libde265',
    supports: (codec) => HEVC_CODEC.test(codec),
    create: () => new HevcSoftDecoder(module),
  };
}

export interface CreateHevcSoftFactoryOptions {
  /** URL of the vendored ESM (file:// in Node, http(s):// in browsers). */
  esmUrl: string;
  /** URL of the libde265.wasm binary. */
  wasmUrl: string;
  /** Expected hex SHA-256 of the wasm bytes; verified when provided. */
  sha256?: string;
  /** Fetcher for wasm/ESM bytes; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Dynamic import of the ESM URL; defaults to `import(url)`. */
  importImpl?: (url: string) => Promise<unknown>;
}

/**
 * Convenience entry point: loads the vendored libde265 artifact (with optional
 * SHA-256 pinning) and wraps it in a `SoftVideoDecoderFactory`.
 */
export async function createHevcSoftFactory(
  options: CreateHevcSoftFactoryOptions,
): Promise<SoftVideoDecoderFactory> {
  const module = await loadLibde265(options);
  return hevcSoftDecoderFactory(module);
}

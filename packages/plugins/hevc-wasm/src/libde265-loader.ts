/**
 * Minimal, empirically verified type surface of the vendored
 * `@yume-chan/libde265` WASM module (see examples/basic/vendor/README.md).
 *
 * The decoder is pull-based: `pushData(bytes, pts)` feeds an Annex-B stream,
 * `decode()` returns `{ error, more }`, and decoded pictures are retrieved
 * with `getNextPicture()` and must be `delete()`d by the consumer. `pts` is
 * passthrough — it is not used for decoding and lands on `image.pts`.
 */

export interface Libde265ImagePlane {
  width: number;
  height: number;
  bytes: Uint8Array;
  /** Row pitch in bytes (pixel pitch x bytes-per-sample). */
  stride: number;
}

export interface Libde265Image {
  readonly pts: bigint;
  /** 0 = mono, 1 = 4:2:0, 2 = 4:2:2, 3 = 4:4:4 (module.Chroma enum). */
  readonly chromaFormat: number;
  readonly isFullRange: boolean;
  getWidth(channel: number): number;
  getHeight(channel: number): number;
  getBitsPerPixel(channel: number): number;
  getImagePlane(channel: number): Libde265ImagePlane;
  delete(): void;
}

export interface Libde265DecodingResult {
  error: number;
  more: boolean;
}

export interface Libde265Decoder {
  pushData(input: Uint8Array, pts: bigint): number;
  decode(): Libde265DecodingResult;
  getNextPicture(): Libde265Image | null;
  flushData(): number;
  reset(): void;
  delete(): void;
}

export interface Libde265DecoderCtor {
  new (): Libde265Decoder;
}

export interface Libde265Module {
  Decoder: Libde265DecoderCtor;
  /** Error code enum; OK=0, WAITING_FOR_INPUT_DATA=13, warnings are >= 1000. */
  Error: { OK: number; ERROR_WAITING_FOR_INPUT_DATA: number; [name: string]: number };
  Chroma: { MONO: number; 420: number; 422: number; 444: number };
  isOk(error: number): boolean;
  getErrorText(error: number): string;
}

/** Shape of the vendored ESM's default export: an async Module factory. */
export interface LoadedLibde265 {
  default(options: { wasmBinary: ArrayBuffer; wasmUrl?: string }): Promise<Libde265Module>;
}

export interface LoadLibde265Options {
  /** URL of the vendored ESM (file:// in Node, http(s):// in browsers). */
  esmUrl: string;
  /** URL of the libde265.wasm binary. */
  wasmUrl?: string;
  /** Expected hex SHA-256 of the wasm bytes; verified when provided. */
  sha256?: string;
  /** Fetcher for wasm/ESM bytes. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Dynamic import of the ESM URL. Defaults to `import(url)` when absent;
   * only environments that block dynamic import (strict CSP) reach the
   * `new Function` evaluation fallback.
   */
  importImpl?: (url: string) => Promise<unknown>;
}

type Libde265Factory = LoadedLibde265['default'];

/**
 * Loads the vendored libde265 artifact: fetches the wasm bytes, verifies their
 * SHA-256 against `sha256` when provided, instantiates the ESM module with the
 * wasm injected via the standard Emscripten `wasmBinary` option, and returns
 * the runtime Module exposing the `Decoder` class.
 */
export async function loadLibde265(options: LoadLibde265Options): Promise<Libde265Module> {
  const { esmUrl, wasmUrl, sha256, fetchImpl, importImpl } = options;
  const doFetch = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  if (wasmUrl === undefined) {
    throw new Error('libde265: wasmUrl is required');
  }
  const wasmResponse = await doFetch(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error(`libde265: failed to fetch wasm from ${wasmUrl}`);
  }
  const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());

  if (sha256 !== undefined) {
    const expected = sha256.toLowerCase();
    const digest = await globalThis.crypto.subtle.digest('SHA-256', wasmBytes);
    const actual = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (actual !== expected) {
      throw new Error('libde265 sha256 mismatch');
    }
  }

  const factory = await resolveEsmFactory(esmUrl, doFetch, importImpl);
  return await factory({ wasmBinary: wasmBytes.buffer });
}

async function resolveEsmFactory(
  esmUrl: string,
  doFetch: typeof fetch,
  importImpl: ((url: string) => Promise<unknown>) | undefined,
): Promise<Libde265Factory> {
  if (importImpl !== undefined) {
    const imported = (await importImpl(esmUrl)) as { default?: Libde265Factory };
    if (typeof imported.default !== 'function') {
      throw new Error('libde265: dynamic import did not expose a default factory');
    }
    return imported.default;
  }
  try {
    // Both Node (file:// URLs) and browsers (http(s):// URLs) support native
    // dynamic import; this is the primary path.
    const imported = (await import(esmUrl)) as { default?: Libde265Factory };
    if (typeof imported.default !== 'function') {
      throw new Error('libde265: dynamic import did not expose a default factory');
    }
    return imported.default;
  } catch {
    // Strict-CSP environments that block dynamic import: evaluate the ESM
    // text. The vendored artifact is `async function Module(...) {...}
    // export default Module;` — `new Function` bodies cannot contain
    // import/export statements, so strip the trailing default export and
    // return the factory directly.
    const esmResponse = await doFetch(esmUrl);
    if (!esmResponse.ok) {
      throw new Error(`libde265: failed to fetch ESM from ${esmUrl}`);
    }
    const source = await esmResponse.text();
    const factory: unknown = new Function(
      source.replace(/export default Module;\s*$/, '') + '; return Module;',
    )();
    if (typeof factory !== 'function') {
      throw new Error('libde265: evaluated ESM did not expose a Module factory');
    }
    return factory as Libde265Factory;
  }
}

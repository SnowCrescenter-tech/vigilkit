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
  /** Expected hex SHA-256 of the wasm bytes. Required in browser loads. */
  sha256?: string;
  /** Expected hex SHA-256 of the ESM wrapper bytes (recommended). */
  esmSha256?: string;
  /** Fetcher for wasm/ESM bytes. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Dynamic import of the ESM URL. Defaults to native `import(url)`. Only
   * environments that cannot use dynamic import pass their own loader; the
   * unsafe `new Function` evaluation fallback has been removed — fetched ESM
   * text is never evaluated as code.
   */
  importImpl?: (url: string) => Promise<unknown>;
}

type Libde265Factory = LoadedLibde265['default'];

/** Verifies a hex digest, returning the lowercase hex of `bytes`. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Loads the vendored libde265 artifact: fetches the wasm (and the ESM wrapper
 * when an `esmSha256` pin is supplied), verifies each sha256, instantiates the
 * ESM module with the verified wasm injected via the standard Emscripten
 * `wasmBinary` option, and returns the runtime Module exposing the `Decoder`
 * class. Mismatch or a missing browser pin fails closed before instantiation.
 */
export async function loadLibde265(options: LoadLibde265Options): Promise<Libde265Module> {
  const { esmUrl, wasmUrl, sha256, esmSha256, fetchImpl, importImpl } = options;
  const doFetch = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  if (wasmUrl === undefined) {
    throw new Error('libde265: wasmUrl is required');
  }
  const wasmResponse = await doFetch(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error(`libde265: failed to fetch wasm from ${wasmUrl}`);
  }
  const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());

  if (sha256 === undefined) {
    // The wasm pin is what makes the vendored-artifact policy hold. A browser
    // load without a pin is a supply-chain hole, so require it.
    throw new Error('libde265: sha256 pin is required to load the wasm artifact');
  }
  const digest = await sha256Hex(wasmBytes);
  if (digest !== sha256.toLowerCase()) {
    throw new Error('libde265 sha256 mismatch');
  }

  const factory = await resolveEsmFactory(esmUrl, doFetch, importImpl, esmSha256);
  return await factory({ wasmBinary: wasmBytes.buffer });
}

async function resolveEsmFactory(
  esmUrl: string,
  doFetch: typeof fetch,
  importImpl: ((url: string) => Promise<unknown>) | undefined,
  esmSha256: string | undefined,
): Promise<Libde265Factory> {
  if (esmSha256 !== undefined) {
    // Verify the ESM wrapper bytes before any code executes. The wasm pin
    // alone would let a tampered wrapper run arbitrary code in the page.
    const esmResponse = await doFetch(esmUrl);
    if (!esmResponse.ok) {
      throw new Error(`libde265: failed to fetch ESM from ${esmUrl}`);
    }
    const esmBytes = new Uint8Array(await esmResponse.arrayBuffer());
    const digest = await sha256Hex(esmBytes);
    if (digest !== esmSha256.toLowerCase()) {
      throw new Error('libde265 ESM sha256 mismatch');
    }
    if (typeof URL.createObjectURL !== 'function') {
      throw new Error('libde265: ESM sha256 verification requires URL.createObjectURL');
    }
    const blobUrl = URL.createObjectURL(new Blob([esmBytes], { type: 'text/javascript' }));
    try {
      const importer = importImpl ?? ((url: string) => import(url));
      const imported = (await importer(blobUrl)) as { default?: Libde265Factory };
      if (typeof imported.default !== 'function') {
        throw new Error('libde265: ESM import did not expose a default factory');
      }
      return imported.default;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
  if (importImpl !== undefined) {
    const imported = (await importImpl(esmUrl)) as { default?: Libde265Factory };
    if (typeof imported.default !== 'function') {
      throw new Error('libde265: dynamic import did not expose a default factory');
    }
    return imported.default;
  }
  // Native dynamic import — Node (file://) and browsers (http(s)://) both
  // support it; same-origin imports work under typical `script-src 'self'` CSP.
  const imported = (await import(esmUrl)) as { default?: Libde265Factory };
  if (typeof imported.default !== 'function') {
    throw new Error('libde265: dynamic import did not expose a default factory');
  }
  return imported.default;
}

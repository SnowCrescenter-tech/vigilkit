/**
 * Minimal, empirically verified type surface of the vendored `dav1d.js`
 * WASM module (see examples/basic/vendor/README.md).
 *
 * The wrapper is frame-at-a-time: `create({ wasmData })` instantiates the wasm
 * with a minimal import table and returns a `Dav1d` instance whose
 * `decodeFrameAsYUV(obu)` decodes ONE AV1 frame from its OBU payload and
 * returns a tight-packed 8-bit 4:2:0 I420 copy (`width*height` Y bytes, then
 * `ceil(w/2)*ceil(h/2)` U bytes, then the same for V). Each `create()` call
 * owns an independent dav1d context (reference frames are per-context), so
 * every decoder instance must call `create()` for itself.
 */

export interface Dav1dYuvFrame {
  width: number;
  height: number;
  /** Tight 8-bit 4:2:0 I420: Y plane, then U, then V. No row padding. */
  data: Uint8Array;
}

export interface Dav1dInstance {
  /**
   * Decodes one AV1 frame from a complete OBU temporal unit (one IVF frame
   * body). Returns the decoded I420 copy, or throws on a decode failure (the
   * wrapper rejects non-8-bit / non-4:2:0 pictures and malformed OBUs).
   */
  decodeFrameAsYUV(obu: Uint8Array): Dav1dYuvFrame;
  /** Releases the wasm-side frame buffer kept by the last unsafe decode. */
  unsafeCleanup(): void;
}

/**
 * Factory that creates an independent dav1d context. The wasm is re-
 * instantiated per call; that is cheap enough for the soft-decode fallback
 * (a few ms for the 376 KB binary) and is how each decoder gets its own
 * reference-frame state.
 */
export interface Dav1dModule {
  create(): Promise<Dav1dInstance>;
}

/** Shape of the vendored ESM's default export: `{ create }`. */
export interface LoadedDav1d {
  default: {
    create(options: { wasmData: Uint8Array; wasmURL?: string }): Promise<Dav1dInstance>;
  };
}

export interface LoadDav1dOptions {
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

/** Verifies a hex digest, returning the lowercase hex of `bytes`. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Loads the vendored dav1d artifact: fetches the wasm (and the ESM wrapper
 * when an `esmSha256` pin is supplied), verifies each sha256, dynamically
 * imports the ESM, and returns a `Dav1dModule` that instantiates the wasm with
 * the verified bytes (`wasmData` injection). Mismatch or a missing wasm pin
 * fails closed before any module code runs.
 */
export async function loadDav1d(options: LoadDav1dOptions): Promise<Dav1dModule> {
  const { esmUrl, wasmUrl, sha256, esmSha256, fetchImpl, importImpl } = options;
  const doFetch = fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const wasmResponse = await doFetch(wasmUrl);
  if (!wasmResponse.ok) {
    throw new Error(`dav1d: failed to fetch wasm from ${wasmUrl}`);
  }
  const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());

  // The wasm pin is what makes the vendored-artifact policy hold. A load
  // without a pin is a supply-chain hole, so require it.
  const digest = await sha256Hex(wasmBytes);
  if (digest !== sha256.toLowerCase()) {
    throw new Error('dav1d sha256 mismatch');
  }

  const wrapper = await resolveWrapper(esmUrl, doFetch, importImpl, esmSha256);
  return {
    create: () => wrapper.create({ wasmData: wasmBytes }),
  };
}

async function resolveWrapper(
  esmUrl: string,
  doFetch: typeof fetch,
  importImpl: ((url: string) => Promise<unknown>) | undefined,
  esmSha256: string | undefined,
): Promise<LoadedDav1d['default']> {
  if (esmSha256 !== undefined) {
    // Verify the ESM wrapper bytes before any code executes. The wasm pin
    // alone would let a tampered wrapper run arbitrary code in the page.
    const esmResponse = await doFetch(esmUrl);
    if (!esmResponse.ok) {
      throw new Error(`dav1d: failed to fetch ESM from ${esmUrl}`);
    }
    const esmBytes = new Uint8Array(await esmResponse.arrayBuffer());
    const esmDigest = await sha256Hex(esmBytes);
    if (esmDigest !== esmSha256.toLowerCase()) {
      throw new Error('dav1d ESM sha256 mismatch');
    }
  }
  if (importImpl !== undefined) {
    const imported = (await importImpl(esmUrl)) as LoadedDav1d;
    if (typeof imported.default?.create !== 'function') {
      throw new Error('dav1d: dynamic import did not expose a { create } default export');
    }
    return imported.default;
  }
  // Native dynamic import — Node (file://) and browsers (http(s)://) both
  // support it; same-origin imports work under typical `script-src 'self'` CSP.
  const imported = (await import(esmUrl)) as LoadedDav1d;
  if (typeof imported.default?.create !== 'function') {
    throw new Error('dav1d: dynamic import did not expose a { create } default export');
  }
  return imported.default;
}

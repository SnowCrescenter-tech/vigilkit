#!/usr/bin/env node
// Real-decode smoke test: loads the vendored dav1d WASM artifact, decodes the
// committed AV1 IVF fixture through the plugin, and reports the number of
// frames produced. Exits 0 only if at least one frame decoded.
//
//   node scripts/smoke.mjs            (requires a prior `pnpm build`)
//
// The smoke deliberately drives the exact public API (createDav1dSoftFactory ->
// factory -> decoder.decode/flush) so it doubles as an integration test for
// the loader + decoder wiring against the real wasm binary.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDav1dSoftFactory } from '../dist/index.js';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(SCRIPTS_DIR, '..');
const ROOT = join(PKG_DIR, '..', '..', '..');

const VENDOR_DIR = join(ROOT, 'examples', 'basic', 'vendor');
const ESM_FILE = join(VENDOR_DIR, 'dav1d-esm.js');
const WASM_FILE = join(VENDOR_DIR, 'dav1d.wasm');
const SHA_FILE = join(VENDOR_DIR, 'dav1d.sha256');
const README_FILE = join(VENDOR_DIR, 'README.md');
const FIXTURE_FILE = join(VENDOR_DIR, 'av1-fixtures', 'av1-film_grain.ivf');

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Minimal fetchImpl serving the vendored files over file:// URLs. */
function fileFetchImpl() {
  return async (input) => {
    const url = new URL(String(input));
    if (url.protocol !== 'file:') {
      throw new Error(`smoke: unexpected URL scheme "${url.protocol}"`);
    }
    const bytes = readFileSync(fileURLToPath(url));
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return {
      ok: true,
      async arrayBuffer() {
        return arrayBuffer;
      },
      async text() {
        return bytes.toString('utf8');
      },
    };
  };
}

/**
 * Splits an IVF container into one AV1 OBU payload per frame.
 * IVF header is 32 bytes; each frame record is [u32 size][u64 pts][payload].
 */
function ivfFrames(ivf) {
  if (ivf.length < 32) {
    throw new Error('smoke: IVF file shorter than the 32-byte header');
  }
  const frames = [];
  let offset = 32;
  while (offset + 12 <= ivf.length) {
    const size = new DataView(ivf.buffer, ivf.byteOffset, ivf.byteLength).getUint32(offset, true);
    if (offset + 12 + size > ivf.length) {
      throw new Error('smoke: truncated IVF frame record');
    }
    frames.push(new Uint8Array(ivf.buffer, ivf.byteOffset + offset + 12, size));
    offset += 12 + size;
  }
  if (frames.length === 0) {
    throw new Error('smoke: no IVF frames found');
  }
  return frames;
}

async function main() {
  // 1. Verify the vendored ESM against the committed pin.
  const esmSha = await sha256Hex(readFileSync(ESM_FILE));
  const pinned = readFileSync(SHA_FILE, 'utf8').trim();
  if (esmSha !== pinned) {
    throw new Error(`vendored ESM sha256 mismatch: got ${esmSha}, pinned ${pinned}`);
  }

  // 2. Read the wasm sha from the vendored README (the loader pins the wasm).
  const readme = readFileSync(README_FILE, 'utf8');
  const wasmSha = readme.match(/dav1d\.wasm`\):\s*([0-9a-f]{64})/)?.[1];
  if (wasmSha === undefined) {
    throw new Error('smoke: could not find the wasm sha256 in the vendor README');
  }

  // 3. Load the module and build the decoder factory.
  const factory = await createDav1dSoftFactory({
    esmUrl: pathToFileURL(ESM_FILE).href,
    wasmUrl: pathToFileURL(WASM_FILE).href,
    sha256: wasmSha,
    fetchImpl: fileFetchImpl(),
  });
  if (factory.id !== 'dav1d' || !factory.supports('av01.0.04M.08')) {
    throw new Error(`smoke: factory wiring broken (id=${factory.id})`);
  }

  // 4. Feed each IVF frame's OBUs as one chunk and count delivered frames.
  const decoder = factory.create();
  decoder.configure({ codec: 'av01.0.04M.08' });
  let framesDecoded = 0;
  decoder.onOutput(() => {
    framesDecoded++;
  });
  const frames = ivfFrames(readFileSync(FIXTURE_FILE));
  for (let i = 0; i < frames.length; i++) {
    decoder.decode({ type: 'key', timestamp: i * 33333, data: frames[i] });
  }
  await decoder.flush();
  decoder.close();

  console.log(JSON.stringify({ framesDecoded }, null, 2));
  if (framesDecoded < 1) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[smoke] FAILED: ${error.message}`);
  process.exitCode = 1;
});

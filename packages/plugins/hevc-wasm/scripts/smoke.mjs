#!/usr/bin/env node
// Real-decode smoke test: loads the vendored libde265 WASM artifact, decodes
// the committed FFmpeg FATE HEVC fixture through the plugin, and reports the
// number of frames produced. Exits 0 only if at least one frame decoded.
//
//   node scripts/smoke.mjs            (requires a prior `pnpm build`)
//
// The smoke deliberately drives the exact public API (createHevcSoftFactory ->
// factory -> decoder.decode/flush) so it doubles as an integration test for
// the loader + decoder wiring against the real wasm binary.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHevcSoftFactory } from '../dist/index.js';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(SCRIPTS_DIR, '..');
const ROOT = join(PKG_DIR, '..', '..', '..');

const VENDOR_DIR = join(ROOT, 'examples', 'basic', 'vendor');
const FIXTURES_DIR = join(ROOT, 'examples', 'basic', 'hevc-fixtures');
const ESM_FILE = join(VENDOR_DIR, 'libde265-esm.js');
const WASM_FILE = join(VENDOR_DIR, 'libde265.wasm');
const SHA_FILE = join(VENDOR_DIR, 'libde265.sha256');
const README_FILE = join(VENDOR_DIR, 'README.md');
const FIXTURE_FILE = join(FIXTURES_DIR, 'paired_fields.hevc');
const CHUNK_SIZE = 65536;

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

async function main() {
  // 1. Verify the vendored ESM against the committed pin.
  const esmSha = await sha256Hex(readFileSync(ESM_FILE));
  const pinned = readFileSync(SHA_FILE, 'utf8').trim();
  if (esmSha !== pinned) {
    throw new Error(`vendored ESM sha256 mismatch: got ${esmSha}, pinned ${pinned}`);
  }

  // 2. Read the wasm sha from the vendored README (the loader pins the wasm).
  const readme = readFileSync(README_FILE, 'utf8');
  const wasmSha = readme.match(/libde265\.wasm`\):\s*([0-9a-f]{64})/)?.[1];
  if (wasmSha === undefined) {
    throw new Error('smoke: could not find the wasm sha256 in the vendor README');
  }

  // 3. Load the module and build the decoder factory.
  const factory = await createHevcSoftFactory({
    esmUrl: pathToFileURL(ESM_FILE).href,
    wasmUrl: pathToFileURL(WASM_FILE).href,
    sha256: wasmSha,
    fetchImpl: fileFetchImpl(),
  });
  if (factory.id !== 'libde265' || !factory.supports('hvc1')) {
    throw new Error(`smoke: factory wiring broken (id=${factory.id})`);
  }

  // 4. Feed the fixture in 64 KB Annex-B chunks and count delivered frames.
  const decoder = factory.create();
  decoder.configure({ codec: 'hvc1.1.6.L120.90' });
  let framesDecoded = 0;
  decoder.onOutput(() => {
    framesDecoded++;
  });
  const fixture = readFileSync(FIXTURE_FILE);
  for (let offset = 0; offset < fixture.length; offset += CHUNK_SIZE) {
    decoder.decode({
      type: 'key',
      timestamp: offset,
      data: new Uint8Array(
        fixture.buffer.slice(offset, Math.min(offset + CHUNK_SIZE, fixture.length)),
      ),
    });
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

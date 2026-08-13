#!/usr/bin/env node
// Vendors the Kagami dav1d.js WASM ESM artifact (AV1 decoder) into
// examples/basic/vendor/.
//
//   node scripts/vendor-dav1d.mjs             # pack, extract, copy, pin sha256, refresh README
//   node scripts/vendor-dav1d.mjs --verify    # check file exists, sha matches, and imports
//
// The dav1d core is BSD-2-Clause and the wrapper is CC0-1.0 (both permissive),
// so unlike vendor-libde265.mjs there is no copyleft source offer to make.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE = 'dav1d.js@0.1.1';
const TARBALL_MEMBER_ESM = 'package/dav1d.js';
const TARBALL_MEMBER_WASM = 'package/dav1d.wasm';
const TARBALL_MEMBER_COPYING = 'package/COPYING';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = join(ROOT, 'examples', 'basic', 'vendor');
const ESM_TARGET = join(VENDOR_DIR, 'dav1d-esm.js');
const WASM_TARGET = join(VENDOR_DIR, 'dav1d.wasm');
const COPYING_TARGET = join(VENDOR_DIR, 'dav1d-CC0-COPYING');
const SHA_FILE = join(VENDOR_DIR, 'dav1d.sha256');
const README_FILE = join(VENDOR_DIR, 'README.md');

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has('--verify');

function log(message) {
  console.log(`[vendor-dav1d] ${message}`);
}

// npm is a .cmd shim on Windows; execFileSync cannot spawn batch shims directly.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message) {
  console.error(`[vendor-dav1d] ${message}`);
  process.exitCode = 1;
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function storedSha() {
  try {
    return readFileSync(SHA_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function readmeFor(esmSha, wasmSha) {
  return `# Vendored dav1d WASM (AV1)

Physically isolated BSD-2-Clause dav1d core + CC0-1.0 wrapper module used for AV1 soft-decode in browsers without native AV1 WebCodecs (e.g. older Safari / Firefox Android). Loaded only when AV1 playback is requested.

- Source: npm package \`dav1d.js@${PACKAGE.split('@')[1]}\` (tarball from \`npm pack\`; repo https://github.com/Kagami/dav1d.js)
- Files:
  - \`dav1d-esm.js\` — the package's ESM wrapper (\`dav1d.js\` in the tarball). Exports \`default = { create({ wasmData }) }\`; \`create\` returns a \`Dav1d\` instance with \`decodeFrameAsYUV(obu)\` / \`decodeFrameAsBMP(obu)\` / \`unsafeCleanup()\`.
  - \`dav1d.wasm\` — the WebAssembly binary (fed to the wrapper as \`wasmData\`; the wrapper does not self-load it by URL).
  - \`dav1d-CC0-COPYING\` — CC0-1.0 text for the wrapper code.
- SHA-256 (\`dav1d-esm.js\`): ${esmSha} (also pinned in \`dav1d.sha256\`)
- SHA-256 (\`dav1d.wasm\`): ${wasmSha}
- License: dav1d core BSD-2-Clause; wrapper CC0-1.0

## AV1 test fixture

- \`av1-fixtures/av1-film_grain.ivf\` — 352x288 8-bit 4:2:0 AV1 IVF elementary stream (10 frames, from Chromium's media test data).
- SHA-256: pinned in \`av1-fixtures/fixture.sha256\`
- Used by the \`@vigilkit/plugin-dav1d-wasm\` Node smoke test.

## Which hash is which (dav1d)

- \`dav1d.sha256\` (in this directory) pins **the ESM wrapper** \`dav1d-esm.js\`. The plugin's smoke test (\`packages/plugins/dav1d-wasm/scripts/smoke.mjs\`) re-hashes the ESM file and fails if it drifts from this pin.
- The runtime loader in \`@vigilkit/plugin-dav1d-wasm\` (\`dav1d-loader.ts\`) verifies **the wasm binary** \`dav1d.wasm\`, and it expects the hash listed above (${wasmSha.slice(0, 8)}…). That wasm digest is intentionally documented here rather than in a second pin file, so the loader and the smoke test read the same number from the same file. If the wasm file ever changes, update this README's \`dav1d.wasm\` hash; if the ESM wrapper ever changes, update \`dav1d.sha256\`.

## API shape (Node 22 smoke-verified)

The wrapper is a small hand-rolled Emscripten-free loader: pass the wasm bytes directly and it instantiates with a minimal import table:

\`\`\`js
import { readFileSync } from 'node:fs';
import dav1d from './dav1d-esm.js'; // default export is { create }

const wasmData = new Uint8Array(readFileSync('./dav1d.wasm'));
const d = await dav1d.create({ wasmData });
const { width, height, data } = d.decodeFrameAsYUV(obu); // tight I420: Y, then U, then V
d.unsafeCleanup?.();
\`\`\`

\`decodeFrameAsYUV\` decodes **one AV1 frame** from its OBU payload (a temporal unit: for IVF, the frame body after the 4-byte size + 8-byte pts header). Feed one frame's OBUs per call. Output is 8-bit 4:2:0 I420 with no row padding (\`width*height\` Y bytes, then \`ceil(width/2)*ceil(height/2)\` U bytes, then the same for V). 10-bit or 4:4:4 frames are rejected by the wrapper (\`null\` picture -> throw) and must be avoided or surfaced as a decode error.
`;
}

// Prove the vendored module loads in Node and exposes the decode API.
async function importCheck() {
  const url = pathToFileURL(ESM_TARGET).href;
  const imported = await import(url);
  const wrapper = imported.default;
  if (typeof wrapper?.create !== 'function') {
    throw new Error(
      `no { create } default export found; module keys: ${Object.keys(imported).join(',')}`,
    );
  }
  const wasmData = new Uint8Array(readFileSync(WASM_TARGET));
  const d = await wrapper.create({ wasmData });
  if (typeof d.decodeFrameAsYUV !== 'function') {
    throw new Error(`decodeFrameAsYUV missing; instance keys: ${Object.keys(d).join(',')}`);
  }
  d.unsafeCleanup?.();
  return {
    moduleKeys: Object.keys(imported).join(','),
    hasDecodeFrame: typeof d.decodeFrameAsYUV,
  };
}

async function verify() {
  let ok = true;
  if (!existsSync(ESM_TARGET)) {
    fail(`MISSING vendored artifact: ${ESM_TARGET}`);
    ok = false;
  }
  if (!existsSync(WASM_TARGET)) {
    fail(`MISSING vendored wasm: ${WASM_TARGET}`);
    ok = false;
  }
  const esmSha = await sha256OfFile(ESM_TARGET);
  const expected = storedSha();
  if (expected !== null && expected !== esmSha) {
    fail(`SHA256 MISMATCH: ${ESM_TARGET} is ${esmSha}, expected ${expected}`);
    ok = false;
  }
  log(`sha256 (esm): ${esmSha}`);
  if (!ok) {
    return false;
  }
  try {
    const { moduleKeys, hasDecodeFrame } = await importCheck();
    log(`node import OK: module keys [${moduleKeys}], decodeFrameAsYUV=${hasDecodeFrame}`);
  } catch (error) {
    fail(`node import FAILED: ${error.message}`);
    ok = false;
  }
  return ok;
}

async function vendor() {
  mkdirSync(VENDOR_DIR, { recursive: true });
  const workDir = mkdtempSync(join(os.tmpdir(), 'dav1d-vendor-'));
  try {
    log(`npm pack ${PACKAGE}`);
    const packOut = execFileSync(
      NPM,
      ['pack', PACKAGE, '--pack-destination', workDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' },
    );
    const tarballFile = packOut.trim().split('\n').pop();
    const tarballPath = join(workDir, tarballFile);
    log(`extracting ${tarballFile} (dav1d.js, dav1d.wasm)`);
    const esmOut = join(workDir, 'out-esm.js');
    const wasmOut = join(workDir, 'out.wasm');
    const copyingOut = join(workDir, 'out-COPYING');
    const esmBuf = execFileSync('tar', ['-xOf', tarballPath, TARBALL_MEMBER_ESM], { stdio: 'pipe' });
    const wasmBuf = execFileSync('tar', ['-xOf', tarballPath, TARBALL_MEMBER_WASM], { stdio: 'pipe' });
    writeFileSync(esmOut, esmBuf);
    writeFileSync(wasmOut, wasmBuf);
    try {
      const copyingBuf = execFileSync('tar', ['-xOf', tarballPath, TARBALL_MEMBER_COPYING], {
        stdio: 'pipe',
      });
      writeFileSync(copyingOut, copyingBuf);
      copyFileSync(copyingOut, COPYING_TARGET);
    } catch {
      log('no COPYING member in tarball; skipping CC0 text copy');
    }

    rmSync(ESM_TARGET, { force: true });
    rmSync(WASM_TARGET, { force: true });
    copyFileSync(esmOut, ESM_TARGET);
    copyFileSync(wasmOut, WASM_TARGET);

    const esmSha = await sha256OfFile(ESM_TARGET);
    const wasmSha = await sha256OfFile(WASM_TARGET);
    writeFileSync(SHA_FILE, esmSha, 'utf8'); // hex only, no trailing text
    writeFileSync(README_FILE, readmeFor(esmSha, wasmSha), 'utf8');
    log(`vendored ${ESM_TARGET} (sha256 ${esmSha}) + dav1d.wasm (sha256 ${wasmSha})`);

    const { moduleKeys, hasDecodeFrame } = await importCheck();
    log(`node import OK: module keys [${moduleKeys}], decodeFrameAsYUV=${hasDecodeFrame}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  if (verifyOnly) {
    await verify();
    return;
  }
  await vendor();
}

await main();

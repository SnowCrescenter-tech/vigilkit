#!/usr/bin/env node
// Vendors the @yume-chan/libde265 WASM ESM artifact into examples/basic/vendor/.
//
//   node scripts/vendor-libde265.mjs             # pack, extract, copy, pin sha256, refresh README
//   node scripts/vendor-libde265.mjs --verify    # check file exists, sha matches, and imports

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

const PACKAGE = '@yume-chan/libde265@1.0.0';
const TARBALL_MEMBER_ESM = 'package/libde265.mjs'; // package `browser`/`type: module` entry
const TARBALL_MEMBER_WASM = 'package/libde265.wasm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = join(ROOT, 'examples', 'basic', 'vendor');
const ESM_TARGET = join(VENDOR_DIR, 'libde265-esm.js');
const WASM_TARGET = join(VENDOR_DIR, 'libde265.wasm');
const SHA_FILE = join(VENDOR_DIR, 'libde265.sha256');
const README_FILE = join(VENDOR_DIR, 'README.md');

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has('--verify');

function log(message) {
  console.log(`[vendor-libde265] ${message}`);
}

// npm is a .cmd shim on Windows; execFileSync cannot spawn batch shims directly.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message) {
  console.error(`[vendor-libde265] ${message}`);
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

// Resolve the current tarball filename and ESM member from the tarball's package.json.
function inspectTarball(tarballDir, tarballFile) {
  const tarballPath = join(tarballDir, tarballFile);
  const pkgJson = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
    encoding: 'utf8',
  });
  const pkg = JSON.parse(pkgJson);
  const esmMember = pkg.browser ?? pkg.module ?? pkg.main ?? 'libde265.mjs';
  return {
    tarballPath,
    esmMember: `package/${esmMember}`,
    version: pkg.version,
  };
}

function readmeFor(esmSha, wasmSha, version) {
  return `# Vendored libde265 WASM

Physically isolated LGPL-3.0 module used for HEVC soft-decode in browsers without native HEVC WebCodecs (e.g. Firefox). Loaded only when HEVC playback is requested.

- Source: npm package \`@yume-chan/libde265@${version}\` (tarball from \`npm pack\`)
- Files:
  - \`libde265-esm.js\` — ESM dist (package \`browser\`/\`type: module\` entry, \`libde265.mjs\` in the tarball). Exports a default async function that returns the Emscripten Module exposing the \`Decoder\` class.
  - \`libde265.wasm\` — the WebAssembly binary (resolved at runtime via \`new URL("libde265.wasm", import.meta.url)\`, so it must live next to \`libde265-esm.js\`).
- SHA-256 (\`libde265-esm.js\`): ${esmSha}
- SHA-256 (\`libde265.wasm\`): ${wasmSha}
- License: LGPL-3.0-only

## LGPL-3.0 source offer

This vendored artifact is LGPL-3.0. Source code: https://github.com/yume-chan/libde265 or the npm package tarball. It is loaded as a physically isolated module; the vigilkit packages themselves are Apache-2.0. Re-linking: replace this file with any build of libde265 exposing the same ESM API.

## API shape (Node 22 smoke-verified)

The Emscripten module is built with \`ENVIRONMENT_IS_WORKER\` hardcoded, so in Node its \`fetch(file://)\` fails and its XHR fallback does not exist. Inject the wasm bytes as the standard Emscripten \`wasmBinary\` module option:

\`\`\`js
import { readFileSync } from 'node:fs';
import createModule from './libde265-esm.js'; // default export is an async factory

const wasmBinary = new Uint8Array(readFileSync('./libde265.wasm'));
const mod = await createModule({ wasmBinary }); // Emscripten Module instance
// mod.Decoder is the HEVC decoder constructor
\`\`\`

In the browser the module can load the wasm itself (\`new URL("libde265.wasm", import.meta.url)\`); passing \`wasmBinary\` only matters when running under Node.
`;
}

// Prove the vendored module loads in Node and exposes a Decoder constructor.
async function importCheck() {
  const url = pathToFileURL(ESM_TARGET).href;
  const imported = await import(url);
  const factory =
    typeof imported.default === 'function' ? imported.default : imported.Module;
  if (typeof factory !== 'function') {
    throw new Error(
      `no default factory export found; module keys: ${Object.keys(imported).join(',')}`,
    );
  }
  // The Emscripten module is built with ENVIRONMENT_IS_WORKER hardcoded, so in
  // Node its fetch(file://) fails and its XHR fallback does not exist. Inject
  // the wasm bytes directly (standard Emscripten `wasmBinary` module option).
  const wasmBinary = new Uint8Array(readFileSync(WASM_TARGET));
  const mod = await factory({ wasmBinary });
  if (typeof mod.Decoder !== 'function') {
    throw new Error(`Decoder constructor missing; module keys: ${Object.keys(mod).join(',')}`);
  }
  return {
    moduleKeys: Object.keys(mod).slice(0, 20).join(','),
    hasDecoder: typeof mod.Decoder,
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
    const { moduleKeys, hasDecoder } = await importCheck();
    log(`node import OK: module keys [${moduleKeys}], Decoder=${hasDecoder}`);
  } catch (error) {
    fail(`node import FAILED: ${error.message}`);
    ok = false;
  }
  return ok;
}

async function vendor() {
  mkdirSync(VENDOR_DIR, { recursive: true });
  const workDir = mkdtempSync(join(os.tmpdir(), 'libde265-vendor-'));
  try {
    log(`npm pack ${PACKAGE}`);
    const packOut = execFileSync(
      NPM,
      ['pack', PACKAGE, '--pack-destination', workDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' },
    );
    const tarballFile = packOut.trim().split('\n').pop();
    const { tarballPath, esmMember, version } = inspectTarball(workDir, tarballFile);
    log(`extracting ${tarballFile} (${esmMember}, libde265.wasm)`);
    const esmOut = join(workDir, 'out-esm.js');
    const wasmOut = join(workDir, 'out.wasm');
    const esmBuf = execFileSync('tar', ['-xOf', tarballPath, esmMember], { stdio: 'pipe' });
    const wasmBuf = execFileSync('tar', ['-xOf', tarballPath, TARBALL_MEMBER_WASM], { stdio: 'pipe' });
    writeFileSync(esmOut, esmBuf);
    writeFileSync(wasmOut, wasmBuf);

    rmSync(ESM_TARGET, { force: true });
    rmSync(WASM_TARGET, { force: true });
    copyFileSync(esmOut, ESM_TARGET);
    copyFileSync(wasmOut, WASM_TARGET);

    const esmSha = await sha256OfFile(ESM_TARGET);
    const wasmSha = await sha256OfFile(WASM_TARGET);
    writeFileSync(SHA_FILE, esmSha, 'utf8'); // hex only, no trailing text
    writeFileSync(README_FILE, readmeFor(esmSha, wasmSha, version), 'utf8');
    log(`vendored ${ESM_TARGET} (sha256 ${esmSha}) + libde265.wasm (sha256 ${wasmSha})`);

    const { moduleKeys, hasDecoder } = await importCheck();
    log(`node import OK: module keys [${moduleKeys}], Decoder=${hasDecoder}`);
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

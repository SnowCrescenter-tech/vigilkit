#!/usr/bin/env node
// Fetches the HLS TS segment fixture used by tests (or verifies an existing one).
//
//   node scripts/fetch-hls-fixture.mjs            # download when missing or mismatched
//   node scripts/fetch-hls-fixture.mjs --verify   # check only, never download

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIMARY_URL = 'https://fate-suite.ffmpeg.org/mpegts/h264small.ts';
const EXPECTED_SIZE = 16544;
const MAX_REDIRECTS = 5;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = join(ROOT, 'examples', 'basic', 'hls-fixtures');
const TARGET = join(FIXTURES_DIR, 'seg-0.ts');
const SHA_FILE = join(FIXTURES_DIR, 'fixture.sha256');

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has('--verify');

function log(message) {
  console.log(`[hls-fixture] ${message}`);
}

function fail(message) {
  console.error(`[hls-fixture] ${message}`);
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

function fileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return -1;
  }
}

// GET `url` with redirect following; resolves with the temp file path once the
// body has been fully written.
function download(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume(); // drain and discard
          if (redirectsLeft <= 0) {
            reject(new Error(`too many redirects fetching ${url}`));
            return;
          }
          log(`redirect -> ${location}`);
          resolve(download(new URL(location, url).toString(), redirectsLeft - 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status} from ${url}`));
          return;
        }
        const tmp = `${TARGET}.part`;
        const out = createWriteStream(tmp, { flags: 'w' });
        response.pipe(out);
        out.on('finish', () => resolve(tmp));
        out.on('error', reject);
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

async function fetchFixture() {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  log(`downloading ${PRIMARY_URL}`);
  try {
    const tmp = await download(PRIMARY_URL, MAX_REDIRECTS);
    const size = fileSize(tmp);
    if (size !== EXPECTED_SIZE) {
      log(`size mismatch (got ${size}, expected ${EXPECTED_SIZE})`);
      rmSync(tmp, { force: true });
      return false;
    }
    rmSync(TARGET, { force: true }); // Windows cannot rename over an existing file
    renameSync(tmp, TARGET);
    const sha = await sha256OfFile(TARGET);
    writeFileSync(SHA_FILE, sha, 'utf8'); // hex only, no trailing text
    log(`saved ${TARGET} (${size} bytes, sha256 ${sha})`);
    return true;
  } catch (error) {
    log(`failed: ${error.message}`);
    rmSync(`${TARGET}.part`, { force: true });
    return false;
  }
}

async function verify() {
  if (!existsSync(TARGET)) {
    fail(`MISSING fixture: ${TARGET} (run "node scripts/fetch-hls-fixture.mjs" to download)`);
    return false;
  }
  const size = fileSize(TARGET);
  if (size !== EXPECTED_SIZE) {
    fail(`SIZE MISMATCH: ${TARGET} is ${size} bytes, expected ${EXPECTED_SIZE}`);
    return false;
  }
  const sha = await sha256OfFile(TARGET);
  const expected = storedSha();
  if (expected !== null && expected !== sha) {
    fail(`SHA256 MISMATCH: ${TARGET} is ${sha}, expected ${expected}`);
    return false;
  }
  log(`OK: ${TARGET} (${size} bytes, sha256 ${sha})`);
  return true;
}

async function main() {
  if (verifyOnly) {
    await verify();
    return;
  }

  if (existsSync(TARGET)) {
    const size = fileSize(TARGET);
    const sha = await sha256OfFile(TARGET);
    const expected = storedSha();
    if (size === EXPECTED_SIZE && (expected === null || expected === sha)) {
      log(`up-to-date: ${TARGET} (${size} bytes, sha256 ${sha})`);
      return;
    }
    log(`existing fixture mismatched (size ${size}, sha256 ${sha}); re-downloading`);
  }

  const ok = await fetchFixture();
  if (!ok) {
    fail('could not download fixture');
    return;
  }
  log('fixture ready');
}

await main();

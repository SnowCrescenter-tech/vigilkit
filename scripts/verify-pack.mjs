#!/usr/bin/env node
// Verifies that every publishable vigilkit package packs a clean, publishable
// tarball. This is the last gate before scripts/publish-all.mjs runs.
//
//   node scripts/verify-pack.mjs
//
// For each of the 17 packages it runs a real `pnpm pack --pack-destination
// <tmp>`, extracts the tarball, and asserts:
//   (a) dist/index.js and dist/index.d.ts are present in the tarball;
//   (b) there is NO node_modules directory anywhere inside the tarball;
//   (c) the packed package.json has no `workspace:` protocol left 闁?every
//       dependency is resolved to a real published version.
//
// Reports per-package PASS/FAIL and exits 1 if any package fails.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Same package set (and order) as scripts/publish-all.mjs.
const PACKAGES = [
  { name: '@vigilkit/plugin-sdk', dir: 'packages/plugin-sdk' },
  { name: '@vigilkit/media-utils', dir: 'packages/media-utils' },
  { name: '@vigilkit/media-audio-codecs', dir: 'packages/media-audio-codecs' },
  { name: '@vigilkit/plugin-flv', dir: 'packages/plugins/flv' },
  { name: '@vigilkit/plugin-ws', dir: 'packages/plugins/ws' },
  { name: '@vigilkit/plugin-hls', dir: 'packages/plugins/hls' },
  { name: '@vigilkit/plugin-whep', dir: 'packages/plugins/whep' },
  { name: '@vigilkit/plugin-ps', dir: 'packages/plugins/ps' },
  { name: '@vigilkit/plugin-gb28181', dir: 'packages/plugins/gb28181' },
  { name: 'vigilkit', dir: 'packages/core' },
  { name: '@vigilkit/plugin-hevc-wasm', dir: 'packages/plugins/hevc-wasm' },
  { name: '@vigilkit/plugin-dav1d-wasm', dir: 'packages/plugins/dav1d-wasm' },
  { name: '@vigilkit/plugin-hikvision', dir: 'packages/plugins/hikvision' },
  { name: '@vigilkit/plugin-dahua', dir: 'packages/plugins/dahua' },
  { name: '@vigilkit/plugin-uniview', dir: 'packages/plugins/uniview' },
  { name: '@vigilkit/plugin-mqtt', dir: 'packages/plugins/mqtt' },
  { name: '@vigilkit/renderer', dir: 'packages/renderer' },
];

/**
 * Runs pnpm through the platform shell. pnpm is a .cmd shim on Windows, and
 * Node refuses to spawn .cmd files without a shell (EINVAL), so we go through
 * cmd.exe /d /s /c on Windows and /bin/sh elsewhere. All args are static
 * strings (or quoted when they may contain spaces), so shell quoting is safe.
 */
function runPnpm(args, cwd) {
  return spawnSync('pnpm', args, { cwd, encoding: 'utf8', shell: true });
}

/** Last non-empty line of a captured stream, for compact error messages. */
function tail(message) {
  return (message || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
    ?.slice(0, 300);
}

/** Recursively reports whether `dir` (or anything under it) is node_modules. */
function containsNodeModules(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules') return true;
    if (containsNodeModules(join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * Collects every dependency spec that still carries the `workspace:` protocol.
 * pnpm pack rewrites workspace:* to the real version; any leftover means the
 * package would publish broken dependency links.
 */
function workspaceRefs(manifest) {
  const refs = [];
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest[section];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (String(spec).includes('workspace:')) refs.push(`${section}.${name}: ${spec}`);
    }
  }
  return refs;
}

/**
 * Finds the package root inside the extracted tarball. npm/pnpm pack prefix
 * everything with `package/`; fall back to scanning for a package.json.
 */
function findPackageRoot(unpacked) {
  const candidate = join(unpacked, 'package');
  if (existsSync(join(candidate, 'package.json'))) return candidate;
  for (const entry of readdirSync(unpacked, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(unpacked, entry.name, 'package.json'))) {
      return join(unpacked, entry.name);
    }
  }
  return unpacked;
}

/** Packs one package into a fresh temp dir and returns { problems, tgz, size }. */
function verify(pkg) {
  const pkgDir = join(ROOT, pkg.dir);
  const work = mkdtempSync(join(tmpdir(), 'vigilkit-pack-'));
  const problems = [];
  let tgz = null;
  try {
    // pnpm pack does NOT run prepublishOnly, so make sure dist exists first
    // (a build-less pack would silently produce a tarball without dist/).
    if (!existsSync(join(pkgDir, 'dist', 'index.js'))) {
      const build = runPnpm(['build'], pkgDir);
      if (build.status !== 0) {
        problems.push(
          `dist/index.js missing and \`pnpm build\` failed: ${tail(build.error?.message || build.stderr || build.stdout) || 'no output'}`,
        );
        return { problems, tgz: null };
      }
    }

    // Quote the destination: the temp path may contain spaces, and with
    // shell:true the argument is interpolated verbatim into the command line.
    const pack = runPnpm(['pack', '--pack-destination', `"${work}"`], pkgDir);
    if (pack.status !== 0) {
      problems.push(
        `\`pnpm pack\` failed: ${tail(pack.error?.message || pack.stderr || pack.stdout) || 'no output'}`,
      );
      return { problems, tgz: null };
    }

    tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
    if (!tgz) {
      problems.push('pnpm pack produced no .tgz file');
      return { problems, tgz: null };
    }

    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    const tar = spawnSync('tar', ['-xzf', join(work, tgz), '-C', unpacked], { encoding: 'utf8' });
    if (tar.status !== 0) {
      problems.push(`\`tar -xzf\` failed: ${tail(tar.stderr || tar.stdout) || 'no output'}`);
      return { problems, tgz };
    }

    const packageRoot = findPackageRoot(unpacked);

    // (a) dist entry points must be in the tarball.
    for (const file of ['dist/index.js', 'dist/index.d.ts']) {
      if (!existsSync(join(packageRoot, file))) problems.push(`${file} missing from tarball`);
    }

    // (b) node_modules must never be packed.
    if (containsNodeModules(packageRoot)) problems.push('tarball contains a node_modules directory');

    // (c) no workspace: protocol may remain in the packed manifest.
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const leftover = workspaceRefs(manifest);
    for (const ref of leftover) problems.push(`workspace: protocol still present (${ref})`);

    // (d) LICENSE must ship in every tarball (npm auto-includes it, but only
    // if a LICENSE file exists in the package 闁?assert it made it in). The
    // wasm adapter packages also carry a NOTICE with third-party attribution
    // (LGPL-3.0 source offer for libde265, BSD/CC0 for dav1d); it is NOT
    // auto-included by npm, so the `files` array must list it 闁?assert it.
    if (!existsSync(join(packageRoot, 'LICENSE'))) problems.push('LICENSE missing from tarball');
    if (pkg.name === '@vigilkit/plugin-hevc-wasm' || pkg.name === '@vigilkit/plugin-dav1d-wasm') {
      if (!existsSync(join(packageRoot, 'NOTICE'))) {
        problems.push('NOTICE missing from tarball (third-party attribution must ship)');
      }
    }

    return { problems, tgz };
  } catch (error) {
    problems.push(`verification threw: ${error.message}`);
    return { problems, tgz };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const results = [];
for (const pkg of PACKAGES) {
  const { problems, tgz } = verify(pkg);
  const ok = problems.length === 0;
  results.push({ pkg, ok, problems, tgz });
  if (ok) {
    console.log(`[verify-pack] PASS  ${pkg.name.padEnd(26)} ${tgz ?? ''}`);
  } else {
    console.error(`[verify-pack] FAIL  ${pkg.name.padEnd(26)} ${tgz ?? ''}`);
    for (const problem of problems) console.error(`[verify-pack]        - ${problem}`);
  }
}

const passed = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`[verify-pack] verdict: ${passed}/${total} PASS`);
if (passed !== total) {
  console.error('[verify-pack] one or more packages are not publishable 闁?aborting release.');
  process.exit(1);
}

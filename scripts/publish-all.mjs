#!/usr/bin/env node
// Publishes every publishable vigilkit package, in dependency order.
//
//   node scripts/publish-all.mjs                      # publish all 8 packages, in order
//   node scripts/publish-all.mjs --dry-run            # print the ordered plan, publish nothing
//   node scripts/publish-all.mjs --only <name>        # publish a single package only (resume)
//   node scripts/publish-all.mjs --only @vigilkit/plugin-flv --dry-run
//
// Each package is published from its own directory with `pnpm publish
// --no-git-checks`: the package's prepublishOnly script builds dist/ first,
// and --no-git-checks skips pnpm's dirty-worktree check. The order below is
// the topological order of the workspace:* dependency edges (a package is only
// published after everything it depends on), so dependents resolve real
// published versions instead of unpublished ones. Publishing aborts at the
// first failure (reported with package + command) and exits 1.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ordered publish list. ORDER MATTERS — it encodes the dependency edges:
//   plugin-sdk <- {flv, ws, hls, core}; media-utils <- {flv, hls};
//   core (vigilkit) <- {hevc-wasm, renderer}.
const PACKAGES = [
  { name: '@vigilkit/plugin-sdk', dir: 'packages/plugin-sdk' },
  { name: '@vigilkit/media-utils', dir: 'packages/media-utils' },
  { name: '@vigilkit/plugin-flv', dir: 'packages/plugins/flv' },
  { name: '@vigilkit/plugin-ws', dir: 'packages/plugins/ws' },
  { name: '@vigilkit/plugin-hls', dir: 'packages/plugins/hls' },
  { name: 'vigilkit', dir: 'packages/core' },
  { name: '@vigilkit/plugin-hevc-wasm', dir: 'packages/plugins/hevc-wasm' },
  { name: '@vigilkit/plugin-dav1d-wasm', dir: 'packages/plugins/dav1d-wasm' },
  { name: '@vigilkit/plugin-hikvision', dir: 'packages/plugins/hikvision' },
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

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyArg = args.indexOf('--only');
const onlyName = onlyArg !== -1 ? args[onlyArg + 1] : undefined;
if (onlyArg !== -1 && !onlyName) {
  console.error('[publish] --only requires a package name, e.g. --only @vigilkit/plugin-flv');
  process.exit(1);
}

/** Reads the version from the package manifest (used for plan reporting). */
function versionOf(pkg) {
  const manifestPath = join(ROOT, pkg.dir, 'package.json');
  if (!existsSync(manifestPath)) {
    console.error(`[publish] missing manifest: ${manifestPath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')).version ?? '?';
}

// Resolve the plan. --only restricts to a single package and skips the order
// check (useful to resume a run after a failure was fixed).
let plan = PACKAGES;
if (onlyName) {
  const match = PACKAGES.find((p) => p.name === onlyName);
  if (!match) {
    console.error(`[publish] unknown package "${onlyName}". Known packages:`);
    for (const p of PACKAGES) console.error(`  - ${p.name}`);
    process.exit(1);
  }
  plan = [match];
}

// Per-package command, run with cwd = package dir. prepublishOnly builds dist.
const PUBLISH_ARGS = ['publish', '--no-git-checks'];

if (dryRun) {
  console.log(
    `[publish] plan: ${plan.length} package(s) in order (dry-run — nothing will be published)`,
  );
  for (const [i, pkg] of plan.entries()) {
    const dir = join(ROOT, pkg.dir);
    console.log(
      `  ${String(i + 1).padStart(2)}. ${pkg.name.padEnd(26)} ${versionOf(pkg).padEnd(7)} ` +
        `${relative(ROOT, dir)}`,
    );
    console.log(`     $ pnpm ${PUBLISH_ARGS.join(' ')}   (cwd: ${relative(ROOT, dir)})`);
  }
  process.exit(0);
}

/** Prefixes every captured output line with the package name. */
function printCaptured(pkgName, result) {
  const stdout = (result.stdout ?? '').split(/\r?\n/).filter(Boolean);
  const stderr = (result.stderr ?? '').split(/\r?\n/).filter(Boolean);
  for (const line of stdout) console.log(`[${pkgName}] ${line}`);
  for (const line of stderr) console.error(`[${pkgName}] ${line}`);
}

const failures = [];
for (const [i, pkg] of plan.entries()) {
  const cwd = join(ROOT, pkg.dir);
  const rel = relative(ROOT, cwd);
  console.log(
    `[publish] (${i + 1}/${plan.length}) ${pkg.name}@${versionOf(pkg)} — ` +
      `pnpm ${PUBLISH_ARGS.join(' ')} (cwd: ${rel})`,
  );
  const result = runPnpm(PUBLISH_ARGS, cwd);
  printCaptured(pkg.name, result);
  if (result.error) {
    console.error(
      `[publish] FAILED: ${pkg.name}@${versionOf(pkg)} — could not run command (${result.error.message})`,
    );
    failures.push({ pkg, reason: result.error.message });
    break;
  }
  if (result.status !== 0) {
    console.error(
      `[publish] FAILED: ${pkg.name}@${versionOf(pkg)} — pnpm publish exited with status ${result.status}`,
    );
    failures.push({ pkg, reason: `exit status ${result.status}` });
    break;
  }
}

if (failures.length > 0) {
  const { pkg, reason } = failures[0];
  console.error('[publish] ABORTED at first failure — nothing after this was published.');
  console.error(`[publish]   package: ${pkg.name}@${versionOf(pkg)}`);
  console.error(
    `[publish]   command: pnpm ${PUBLISH_ARGS.join(' ')} (cwd: ${relative(ROOT, join(ROOT, pkg.dir))})`,
  );
  console.error(`[publish]   reason: ${reason}`);
  process.exit(1);
}

const summary =
  onlyName !== undefined
    ? `published 1 package (${onlyName})`
    : `published ${plan.length} package(s) in dependency order`;
console.log(`[publish] summary: ${summary}`);

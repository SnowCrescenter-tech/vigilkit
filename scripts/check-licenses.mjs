#!/usr/bin/env node
// Scans all installed dependencies for license compliance.
//
//   node scripts/check-licenses.mjs                      # summary table + blocklist verdict
//   node scripts/check-licenses.mjs --generate-notices   # also write THIRD-PARTY-NOTICES.md
//   node scripts/check-licenses.mjs --ci                 # exit 1 on blocklist hit or init error
//
// Blocklist (hard failure): GPL / AGPL / LGPL, any variant.
// Allowlist (warn only when unknown): Apache-2.0, MIT, ISC, BSD-2-Clause,
// BSD-3-Clause, 0BSD, CC0-1.0, CC-BY-*, Unlicense.
//
// Vendored-artifact policy: LGPL is never allowed as a dependency (the scan
// above enforces that). The one sanctioned exception is a physically isolated,
// runtime-loaded WASM artifact that is not an npm dependency and never enters
// the package graph, e.g. the libde265 HEVC decoder vendored under
// examples/basic/vendor/ and loaded by @vigilkit/plugin-hevc-wasm with a
// sha256 check. Those files are not in the dependency tree, so they cannot
// appear here; their LGPL source offer is documented in
// examples/basic/vendor/README.md, the plugin NOTICE, and
// THIRD-PARTY-NOTICES.md (see the "Vendored artifacts" section).

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// license-checker-rseidelsohn ships as ESM (named `init`); older versions were
// CJS. The namespace import works for both shapes at runtime.
import * as checkerModule from 'license-checker-rseidelsohn';

const BLOCKLIST = /GPL|AGPL|LGPL/i;
const ALLOWLIST = [
  'apache-2.0',
  'mit',
  'isc',
  'bsd-2-clause',
  'bsd-3-clause',
  '0bsd',
  'cc0-1.0',
  'unlicense',
  // Vite dev tooling transitive dep (CSS transformer, dev-only). File-level
  // copyleft; acceptable for dev tooling, listed for explicit review.
  'mpl-2.0',
  // pnpm toolchain transitive deps (dev-only). BlueOak-1.0.0 and Python-2.0
  // are both permissive licenses.
  'blueoak-1.0.0',
  'python-2.0',
];

/** Scans a pass of the dependency tree (production XOR dev) and returns entries. */
async function scanPass(checker, opts) {
  return await new Promise((resolve, reject) => {
    checker.init(
      {
        start: process.cwd(),
        production: opts.production,
        dev: opts.dev,
        excludePrivatePackages: true,
        customFormat: CUSTOM_FORMAT,
      },
      (err, data) => (err ? reject(new Error(err.message || String(err))) : resolve(data ?? {})),
    );
  });
}

const args = new Set(process.argv.slice(2));
const generateNotices = args.has('--generate-notices');
const ciMode = args.has('--ci');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTICES_FILE = join(ROOT, 'THIRD-PARTY-NOTICES.md');

// Fields collected per package by license-checker-rseidelsohn.
const CUSTOM_FORMAT = {
  name: '',
  version: '',
  licenses: '',
  publisher: '',
};

function loadChecker() {
  // ESM build exposes `init` directly; a CJS build would expose it via `default`.
  const candidate = checkerModule.init ? checkerModule : checkerModule.default;
  if (candidate && typeof candidate.init === 'function') return candidate;
  // Neither shape resolved; fall back to a CJS require.
  const require = createRequire(import.meta.url);
  return require('license-checker-rseidelsohn');
}

function normalizeLicenses(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(/\s+(?:OR|AND)\s+/i);
  return parts.map((p) => String(p).replace(/[()]/g, '').trim()).filter(Boolean);
}

function isBlocked(entry) {
  return normalizeLicenses(entry?.licenses).some((license) => BLOCKLIST.test(license));
}

function isAllowedLicense(license) {
  const id = license.toLowerCase();
  if (id === '*' || id === '') return false;
  if (BLOCKLIST.test(id)) return true; // reported as a failure, not a warning
  if (ALLOWLIST.includes(id)) return true;
  if (id.startsWith('cc-by')) return true;
  return false;
}

function licenseLabel(entry) {
  const licenses = normalizeLicenses(entry?.licenses);
  return licenses.length > 0 ? licenses.join(', ') : 'UNKNOWN';
}

function parseKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { name: key, version: '' };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function markdownRow(name, version, licenses, publisher) {
  return `| ${name} | ${version} | ${licenses} | ${publisher} |`;
}

function printTable(entries) {
  console.log(markdownRow('Package', 'Version', 'License', 'Publisher'));
  console.log('| --- | --- | --- | --- |');
  for (const entry of entries) {
    console.log(markdownRow(entry.name, entry.version, entry.licenses, entry.publisher));
  }
}

async function main() {
  const checker = loadChecker();

  let packages;
  try {
    // Scan BOTH passes: dev deps AND runtime deps. A dependency added to any
    // package's `dependencies` field must never silently disappear from the
    // scan or the notices (it would bypass the GPL blocklist). Runtime deps of
    // workspace packages are all `workspace:*` today, but the scan must cover
    // them regardless.
    const [devTree, prodTree] = await Promise.all([
      scanPass(checker, { production: false, dev: true }),
      scanPass(checker, { production: true, dev: false }),
    ]);
    packages = { ...devTree, ...prodTree };
  } catch (error) {
    console.error(`[licenses] init failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const entries = Object.entries(packages)
    .map(([key, entry]) => {
      const parsed = parseKey(key);
      return {
        key,
        name: entry?.name || parsed.name,
        version: entry?.version || parsed.version,
        licenses: licenseLabel(entry),
        publisher: entry?.publisher || '',
        entry,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const blocked = entries.filter((e) => isBlocked(e.entry));
  const unknown = entries.filter(
    (e) =>
      !blocked.includes(e) &&
      normalizeLicenses(e.entry?.licenses).some((license) => !isAllowedLicense(license)),
  );

  if (!ciMode) {
    console.log(`Scanned ${entries.length} packages`);
    console.log('');
    printTable(entries);
    console.log('');
  }

  for (const entry of unknown) {
    console.warn(`[licenses] WARN: unknown license for ${entry.name}@${entry.version} (${entry.licenses})`);
  }

  if (blocked.length > 0) {
    console.error('[licenses] BLOCKLIST violation(s):');
    for (const entry of blocked) {
      console.error(`  - ${entry.name}@${entry.version}: ${entry.licenses}`);
    }
    console.error('[licenses] verdict: FAIL');
    process.exitCode = 1;
  } else if (ciMode && unknown.length > 0) {
    // In CI, an unrecognized/missing license field is a hard failure: a GPL
    // dep declared as "UNKNOWN" or "SEE LICENSE IN ..." must not slip through
    // as warn-only. Warnings are still fine for interactive runs.
    console.error('[licenses] UNKNOWN licenses in CI are failures (missing or unparseable license field):');
    for (const entry of unknown) {
      console.error(`  - ${entry.name}@${entry.version}: ${entry.licenses}`);
    }
    console.error('[licenses] verdict: FAIL (unknown license)');
    process.exitCode = 1;
  } else {
    console.log('[licenses] verdict: PASS (no GPL/AGPL/LGPL dependencies)');
  }

  if (generateNotices) {
    const lines = [
      '# Third-Party Notices',
      '',
      'Generated by scripts/check-licenses.mjs — do not edit manually.',
      '',
      markdownRow('Package', 'Version', 'License', 'Publisher'),
      '| --- | --- | --- | --- |',
      ...entries.map((e) => markdownRow(e.name, e.version, e.licenses, e.publisher)),
      '',
    ];
    writeFileSync(NOTICES_FILE, lines.join('\n'), 'utf8');
    console.log(`[licenses] wrote ${NOTICES_FILE}`);
  }
}

await main();

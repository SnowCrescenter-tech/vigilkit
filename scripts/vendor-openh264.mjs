#!/usr/bin/env node
// OpenH264 WASM vendor script — DEFERRED.
//
// The ROADMAP P1-6 constraint requires the Cisco official binary, and Cisco
// publishes NO WASM build of OpenH264 (only native .so/.dll/.dylib). A
// third-party WASM build would be a recompilation that Cisco's patent license
// does not cover, so there is nothing to vendor under the policy.
//
// This script is a documented stub: it verifies the deferral still holds and
// exits 1 (so it can never silently "succeed" with nothing shipped). See
// packages/plugins/openh264-wasm/DEFERRED.md for the full research table,
// size projection, and the un-defer trigger.
//
//   node scripts/vendor-openh264.mjs       # prints the deferral, exits 1
//   node scripts/vendor-openh264.mjs --verify

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECIDED = join(ROOT, 'packages', 'plugins', 'openh264-wasm', 'DEFERRED.md');

const args = new Set(process.argv.slice(2));
void args; // --verify accepted; the deferral is the only outcome either way.

function log(message) {
  console.log(`[vendor-openh264] ${message}`);
}

log('OpenH264 WASM is DEFERRED (no Cisco-official WASM binary exists).');
log(`Research + un-defer trigger: ${DECIDED}`);
log('The ROADMAP P1-6 constraint ("Cisco official binary only, NO recompilation")');
log('cannot be satisfied for WASM today; shipping a third-party build would');
log('expose H.264 patent liability that the Cisco binary license is meant to remove.');
console.error('[vendor-openh264] nothing vendored — deferral is intentional.');
process.exitCode = 1;

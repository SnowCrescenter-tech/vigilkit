// extract-flv-head.mjs
// Extracts the first 65536 bytes of the FLV test fixture into a head-only
// binary used by the @vigilkit/plugin-flv test suite. Idempotent.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'examples', 'basic', 'fixtures', 'Enigma_Principles_of_Lust-part.flv');
const target = join(root, 'packages', 'plugins', 'flv', 'test', 'fixtures', 'fate-head.bin');
const HEAD_SIZE = 65536;

const data = readFileSync(source);
const head = data.subarray(0, Math.min(HEAD_SIZE, data.length));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, head);

console.log(`source: ${source}`);
console.log(`target: ${target}`);
console.log(`size: ${head.length} bytes`);

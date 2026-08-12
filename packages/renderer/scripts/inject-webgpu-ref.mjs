// Injects the @webgpu/types triple-slash reference into the emitted
// dist/index.d.ts. tsup's dts emitter drops source-level triple-slash
// directives, but the bundled declarations reference WebGPU globals
// (GPU, GPUTextureFormat, ...) which are not in the TS DOM lib. @webgpu/types
// is a runtime dependency of this package; the reference makes the
// declarations self-contained for consumers with a plain tsconfig.
//
// Idempotent: no-op when the reference is already present.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dtsPath = join(root, 'dist', 'index.d.ts');
const REF = '/// <reference types="@webgpu/types" />';

const content = readFileSync(dtsPath, 'utf8');
if (content.includes(REF)) {
  console.log('[inject-webgpu-ref] already present; no-op');
} else {
  writeFileSync(dtsPath, `${REF}\n\n${content}`, 'utf8');
  console.log('[inject-webgpu-ref] injected reference');
}

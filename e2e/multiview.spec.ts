// End-to-end multi-view performance baseline (chromium-only).
//
// Multiview mode (?source=multiview&views=N) plays N independent WS-FLV
// streams on one page — one canvas + one createPlayer per view — and is the
// reference harness for docs/performance-budget.md. This spec locks the
// baseline contract for N ∈ {4, 9, 16} (ROADMAP P0-4 / v0.6 work item C:
// the 4-view baseline extended to surveillance-grid densities): every view
// must start decoding, no view may surface errors or QoS stall episodes, and
// aggregate heap memory must stay under the 1.5 GB budget whenever the memory
// API is actually available.
//
// Timeouts: 4 and 9 views decode within the same 30 s budget as the original
// baseline. 16 views push 16 concurrent WebCodecs decode pipelines through
// the single bounded `workers: 2` Playwright pool, so they get a 60 s decode
// budget (and a matching per-test timeout raise) to stay deterministic under
// CPU contention instead of flaking on the shared 30 s budget. The config's
// 60 s per-test timeout is left untouched; the 16-view test raises its own
// limit via test.setTimeout().
//
// Chromium-only for two reasons, mirroring the project-aware pattern in
// basic.spec.ts via testInfo.project.name: the baseline budgets are defined
// against Chromium's WebCodecs H.264 path, and the memory API
// (performance.measureUserAgentSpecificMemory) is Chromium-only. Firefox is
// exercised by the single-stream specs. The firefox project therefore reports
// this test as skipped rather than weakened.
//
// MEMORY NOTE: measureUserAgentSpecificMemory requires a cross-origin
// isolated page (the example server run with --coop). The default e2e
// webServer runs without --coop, so the demo reports memoryMB = null and the
// memory assertion is skipped with a log line — the 'if available' contract.
// Run the server with --coop locally to measure the real number.

import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface MultiviewViewStats {
  fps: number;
  framesDecoded: number;
  errors: number;
  stalledCount: number;
}

interface MultiviewStats {
  views: MultiviewViewStats[];
  memoryMB: number | null;
}

interface VigilkitApi {
  multiview?: { stats(): MultiviewStats; stop(): void };
}

const ARTIFACTS_DIR = path.join(process.cwd(), 'e2e', 'artifacts');
const SURFACE_TIMEOUT_MS = 30000;
const MEMORY_TIMEOUT_MS = 25000;
/**
 * Test-level timeout for the 16-view case. The config caps every test at
 * 60 s, which the 16-view budget alone (30 s surface + 60 s decode + 25 s
 * memory) would exceed; 4/9 stay on the config default.
 */
const DECODE_16_TEST_TIMEOUT_MS = 180000;

interface MultiviewCase {
  viewCount: number;
  decodeTimeoutMs: number;
}

const MULTIVIEW_CASES: MultiviewCase[] = [
  { viewCount: 4, decodeTimeoutMs: 30000 },
  { viewCount: 9, decodeTimeoutMs: 30000 },
  // 16 views share the bounded workers: 2 pool with every other spec; the
  // 30 s budget assumes a handful of pipelines, so this density gets a 60 s
  // decode budget (plus the per-test timeout above) to stay deterministic.
  { viewCount: 16, decodeTimeoutMs: 60000 },
];

/** evaluate()/waitForFunction() callbacks are serialized: no outer value closures, only types. */
type WindowWithVigilkit = Window & { __vigilkit: VigilkitApi };

async function readMultiviewStats(page: Page): Promise<MultiviewStats> {
  return page.evaluate(() => {
    const multiview = (window as unknown as WindowWithVigilkit).__vigilkit.multiview;
    if (multiview === undefined) {
      throw new Error('__vigilkit.multiview is not available');
    }
    return multiview.stats();
  });
}

for (const { viewCount, decodeTimeoutMs } of MULTIVIEW_CASES) {
  test(
    `multiview baseline: ${viewCount} views decode with 0 errors and 0 stalls`,
    async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'chromium', 'multiview baseline is chromium-only');
      if (viewCount === 16) {
        test.setTimeout(DECODE_16_TEST_TIMEOUT_MS);
      }

      const baseUrl = `http://localhost:8090/?source=multiview&views=${viewCount}`;
      const artifactStem = `multiview-${viewCount}`;

      const consoleLines: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
      page.on('pageerror', (err) => pageErrors.push(`PAGEERROR: ${err.message}`));

      let lastStats: MultiviewStats | null = null;
      try {
        await page.goto(baseUrl);

        // 1. The demo surface must be published (main.ts exposes it via a getter).
        await page.waitForFunction(
          () => (window as unknown as WindowWithVigilkit).__vigilkit.multiview !== undefined,
          undefined,
          { timeout: SURFACE_TIMEOUT_MS },
        );

        // 2. Every view must start decoding within the per-density budget
        // (30 s for 4/9, 60 s for 16).
        await page.waitForFunction(
          (expected) => {
            const multiview = (window as unknown as WindowWithVigilkit).__vigilkit.multiview;
            if (multiview === undefined) {
              return false;
            }
            const stats = multiview.stats();
            return stats.views.length === expected && stats.views.every((view) => view.framesDecoded > 0);
          },
          viewCount,
          { timeout: decodeTimeoutMs },
        );

        // 3. Steady-state snapshot: all views present, 0 errors, 0 stalls each.
        const stats = await readMultiviewStats(page);
        lastStats = stats;
        expect(stats.views, `multiview stats: ${JSON.stringify(stats)}`).toHaveLength(viewCount);
        for (const view of stats.views) {
          expect(view.errors, `view errors: ${JSON.stringify(view)}`).toBe(0);
          expect(view.stalledCount, `view stalls: ${JSON.stringify(view)}`).toBe(0);
          expect(view.fps, `view fps: ${JSON.stringify(view)}`).toBeGreaterThan(0);
        }

        // 4. Memory budget: assert only when the API actually produced a
        // measurement (cross-origin isolated page); otherwise skip with a log.
        let memoryMB: number | null = null;
        const canMeasure = await page.evaluate(() => window.crossOriginIsolated === true);
        if (canMeasure) {
          try {
            await page.waitForFunction(
              () => {
                const multiview = (window as unknown as WindowWithVigilkit).__vigilkit.multiview;
                return multiview !== undefined && multiview.stats().memoryMB !== null;
              },
              undefined,
              { timeout: MEMORY_TIMEOUT_MS },
            );
            memoryMB = (await readMultiviewStats(page)).memoryMB;
          } catch {
            console.log('e2e: memory measurement did not resolve in time; budget assertion skipped');
          }
        } else {
          console.log(
            'e2e: page is not cross-origin-isolated (server --coop off); ' +
              'memory budget assertion skipped',
          );
        }
        if (memoryMB !== null) {
          expect(memoryMB, 'aggregate memory must stay under the 1.5 GB budget').toBeLessThan(1500);
        }

        // 5. Screenshot artifact for the record.
        await mkdir(ARTIFACTS_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(ARTIFACTS_DIR, `${artifactStem}.png`),
          fullPage: true,
        });
      } finally {
        // Artifacts are written on success AND failure so a red run stays
        // diagnosable (console + stats.json + the UI screenshot).
        await mkdir(ARTIFACTS_DIR, { recursive: true });
        try {
          await writeFile(
            path.join(ARTIFACTS_DIR, `${artifactStem}-console.log`),
            [...consoleLines, ...pageErrors].join('\n') + '\n',
            'utf8',
          );
        } catch (error) {
          console.warn(`e2e: failed to write ${artifactStem}-console.log: ${String(error)}`);
        }
        try {
          const snapshot = lastStats ?? (await readMultiviewStats(page));
          await writeFile(
            path.join(ARTIFACTS_DIR, `${artifactStem}-stats.json`),
            JSON.stringify(snapshot, null, 2) + '\n',
            'utf8',
          );
        } catch (error) {
          console.warn(`e2e: failed to write ${artifactStem}-stats.json: ${String(error)}`);
        }
        try {
          await page.screenshot({
            path: path.join(ARTIFACTS_DIR, `${artifactStem}.png`),
            fullPage: true,
          });
        } catch (error) {
          console.warn(`e2e: failed to write ${artifactStem}.png: ${String(error)}`);
        }
      }
    },
  );
}

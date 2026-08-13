// End-to-end multi-view performance baseline (chromium-only).
//
// Multiview mode (?source=multiview&views=N) plays N independent WS-FLV
// streams on one page — one canvas + one createPlayer per view — and is the
// reference harness for docs/performance-budget.md. This spec locks the
// baseline contract: every view must start decoding, no view may surface
// errors or QoS stall episodes, and aggregate heap memory must stay under the
// 1.5 GB budget whenever the memory API is actually available.
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
const BASE_URL = 'http://localhost:8090/?source=multiview&views=4';
const VIEW_COUNT = 4;
const DECODE_TIMEOUT_MS = 30000;
const MEMORY_TIMEOUT_MS = 25000;

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

test('multiview baseline: 4 views decode with 0 errors and 0 stalls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'multiview baseline is chromium-only');

  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(`PAGEERROR: ${err.message}`));

  let lastStats: MultiviewStats | null = null;
  try {
    await page.goto(BASE_URL);

    // 1. The demo surface must be published (main.ts exposes it via a getter).
    await page.waitForFunction(
      () => (window as unknown as WindowWithVigilkit).__vigilkit.multiview !== undefined,
      undefined,
      { timeout: 30000 },
    );

    // 2. Every view must start decoding within 30 s of page load.
    await page.waitForFunction(
      (expected) => {
        const multiview = (window as unknown as WindowWithVigilkit).__vigilkit.multiview;
        if (multiview === undefined) {
          return false;
        }
        const stats = multiview.stats();
        return stats.views.length === expected && stats.views.every((view) => view.framesDecoded > 0);
      },
      VIEW_COUNT,
      { timeout: DECODE_TIMEOUT_MS },
    );

    // 3. Steady-state snapshot: all views present, 0 errors, 0 stalls each.
    const stats = await readMultiviewStats(page);
    lastStats = stats;
    expect(stats.views, `multiview stats: ${JSON.stringify(stats)}`).toHaveLength(VIEW_COUNT);
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
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'multiview.png'), fullPage: true });
  } finally {
    // Artifacts are written on success AND failure so a red run stays
    // diagnosable (console + stats.json + the UI screenshot).
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    try {
      await writeFile(
        path.join(ARTIFACTS_DIR, 'multiview-console.log'),
        [...consoleLines, ...pageErrors].join('\n') + '\n',
        'utf8',
      );
    } catch (error) {
      console.warn(`e2e: failed to write multiview-console.log: ${String(error)}`);
    }
    try {
      const snapshot = lastStats ?? (await readMultiviewStats(page));
      await writeFile(
        path.join(ARTIFACTS_DIR, 'multiview-stats.json'),
        JSON.stringify(snapshot, null, 2) + '\n',
        'utf8',
      );
    } catch (error) {
      console.warn(`e2e: failed to write multiview-stats.json: ${String(error)}`);
    }
    try {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'multiview.png'), fullPage: true });
    } catch (error) {
      console.warn(`e2e: failed to write multiview.png: ${String(error)}`);
    }
  }
});

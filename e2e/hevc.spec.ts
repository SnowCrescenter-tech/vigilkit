// End-to-end browser QA for the vigilkit HEVC soft-decode demo.
//
// The example serves a pinned Annex-B HEVC fixture (examples/basic/hevc-
// fixtures/paired_fields.hevc) at /hevc/paired_fields.hevc and the vendored
// libde265 artifacts (examples/basic/vendor/) at /vendor/*. The page is
// opened with ?source=hevc, which selects the HEVC demo mode in main.ts:
// a HevcDemo (src/hevc-demo.ts) bypasses createPlayer, fetches the fixture,
// splits it on Annex-B start codes, and feeds the chunks to a HevcSoftDecoder
// running in a Vite module worker. The worker copies I420 planes into a
// transferable buffer; the main thread builds the VideoFrame and draws it.
// If the worker path fails, the demo falls back to main-thread decoding
// through the same soft factory. Either path must end with framesDecoded > 0
// and errors === 0.
//
// ENVIRONMENT NOTES (headless chromium on this machine, Aug 2026):
//
// 1. Renderer init: for non-FLV modes main.ts awaits createRendererAsync,
//    which probes WebGPU FIRST by calling canvas.getContext('webgpu'). In
//    headless chromium the webgpu context creation succeeds but
//    requestAdapter() finds no adapter ("No available adapters."), and the
//    canvas is then permanently locked to webgpu mode — every fallback
//    (WebGL2, Canvas2D) returns null and main() rejects with "no renderer
//    available", so window.__vigilkit never appears. No chromium launch
//    flag in this build disables that (verified: --disable-webgpu is not a
//    real switch, --disable-blink-features=WebGPU and
//    --disable-features=WebGPUService are inert). The test therefore hides
//    navigator.gpu via an init script, which simulates a WebGPU-less
//    browser; createRendererAsync then skips the probe and constructs the
//    WebGL2 renderer. renderMode must still be 'webgl2' (or 'webgpu').
//    The underlying factory bug (probing WebGPU on the live canvas) is an
//    app defect outside this directory's scope.
//
// 2. Worker decode: the libde265 wasm worker path has two app-level
//    defects in this environment (see REPORT):
//      a. decoder.decode() can wedge natively (uninterruptible wasm spin,
//         Debugger.pause cannot interrupt it) on the first NAL chunk when
//         the worker script is served from an http:// origin; the same
//         code terminates in ~4ms in a blob worker or on the main thread.
//         The wedge produces NO worker error message, so the demo's
//         main-thread fallback never engages and framesDecoded stays 0.
//         This is nondeterministic (rare runs reach flush).
//      b. When the worker does reach flush, VideoFrame.copyTo() with an
//         explicit non-RGB format throws in dedicated workers ("copyTo()
//         doesn't support explicit copy to non-RGB formats"), which posts a
//         DECODE error and crashes on null.close() instead of delivering
//         frames.
//    Because of (a), the first attempt may time out with 0 frames and 0
//    errors; per the plan this test retries once after a page reload before
//    failing, and any failure message carries the live __vigilkit.hevc
//    state plus the captured console/pageerror log. The assertions are NOT
//    weakened: framesDecoded > 0 and errors === 0 must still hold.
//
// window.__vigilkit surface used here (note: player stays null in hevc mode):
//   hevc       -> { framesDecoded: number, errors: number }
//   renderMode -> 'webgl2' | 'webgpu' | null
//
// FIREFOX PROJECT: this is the primary target for HEVC soft-decode (libde265
// WASM). Firefox 130+ ships WebCodecs VideoFrame, and the main-thread decode
// path (default in this spec) builds an I420 VideoFrame from the libde265
// planes. If a firefox build cannot construct an I420 VideoFrame with an
// explicit layout (the construction probe below throws), the test skips
// gracefully with a documented reason instead of failing. The probe runs a
// real 4x2 I420 construction; the skip engages ONLY when construction fails.
// renderMode on firefox also allows 'canvas2d' (headless WebGL2 unreliable).

import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeWebCodecs } from './probes.js';

interface HevcStatsShape {
  framesDecoded: number;
  errors: number;
}

interface VigilkitApi {
  hevc?: HevcStatsShape;
  renderMode?: string;
}

const ARTIFACTS_DIR = path.join(process.cwd(), 'e2e', 'artifacts');
const HEVC_URL = 'http://localhost:8090/?source=hevc';

/**
 * Runtime probe: can this browser construct an I420 VideoFrame with an
 * explicit plane layout? The libde265 main-thread path relies on exactly
 * this construction, so a negative result means the soft-decode path cannot
 * deliver frames in this build and the spec must skip (firefox only).
 */
async function probeVideoFrameI420(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    try {
      const frame = new VideoFrame(new Uint8Array(16), {
        format: 'I420',
        codedWidth: 4,
        codedHeight: 2,
        timestamp: 0,
        layout: [
          { offset: 0, stride: 4 }, // Y plane: 4x2 = 8 bytes (offsets 0..7)
          { offset: 8, stride: 2 }, // U plane: 2x1 = 2 bytes (offsets 8..9)
          { offset: 10, stride: 2 }, // V plane: 2x1 = 2 bytes (offsets 10..11)
        ],
      });
      frame.close();
      return true;
    } catch {
      return false;
    }
  });
}

/** evaluate()/waitForFunction() callbacks are serialized: no outer value closures, only types. */
type WindowWithVigilkit = Window & { __vigilkit: VigilkitApi };

/** Simulates a WebGPU-less browser (see ENVIRONMENT NOTES above). */
const HIDE_WEBGPU = () => {
  Object.defineProperty(Navigator.prototype, 'gpu', {
    configurable: true,
    get() {
      return undefined;
    },
  });
};

async function readHevcState(page: Page): Promise<HevcStatsShape | null> {
  return page.evaluate(() => {
    const api = (window as unknown as WindowWithVigilkit).__vigilkit;
    if (api === undefined) {
      return null;
    }
    return api.hevc ?? null;
  });
}

async function readRenderMode(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const api = (window as unknown as WindowWithVigilkit).__vigilkit;
    return api.renderMode ?? null;
  });
}

/**
 * In non-FLV demo modes main.ts awaits createRendererAsync (WebGPU probe
 * first — which logs "No available adapters." in headless — then WebGL2)
 * BEFORE defining window.__vigilkit. Poll until the surface exists instead
 * of assuming it is present right after goto().
 */
async function waitForVigilkit(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (window as unknown as WindowWithVigilkit).__vigilkit;
      return api !== undefined;
    },
    undefined,
    { timeout: timeoutMs },
  );
}

interface AttemptResult {
  ok: boolean;
  /** Set when the decode wait failed (worker flakiness); assertions did not run. */
  decodeFailed: boolean;
  state: HevcStatsShape | null;
  renderMode: string | null;
  error: Error | null;
}

async function runAttempt(
  page: Page,
  consoleLines: string[],
  pageErrors: string[],
): Promise<AttemptResult> {
  consoleLines.length = 0;
  pageErrors.length = 0;
  await page.goto(HEVC_URL);
  await expect(page.locator('#screen')).toBeVisible();
  await waitForVigilkit(page, 30_000);
  await page.click('#connect');

  // Worker init + libde265 wasm fetch + decode. If this times out with 0
  // frames and no errors, the wedge is the known app defect (a) — the caller
  // retries once, and the failure message carries the hevc state + console.
  try {
    await page.waitForFunction(
      () => {
        const api = (window as unknown as WindowWithVigilkit).__vigilkit;
        const hevc = api?.hevc;
        return hevc !== undefined && hevc.framesDecoded > 0;
      },
      undefined,
      { timeout: 60_000 },
    );
  } catch (error) {
    return {
      ok: false,
      decodeFailed: true,
      state: await readHevcState(page).catch(() => null),
      renderMode: await readRenderMode(page).catch(() => null),
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  return {
    ok: true,
    decodeFailed: false,
    state: await readHevcState(page).catch(() => null),
    renderMode: await readRenderMode(page).catch(() => null),
    error: null,
  };
}

test('soft-decodes HEVC via libde265 worker and renders frames', async ({ page }, testInfo) => {
  // worker init + wasm fetch + sha256 pin + decode can take several seconds;
  // the spec grants 60s for framesDecoded > 0, so the test needs headroom
  // beyond the 60s config timeout (plus one reload retry).
  test.setTimeout(180_000);
  const project = testInfo.project.name;
  // Headless Firefox/WebKit: no WebGPU, unreliable WebGL2 -> canvas2d fallback.
  const allowedRenderModes =
    project !== 'chromium' ? ['webgl2', 'webgpu', 'canvas2d'] : ['webgl2', 'webgpu'];

  // Conditional, project-scoped skip: only chromium can always rely on I420
  // VideoFrame; firefox/webkit may lack it. The probe constructs a real I420
  // frame, so the skip engages ONLY when the soft-decode path's frame
  // delivery cannot work in this build. If the probe passes, the spec runs
  // in full (no unnecessary skip).
  test.skip(
    project !== 'chromium' && !(await probeVideoFrameI420(page)),
    'HEVC VideoFrame I420 construction unsupported in this firefox/webkit build',
  );

  // Windows Playwright WebKit builds historically lack WebCodecs entirely,
  // while macOS Safari 16.4+ has it — CI runs the webkit project on macOS.
  const webcodecs = await probeWebCodecs(page);
  test.skip(
    project === 'webkit' && !webcodecs,
    'WebCodecs unavailable in this webkit build (Safari e2e runs on macOS)',
  );

  await page.addInitScript(HIDE_WEBGPU);
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(`PAGEERROR: ${err.message}`));

  let result = await runAttempt(page, consoleLines, pageErrors);

  // Documented fallback (plan): worker/import issues in headless are flaky —
  // retry once after a page reload. Assertions are unchanged; this only
  // gives the worker path a second chance to reach decode.
  try {
    if (!result.ok && result.decodeFailed && result.state?.framesDecoded === 0) {
      console.log('e2e: hevc first attempt produced 0 frames; retrying once after reload');
      const attempt1Console = [...consoleLines, ...pageErrors].join('\n');
      const attempt1State = result.state;
      result = await runAttempt(page, consoleLines, pageErrors);
      if (!result.ok) {
        const hevcNow = result.state;
        const modeNow = result.renderMode;
        throw new Error(
          `HEVC demo produced 0 frames after reload retry.\n` +
            `attempt 1 __vigilkit.hevc: ${JSON.stringify(attempt1State)}\n` +
            `attempt 2 __vigilkit.hevc: ${JSON.stringify(hevcNow)}\n` +
            `renderMode: ${String(modeNow)} (worker-fallback engages via console warn "[vigilkit] hevc worker path failed; falling back to main-thread decode")\n` +
            `attempt 1 console:\n${attempt1Console}\n` +
            `attempt 2 console:\n${[...consoleLines, ...pageErrors].join('\n')}\n` +
            `decode wait error: ${result.error?.message ?? String(result.error)}`,
        );
      }
    } else if (!result.ok) {
      // Non-retryable failure: worker surfaced an error (e.g. copyTo DECODE
      // error) or assertions-level diagnostics are needed.
      const hevcNow = result.state;
      const modeNow = result.renderMode;
      throw new Error(
        `HEVC demo failed (no retry: decodeFailed=${String(result.decodeFailed)}).\n` +
          `__vigilkit.hevc at failure: ${JSON.stringify(hevcNow)}\n` +
          `renderMode: ${String(modeNow)}\n` +
          `console:\n${[...consoleLines, ...pageErrors].join('\n')}\n` +
          `error: ${result.error?.message ?? String(result.error)}`,
      );
    }

    const hevc = result.state;
    expect(hevc, 'window.__vigilkit.hevc is undefined').not.toBeNull();
    expect(hevc?.framesDecoded, `hevc stats: ${JSON.stringify(hevc)}`).toBeGreaterThan(0);
    expect(hevc?.errors, `hevc errors: ${JSON.stringify(hevc)}`).toBe(0);

    const renderMode = result.renderMode;
    expect(allowedRenderModes, `renderMode: ${String(renderMode)}`).toContain(renderMode);
  } finally {
    // Artifacts are written on success AND failure so a red run stays
    // diagnosable (console.log + stats.json + a UI screenshot).
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    try {
      await writeFile(
        path.join(ARTIFACTS_DIR, 'hevc-console.log'),
        [...consoleLines, ...pageErrors].join('\n') + '\n',
        'utf8',
      );
    } catch (error) {
      console.warn(`e2e: failed to write hevc-console.log: ${String(error)}`);
    }
    try {
      const hevcStats = result.state ?? (await readHevcState(page));
      const mode = result.renderMode ?? (await readRenderMode(page));
      await writeFile(
        path.join(ARTIFACTS_DIR, 'hevc-stats.json'),
        JSON.stringify(
          {
            framesDecoded: hevcStats?.framesDecoded ?? null,
            errors: hevcStats?.errors ?? null,
            renderMode: mode,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    } catch (error) {
      console.warn(`e2e: failed to write hevc-stats.json: ${String(error)}`);
    }
    try {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'hevc-page.png'), fullPage: true });
    } catch (error) {
      console.warn(`e2e: failed to write hevc-page.png: ${String(error)}`);
    }
  }
});

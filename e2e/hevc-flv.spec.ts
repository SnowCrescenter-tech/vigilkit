// End-to-end browser QA for the vigilkit engine-level HEVC path over WS-FLV.
//
// ?source=hevc-flv runs the FULL engine pipeline: WS transport plugin ->
// FLV demuxer (Enhanced-RTMP HEVC, codecId 12) -> CodecRoutingDecoder ->
// renderer, all inside createPlayer (no demo bypass). The FLV demuxer emits
// an hvcC sequence header (codec hvc1.4.10.L123.6D.08) plus 4-byte
// length-prefixed video chunks (see flv-demuxer-hevc.test.ts). The routing
// decoder uses WebCodecs when the browser supports hvc1 (chromium), and
// otherwise — always on Firefox — the libde265 soft decoder, which converts
// the length-prefixed chunks to Annex-B before pushing them to libde265.
//
// The server streams examples/basic/hevc-fixtures/flv-hevc.flv at
// ws://<host>/live-hevc: the FLV header is sent once, then the tag body is
// replayed in a loop (the fixture's ~10 frames per pass repeat their
// timestamps, and the engine's 1 s lateness budget bounds how many passes
// decode, so the server paces passes at 20 ms to keep the decoded total well
// above the 30-frame floor).
//
// window.__vigilkit surface used here:
//   player.getStats() -> { state, framesDecoded, framesDropped, fps, errors }
//   renderMode       -> 'webgl2' | 'webgpu' | 'canvas2d'
//
// ENVIRONMENT NOTE (headless chromium): for non-FLV modes main.ts awaits
// createRendererAsync, which probes WebGPU FIRST via canvas.getContext
// ('webgpu'). In headless chromium the webgpu context creation succeeds but
// requestAdapter() finds no adapter, and the canvas is then permanently
// locked to webgpu mode — the WebGL2/Canvas2D fallbacks return null and
// window.__vigilkit never appears. The test therefore hides navigator.gpu
// via an init script (see hls.spec.ts for the full writeup).
//
// FIREFOX PROJECT: no HEVC WebCodecs at all, so this is the key soft-decode
// proof: length-prefixed chunks -> Annex-B -> libde265 -> VideoFrame ->
// renderer. Headless Firefox has no WebGPU and unreliable WebGL2, so
// 'canvas2d' is allowed alongside 'webgl2' / 'webgpu'.

import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeWebCodecs } from './probes.js';

interface PlayerStatsShape {
  state: string;
  framesDecoded: number;
  framesDropped: number;
  fps: number;
  errors: Array<{ code: string; message: string }>;
}

interface VigilkitApi {
  player: { getStats(): PlayerStatsShape } | null;
  renderMode?: string;
}

const ARTIFACTS_DIR = path.join(process.cwd(), 'e2e', 'artifacts');
const HEVC_FLV_URL = 'http://localhost:8090/?source=hevc-flv';

/** evaluate()/waitForFunction() callbacks are serialized: no outer value closures, only types. */
type WindowWithVigilkit = Window & { __vigilkit: VigilkitApi };

/** Simulates a WebGPU-less browser (see ENVIRONMENT NOTE above). */
const HIDE_WEBGPU = () => {
  Object.defineProperty(Navigator.prototype, 'gpu', {
    configurable: true,
    get() {
      return undefined;
    },
  });
};

async function readStats(page: Page): Promise<PlayerStatsShape> {
  return page.evaluate(() => {
    const api = (window as unknown as WindowWithVigilkit).__vigilkit;
    if (api === undefined) {
      throw new Error('window.__vigilkit is undefined (app boot not complete)');
    }
    const player = api.player;
    if (player === null) {
      throw new Error('__vigilkit.player is null');
    }
    return player.getStats();
  });
}

/**
 * In non-FLV demo modes main.ts awaits createRendererAsync (WebGPU probe
 * first) BEFORE defining window.__vigilkit. Poll until the surface exists
 * instead of assuming it is present right after goto().
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

async function readRenderMode(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const api = (window as unknown as WindowWithVigilkit).__vigilkit;
    return api.renderMode ?? null;
  });
}

/**
 * Waits for the player to reach `playing`. Resolves early if the player
 * surfaces `error` so the caller can capture stats.errors and fail with a
 * diagnostic message instead of a bare timeout.
 */
async function waitForPlayingOrError(page: Page, timeoutMs: number): Promise<'playing' | 'error'> {
  const state = await page.waitForFunction(
    () => {
      const api = (window as unknown as WindowWithVigilkit).__vigilkit;
      const player = api?.player ?? null;
      if (player === null) {
        return null;
      }
      const state = player.getStats().state;
      return state === 'playing' || state === 'error' ? state : null;
    },
    undefined,
    { timeout: timeoutMs },
  );
  const value = await state.jsonValue();
  if (value !== 'playing' && value !== 'error') {
    throw new Error(`unexpected waitForPlayingOrError result: ${String(value)}`);
  }
  return value;
}

/** Waits until at least `count` frames have been decoded. */
async function waitForDecodeCount(page: Page, count: number, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (min) => {
      const api = (window as unknown as WindowWithVigilkit).__vigilkit;
      const player = api?.player ?? null;
      return player !== null && player.getStats().framesDecoded >= min;
    },
    count,
    { timeout: timeoutMs },
  );
}

test('plays HEVC end-to-end through createPlayer over WS-FLV', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const project = testInfo.project.name;
  // Headless Firefox/WebKit: no WebGPU, unreliable WebGL2 -> canvas2d fallback.
  const allowedRenderModes =
    project !== 'chromium' ? ['webgl2', 'webgpu', 'canvas2d'] : ['webgl2', 'webgpu'];

  await page.addInitScript(HIDE_WEBGPU);
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(`PAGEERROR: ${err.message}`));

  let lastStats: PlayerStatsShape | null = null;
  let renderMode: string | null = null;
  try {
    await page.goto(HEVC_FLV_URL);
    await expect(page.locator('#screen')).toBeVisible();

    // Windows Playwright WebKit builds historically lack WebCodecs entirely,
    // while macOS Safari 16.4+ has it — CI runs the webkit project on macOS.
    const webcodecs = await probeWebCodecs(page);
    test.skip(
      project === 'webkit' && !webcodecs,
      'WebCodecs unavailable in this webkit build (Safari e2e runs on macOS)',
    );

    await waitForVigilkit(page, 30_000);
    await page.click('#connect');

    const state = await waitForPlayingOrError(page, 30_000);
    if (state === 'error') {
      const stats = await readStats(page);
      lastStats = stats;
      throw new Error(
        `hevc-flv player reached 'error' state; stats.errors: ${JSON.stringify(stats.errors)}` +
          `\nconsole:\n${[...consoleLines, ...pageErrors].join('\n')}`,
      );
    }

    // Engine-level proof: >= 30 decoded HEVC frames within 60 s. The WS
    // stream loops the fixture's tag body; several passes decode before the
    // scheduler's lateness budget starts dropping the repeated timestamps.
    await waitForDecodeCount(page, 30, 60_000);

    const stats = await readStats(page);
    lastStats = stats;
    expect(
      stats.framesDecoded,
      `hevc-flv player stats: ${JSON.stringify(stats)}`,
    ).toBeGreaterThanOrEqual(30);
    expect(stats.errors.length, `player errors: ${JSON.stringify(stats.errors)}`).toBe(0);

    renderMode = await readRenderMode(page);
    expect(allowedRenderModes, `renderMode: ${String(renderMode)}`).toContain(renderMode);
    console.log(
      `e2e: hevc-flv [${project}] framesDecoded=${stats.framesDecoded} errors=${stats.errors.length} renderMode=${String(renderMode)}`,
    );
  } finally {
    // Artifacts are written on success AND failure so a red run stays
    // diagnosable (console.log + stats.json + a UI screenshot).
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    try {
      await writeFile(
        path.join(ARTIFACTS_DIR, 'hevc-flv-console.log'),
        [...consoleLines, ...pageErrors].join('\n') + '\n',
        'utf8',
      );
    } catch (error) {
      console.warn(`e2e: failed to write hevc-flv-console.log: ${String(error)}`);
    }
    try {
      const snapshot = lastStats ?? (await readStats(page));
      const mode = renderMode ?? (await readRenderMode(page));
      await writeFile(
        path.join(ARTIFACTS_DIR, 'hevc-flv-stats.json'),
        JSON.stringify(
          {
            project,
            state: snapshot.state,
            framesDecoded: snapshot.framesDecoded,
            framesDropped: snapshot.framesDropped,
            fps: snapshot.fps,
            errors: snapshot.errors,
            renderMode: mode,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    } catch (error) {
      console.warn(`e2e: failed to write hevc-flv-stats.json: ${String(error)}`);
    }
    try {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'hevc-flv-page.png'), fullPage: true });
    } catch (error) {
      console.warn(`e2e: failed to write hevc-flv-page.png: ${String(error)}`);
    }
  }
});

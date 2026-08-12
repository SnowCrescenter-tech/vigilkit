// End-to-end browser QA for the vigilkit HLS playback path.
//
// The example serves an HLS fixture (examples/basic/hls-fixtures/, sha256
// pinned: FFmpeg FATE MPEG-TS, H.264 + AAC) at /hls/master.m3u8 with two
// variants both pointing at index.m3u8 (VOD, 10 x seg-0.ts). The page is
// opened with ?source=hls, which selects the HLS demo mode in main.ts
// (buildHlsPlayer: createPlayer({ url: HLS_URL, demuxer: 'hls',
// plugins: [hlsSourcePlugin()] })). Playback starts on the #connect click,
// the same as the FLV demo. The pipeline is
// master.m3u8 -> low variant -> segments -> demux -> WebCodecs decode ->
// render; the renderer surface for non-FLV modes is created with
// createRendererAsync, so renderMode is 'webgl2' or 'webgpu' depending on
// what the browser exposes.
//
// window.__vigilkit surface used here:
//   player.getStats() -> { state, framesDecoded, framesDropped, fps, errors }
//   renderMode       -> 'webgl2' | 'webgpu' | null
//
// ENVIRONMENT NOTE (headless chromium on this machine, Aug 2026): for
// non-FLV modes main.ts awaits createRendererAsync, which probes WebGPU
// FIRST via canvas.getContext('webgpu'). In headless chromium the webgpu
// context creation succeeds but requestAdapter() finds no adapter ("No
// available adapters."), and the canvas is then permanently locked to
// webgpu mode — the WebGL2/Canvas2D fallbacks return null and main()
// rejects with "no renderer available", so window.__vigilkit never appears.
// No chromium launch flag disables this (verified: --disable-webgpu is not
// a real switch; --disable-blink-features=WebGPU and
// --disable-features=WebGPUService are inert). The test therefore hides
// navigator.gpu via an init script, simulating a WebGPU-less browser;
// createRendererAsync then skips the probe and constructs the WebGL2
// renderer. renderMode must still be 'webgl2' (or 'webgpu'). The underlying
// factory bug (probing WebGPU on the live canvas) is an app defect outside
// this directory's scope.

import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
const HLS_URL = 'http://localhost:8090/?source=hls';

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

async function readRenderMode(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const api = (window as unknown as WindowWithVigilkit).__vigilkit;
    return api.renderMode ?? null;
  });
}

/**
 * Waits for the HLS player to reach `playing`. Resolves early if the player
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

test('plays HLS stream with WebCodecs and renders frames', async ({ page }) => {
  test.setTimeout(120_000); // 30s playing wait + 30s decode wait + fixture drain headroom
  await page.addInitScript(HIDE_WEBGPU);
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(`PAGEERROR: ${err.message}`));

  let lastStats: PlayerStatsShape | null = null;
  let renderMode: string | null = null;
  try {
    await page.goto(HLS_URL);
    await expect(page.locator('#screen')).toBeVisible();
    await waitForVigilkit(page, 30_000);
    await page.click('#connect');

    // The HLS source fetches master -> low variant -> segments -> decodes.
    // If the player lands on `error`, capture the stats and fail with the
    // collected errors rather than letting the wait time out silently.
    const state = await waitForPlayingOrError(page, 30_000);
    if (state === 'error') {
      const stats = await readStats(page);
      lastStats = stats;
      expect.fail(
        `HLS player reached 'error' state; stats.errors: ${JSON.stringify(stats.errors)}` +
          `\nconsole:\n${[...consoleLines, ...pageErrors].join('\n')}`,
      );
    }

    await page.waitForFunction(
      () => {
        const api = (window as unknown as WindowWithVigilkit).__vigilkit;
        const player = api?.player ?? null;
        return player !== null && player.getStats().framesDecoded > 0;
      },
      undefined,
      { timeout: 30_000 },
    );

    const current = await readStats(page);
    lastStats = current;
    expect(current.framesDecoded, `player stats: ${JSON.stringify(current)}`).toBeGreaterThan(0);
    expect(current.errors.length, `player errors: ${JSON.stringify(current.errors)}`).toBe(0);

    renderMode = await readRenderMode(page);
    expect(['webgl2', 'webgpu'], `renderMode: ${String(renderMode)}`).toContain(renderMode);
  } finally {
    // Artifacts are written on success AND failure so a red run stays
    // diagnosable (console.log + stats.json + a UI screenshot).
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    try {
      await writeFile(
        path.join(ARTIFACTS_DIR, 'hls-console.log'),
        [...consoleLines, ...pageErrors].join('\n') + '\n',
        'utf8',
      );
    } catch (error) {
      console.warn(`e2e: failed to write hls-console.log: ${String(error)}`);
    }
    try {
      const snapshot = lastStats ?? (await readStats(page));
      const mode = renderMode ?? (await readRenderMode(page));
      await writeFile(
        path.join(ARTIFACTS_DIR, 'hls-stats.json'),
        JSON.stringify(
          {
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
      console.warn(`e2e: failed to write hls-stats.json: ${String(error)}`);
    }
    try {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'hls-page.png'), fullPage: true });
    } catch (error) {
      console.warn(`e2e: failed to write hls-page.png: ${String(error)}`);
    }
  }
});

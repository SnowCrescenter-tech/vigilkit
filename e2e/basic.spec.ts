// End-to-end browser QA for the vigilkit basic example app.
//
// The example (examples/basic) serves a vite-built page + a Node server that
// streams the bundled FLV fixture over WS at ws://<host>/live in paced 64 KiB
// chunks. The page exposes window.__vigilkit = { player, supports } where
// player.getStats() returns { state, framesDecoded, framesDropped, fps,
// errors }.
//
// KNOWN DEFECT (found by this suite, Aug 2026): the player cannot decode in
// real Chromium. @vigilkit/plugin-flv feeds the WebCodecs VideoDecoder a full
// avcC record as `description` (which declares AVCC / length-prefixed chunk
// format for the `avc1` codec) but converts every NALU packet to Annex-B
// (naluToAnnexB in packages/plugins/flv/src/flv-demuxer.ts). Chrome 151
// rejects the mismatch with "Unable to determine size of bitstream buffer."
// Verified with an isolated decoder experiment: avcC description + AVCC
// chunks decodes fine; avcC description + Annex-B chunks fails identically.
// Fix (outside this directory's scope): keep length-prefixed NALUs when
// providing the avcC description, or drop `description` and stay Annex-B.
// Until then Test 1 is expected-red by design; it still captures full
// diagnostic artifacts (console.log, stats.json, basic.png) on the failure
// path.
//
// FIXTURE / PACING NOTE: the fixture is a ~11.6 s cut (352 video frames,
// 426x240 @ 30 fps) of a 512 KiB FLV. The server ships the whole file in 8 x
// 64 KiB chunks (~320 ms), so once decoding works the player drains the clip
// in a burst and plateaus at ~352 frames. A literal "delta >= 30 over a 6 s
// window" can therefore never hold; the decode-rate bound is asserted over a
// 1 s window taken during the active decode burst, and the ">= 30 frames"
// safe bound is asserted against the full clip total within a 6 s window
// (the fixture decodes ~352 frames, so this is a 10x margin).

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
  supports: { webcodecs: boolean };
  renderMode?: string;
}

const ARTIFACTS_DIR = path.join(process.cwd(), 'e2e', 'artifacts');
const BASE_URL = 'http://localhost:8090/';

/** evaluate()/waitForFunction() callbacks are serialized: no outer value closures, only types. */
type WindowWithVigilkit = Window & { __vigilkit: VigilkitApi };

async function readStats(page: Page): Promise<PlayerStatsShape> {
  return page.evaluate(() => {
    const api = (window as unknown as WindowWithVigilkit).__vigilkit;
    const player = api.player;
    if (player === null) {
      throw new Error('__vigilkit.player is null');
    }
    return player.getStats();
  });
}

async function waitForPlayerState(page: Page, state: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const api = (window as unknown as WindowWithVigilkit).__vigilkit;
      const player = api.player;
      return player !== null && player.getStats().state === expected;
    },
    state,
    { timeout: timeoutMs },
  );
}

/** Resolves when decoding starts OR the player surfaces its first error. */
async function waitForDecodeOrError(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (window as unknown as WindowWithVigilkit).__vigilkit;
      const player = api.player;
      if (player === null) {
        return false;
      }
      const stats = player.getStats();
      return stats.framesDecoded > 0 || stats.errors.length > 0;
    },
    undefined,
    { timeout: timeoutMs },
  );
}

async function canvasSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#screen');
    if (!(canvas instanceof HTMLCanvasElement)) {
      return { width: 0, height: 0 };
    }
    return { width: canvas.width, height: canvas.height };
  });
}

test('plays WS-FLV stream with WebCodecs and renders frames', async ({ page }) => {
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(`PAGEERROR: ${err.message}`));

  let lastStats: PlayerStatsShape | null = null;
  try {
    await page.goto(BASE_URL);
    await expect(page.locator('#screen')).toBeVisible();

    const webcodecs = await page.evaluate(() => {
      const api = (window as unknown as WindowWithVigilkit).__vigilkit;
      return api.supports.webcodecs;
    });
    expect(webcodecs).toBe(true);

    await page.click('#connect');
    await waitForPlayerState(page, 'playing', 20000);

    const renderMode = await page.evaluate(() => {
      const api = (window as unknown as WindowWithVigilkit).__vigilkit;
      return api.renderMode ?? null;
    });
    expect(['webgl2', 'webgpu'], `renderMode: ${String(renderMode)}`).toContain(renderMode);

    await waitForDecodeOrError(page, 20000);

    const current = await readStats(page);
    lastStats = current;
    expect(current.framesDecoded, `player stats: ${JSON.stringify(current)}`).toBeGreaterThan(0);

    // Decode-rate evidence: sample during the active decode burst. The clip
    // decodes to completion in a burst (~1-2 s), so a 1 s window taken from
    // the moment decoding starts must still see >= 20 frames (plan's floor;
    // the fixture typically yields a few hundred).
    const first = await readStats(page);
    await page.waitForTimeout(1000);
    const second = await readStats(page);
    lastStats = second;
    expect(second.framesDecoded - first.framesDecoded).toBeGreaterThanOrEqual(20);
    expect(second.fps).toBeGreaterThanOrEqual(4);

    // Full-clip evidence: within the plan's 6 s window the player must have
    // decoded at least 30 frames total (the whole ~352-frame fixture lands in
    // this window; 30 is the plan's "to be safe" floor with a 10x margin).
    await page.waitForTimeout(5000);
    const final = await readStats(page);
    lastStats = final;
    expect(final.framesDecoded).toBeGreaterThanOrEqual(30);
    expect(final.errors.length, `player errors: ${JSON.stringify(final.errors)}`).toBe(0);

    const size = await canvasSize(page);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  } finally {
    // Artifacts are written on success AND failure so a red run stays
    // diagnosable (console.log + stats.json + a UI screenshot).
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    try {
      await writeFile(
        path.join(ARTIFACTS_DIR, 'console.log'),
        [...consoleLines, ...pageErrors].join('\n') + '\n',
        'utf8',
      );
    } catch (error) {
      console.warn(`e2e: failed to write console.log: ${String(error)}`);
    }
    try {
      const snapshot = lastStats ?? (await readStats(page));
      const renderMode = await page.evaluate(() => {
        const api = (window as unknown as WindowWithVigilkit).__vigilkit;
        return api.renderMode ?? null;
      });
      await writeFile(
        path.join(ARTIFACTS_DIR, 'stats.json'),
        JSON.stringify(
          {
            state: snapshot.state,
            framesDecoded: snapshot.framesDecoded,
            framesDropped: snapshot.framesDropped,
            fps: snapshot.fps,
            errors: snapshot.errors,
            renderMode,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    } catch (error) {
      console.warn(`e2e: failed to write stats.json: ${String(error)}`);
    }
    try {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'basic.png'), fullPage: true });
    } catch (error) {
      console.warn(`e2e: failed to write basic.png: ${String(error)}`);
    }
  }
});

test('tears down cleanly on disconnect (stopped state, no further decode)', async ({ page }) => {
  // NOTE: this test deliberately does not gate on framesDecoded > 0 or
  // errors.length === 0: the open Annex-B/AVCC decoder defect makes the
  // player surface a DECODE error while the WS lifecycle itself is intact.
  // This test locks the transport/teardown surface, which works today.
  await page.goto(BASE_URL);
  await page.click('#connect');
  await waitForPlayerState(page, 'playing', 20000);

  const readFrameCount = async (): Promise<number> => {
    const text = await page.locator('#frames').textContent();
    const match = /^(\d+)/.exec(text ?? '');
    if (match === null) {
      throw new Error(`cannot parse #frames counter: "${String(text)}"`);
    }
    return Number(match[1]);
  };

  const beforeDisconnect = await readFrameCount();
  await page.click('#disconnect');
  await expect(page.locator('#status')).toHaveText('stopped / 已断开');

  const afterDisconnect = await readFrameCount();
  await page.waitForTimeout(500);
  expect(await readFrameCount()).toBe(afterDisconnect);
  expect(afterDisconnect).toBe(beforeDisconnect);
});

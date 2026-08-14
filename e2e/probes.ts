// Shared e2e capability probes. Each spec is self-contained, but these two
// probes are used by several engine-dependent specs, so they live here to
// stay DRY.
import type { Page } from '@playwright/test';

/** Window surface published by the example app (see main.ts). */
interface VigilkitApi {
  player: unknown;
  supports?: { webcodecs?: boolean };
  renderMode?: string | null;
  multiview?: unknown;
  hevc?: unknown;
  [key: string]: unknown;
}

type WindowWithVigilkit = Window & { __vigilkit?: VigilkitApi };

/**
 * Probes whether the running engine has WebCodecs available. Returns false
 * when the browser build lacks `VideoDecoder`/`VideoEncoder` entirely.
 * Playwright's WebKit build on Windows historically lacks WebCodecs, while
 * macOS Safari 16.4+ has it — so engine-dependent specs skip (not fail) on
 * webkit when this probe is false, and CI runs the webkit project on macOS
 * where it is true.
 */
export async function probeWebCodecs(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const api = (window as unknown as WindowWithVigilkit).__vigilkit;
    if (api?.supports?.webcodecs !== undefined) return api.supports.webcodecs;
    return typeof VideoDecoder !== 'undefined';
  });
}

/** Reads the engine's `supports.webcodecs` flag from the demo page. */
export async function webcodecsSupported(page: Page): Promise<boolean> {
  return probeWebCodecs(page);
}

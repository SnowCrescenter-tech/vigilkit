import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60000,
  outputDir: 'artifacts',
  use: { headless: true, viewport: { width: 960, height: 640 } },
  // Two projects: chromium (baseline) and firefox. Each spec reads
  // testInfo.project.name ('chromium' | 'firefox') to apply project-aware
  // bounds: headless Firefox has unreliable WebGL2 (falls back to canvas2d)
  // and slower software rendering, and its WebCodecs H.264 decode is
  // functional but looser-bounded in e2e. Both projects share the same
  // webServer (the FLV/HLS/HEVC fixture server on :8090).
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  webServer: {
    // --loop keeps the WS /live stream repeating: the FLV fixture (11.6 s,
    // ~352 frames) otherwise closes the socket after one pass, and the
    // engine's clean-close -> stopped transition can cut a decode burst short
    // under e2e concurrency. Looping gives decode-rate assertions a steady
    // stream regardless of timing.
    command: 'pnpm --filter @vigilkit/example-basic serve --port 8090 --loop',
    url: 'http://localhost:8090/healthz',
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [['list']],
});

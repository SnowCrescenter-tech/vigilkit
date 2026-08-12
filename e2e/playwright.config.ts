import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60000,
  outputDir: 'artifacts',
  use: { headless: true, viewport: { width: 960, height: 640 } },
  webServer: {
    command: 'pnpm --filter @vigilkit/example-basic serve --port 8090',
    url: 'http://localhost:8090/healthz',
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [['list']],
});

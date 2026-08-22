import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for WrongStack WebUI.
 *
 * Tests run against the actual WebUI server (startWebUI from server/index.ts).
 * The server is started per-test-suite using a global setup that launches
 * the CLI in webui mode, waits for the HTTP port to be ready, then passes
 * the base URL to all tests.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // Serial execution — every worker talks to the ONE WebUI server spawned
  // by global-setup (single port, single shared session env), and each
  // page load triggers a session replay that can be huge. Parallel workers
  // starve latency-sensitive WS round-trips (e.g. the files.tree fetch)
  // behind 12 concurrent replays, which is what rotted this suite before.
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: process.env.WEBUI_URL ?? 'http://127.0.0.1:3456',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

import { defineConfig, devices } from '@playwright/test'

// Browser e2e for the whole game: several players = several pages of ONE headless Chromium context, talking over the ?local
// (BroadcastChannel) transport against the built app served by `vite preview`. Electron smoke tests live in tests/electron
// (own config, `npm run test:electron:headless`) and are never picked up here.
const PORT = Number(process.env.GEOFINDER_E2E_PORT ?? 4391);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 4 * 60 * 1000,
  expect: { timeout: 15 * 1000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1400, height: 900 },
    headless: true,
    trace: 'off',
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false, // always rebuild: a stale dist/ would silently test old code
    timeout: 180 * 1000,
  },
});

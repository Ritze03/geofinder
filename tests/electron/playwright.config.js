import { defineConfig } from '@playwright/test'

// Electron smoke tests against the built renderer (run `vite build` first: npm run test:electron).
// They hit the real Google/Apple Maps sites, hence the generous timeouts.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
})

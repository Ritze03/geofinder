import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The whole app inside Electron: starts on the Profile screen and, once a game is running, the Play screen holds the REAL map panel
// (a <webview>, not the browser stub) whose capture goes through the preload IPC and reaches the other player as an image.
// Two windows of one app are the two players (?local transport over BroadcastChannel; GEOFINDER_QUERY / GEOFINDER_SECOND_QUERY).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let app, userData

test.beforeAll(() => { userData = fs.mkdtempSync(path.join(os.tmpdir(), 'geofinder-test-')) })
test.afterEach(async () => { await app?.close() })
test.afterAll(() => { fs.rmSync(userData, { recursive: true, force: true }) })

test('app starts on the Profile screen with the preload bridge', async () => {
  app = await electron.launch({ args: [repoRoot], env: { ...process.env, GEOFINDER_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.locator('[data-screen=profile]')).toBeVisible()
  expect(await page.title()).toBe('Geofinder')
  expect(await page.evaluate(() => typeof window.geofinder?.captureMap)).toBe('function')
  expect(await page.evaluate(() => !!window.mapPanel)).toBe(false) // the bare map test mode is off
})

test('two players: Electron uses the real map panel and a real capture reaches the other window', async () => {
  app = await electron.launch({
    args: [repoRoot],
    env: { ...process.env, GEOFINDER_USER_DATA: userData, GEOFINDER_QUERY: 'local&pid=h', GEOFINDER_SECOND_QUERY: 'local&pid=c1' },
  })
  await app.firstWindow()
  await expect.poll(() => app.windows().length).toBe(2)
  const host = app.windows().find((w) => w.url().includes('pid=h'))
  const guest = app.windows().find((w) => w.url().includes('pid=c1'))
  for (const p of [host, guest]) await expect(p.locator('[data-screen=profile]')).toBeVisible()

  await host.locator('#pf-name').fill('Hosty')
  await host.getByRole('button', { name: 'Create room' }).click()
  const code = (await host.locator('.invite code').textContent()).trim()
  await guest.locator('#pf-name').fill('Anna')
  await guest.locator('#pf-code').fill(code)
  await guest.getByRole('button', { name: 'Join room' }).click()
  for (const p of [host, guest]) {
    await expect(p.locator('[data-screen=lobby]')).toBeVisible()
    await p.getByRole('button', { name: /^Ready$/ }).click()
  }
  await host.getByRole('button', { name: 'Start game' }).click()
  for (const p of [host, guest]) await expect(p.locator('[data-screen=play]')).toBeVisible()

  // the real map panel: a <webview> inside .map-panel, and no browser stub
  for (const p of [host, guest]) {
    await expect(p.locator('.play-s .map .map-panel webview')).toHaveCount(1)
    await expect(p.locator('[data-stub-map]')).toHaveCount(0)
  }

  // capture the real webview (retry: it must be attached and past dom-ready first)
  const row = host.locator('li[data-id="cat1"]')
  await expect(async () => {
    await row.locator('.cap').click()
    await expect(row).toHaveClass(/done/, { timeout: 8_000 })
  }).toPass({ timeout: 90_000 })

  await guest.locator('li[data-id="cat1"] .oth button').click()
  const img = guest.locator('.modal:not([hidden]) figure img').first()
  await expect(img).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(300)
  expect(await img.evaluate((i) => i.naturalWidth)).toBeLessThanOrEqual(1280)
})

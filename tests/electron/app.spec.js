import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The whole app inside Electron: starts on the Profile screen and, once a game is running, the Play screen holds the REAL map panel
// (a <webview>, not the browser stub). A capture is that webview's URL: the other window must not see it during play (state url null)
// and loads exactly that URL in its review viewer afterwards. Two windows of one app are the two players (?local transport over
// BroadcastChannel; GEOFINDER_QUERY / GEOFINDER_SECOND_QUERY). Needs real internet; the Google consent is pre-seeded in electron/main.js.
const GOOGLE_MAPS = /^https:\/\/(www\.)?google\.[a-z.]+\/maps/
// Google normalises a loaded url (params, data blob); the @lat,lng,zoom prefix (or else the path) identifies the spot.
const BERLIN = 'https://www.google.com/maps/@52.5163,13.3777,17z'
const key = (u) => !u ? '' : u.match(/@-?[\d.]+,-?[\d.]+/)?.[0] ?? new URL(u).pathname

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
  expect(await page.evaluate(() => window.geofinder?.isElectron)).toBe(true)
  expect(await page.evaluate(() => !!window.mapPanel)).toBe(false) // the bare map test mode is off
})

test('two players: a real map url is submitted, hidden during play, and loaded in the other window\'s review viewer', async () => {
  test.setTimeout(360_000)
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
    await expect(p.locator('.play-s .map > .map-panel webview')).toHaveCount(1)
    await expect(p.locator('[data-stub-map]')).toHaveCount(0)
  }
  const hostId = await host.evaluate(() => window.__gf.identity.playerId)

  // submit what the real map shows (retry: the webview must be attached and past dom-ready first, else the app refuses with a toast)
  const playWebviewUrl = () => host.evaluate(() => { try { return document.querySelector('.play-s .map > .map-panel webview').getURL() } catch { return '' } })
  await expect.poll(playWebviewUrl, { timeout: 90_000 }).toMatch(GOOGLE_MAPS)
  // go somewhere else than Google's default start page (both windows start on the same IP-derived spot), so a viewer that shows
  // the right place is not just the guest's own start view
  await host.evaluate((u) => document.querySelector('.play-s .map > .map-panel webview').loadURL(u).catch(() => {}), BERLIN)
  await expect.poll(async () => key(await playWebviewUrl()), { timeout: 60_000 }).toBe(key(BERLIN))
  const row = host.locator('li[data-id="cat1"]')
  await expect(async () => {
    await row.locator('.cap').click()
    await expect(row).toHaveClass(/done/, { timeout: 8_000 })
  }).toPass({ timeout: 90_000 })
  const submitted = await host.evaluate((id) => window.__gf.getState().captures.cat1[id].url, hostId)
  expect(submitted).toMatch(GOOGLE_MAPS)
  expect(submitted).not.toMatch(/[?&](entry|g_ep)=/) // tracking params are stripped
  expect(key(submitted)).toBe(key(BERLIN))

  // NO PEEKING: the guest knows that the host submitted, but not where
  await expect.poll(() => guest.evaluate((id) => window.__gf.getState().captures.cat1?.[id] ?? null, hostId)).not.toBeNull()
  const seen = await guest.evaluate((id) => window.__gf.getState().captures.cat1[id], hostId)
  expect(seen.url).toBeNull()

  // everyone done -> 60 s countdown -> review
  await host.locator('.dbtn').click()
  await guest.locator('.dbtn').click()
  for (const p of [host, guest]) await expect(p.locator('[data-screen=review]')).toBeVisible({ timeout: 120_000 })

  // REVIEW: the guest's viewer (a mode-view webview) loads exactly the submitted spot (the host's card is auto-selected)
  const viewer = guest.locator('.rv-vbody webview')
  await expect(viewer).toHaveCount(1)
  const viewerUrl = () => guest.evaluate(() => { try { return document.querySelector('.rv-vbody webview').getURL() } catch { return '' } })
  const state = await guest.evaluate(() => window.__gf.getState())
  expect(state.captures.cat1[hostId].url, 'review state carries the url').toBe(submitted)
  await expect.poll(async () => key(await viewerUrl()), { timeout: 90_000 }).toBe(key(submitted))
  await expect(guest.locator('.rv-vbody webview')).toHaveCount(1)
})

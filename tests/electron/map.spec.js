import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GOOGLE_MAPS = /^https:\/\/(www\.)?google\.[a-z.]+\/maps/
const GOOGLE_OK = /^https:\/\/((www\.)?google\.[a-z.]+\/maps|consent\.google\.[a-z.]+\/)/

let app, page, userData

const viewUrl = () => page.evaluate(() => window.mapPanel.webview.getURL())
const inView = (code) => page.evaluate((c) => window.mapPanel.webview.executeJavaScript(c), code)

// Click Google's cookie consent through if it shows up, then wait for the map itself.
async function reachGoogleMaps() {
  await expect.poll(viewUrl, { timeout: 60_000 }).toMatch(GOOGLE_OK)
  if ((await viewUrl()).includes('consent.google.')) {
    await inView(`[...document.querySelectorAll('button, input[type=submit]')]
      .find((b) => /accept all|alle akzeptieren/i.test(b.innerText || b.value))?.click()`)
  }
  await expect.poll(viewUrl, { timeout: 60_000 }).toMatch(GOOGLE_MAPS)
}

// Width from the JPEG SOF marker.
function jpegWidth(bytes) {
  let i = 2
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue }
    const marker = bytes[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return (bytes[i + 7] << 8) | bytes[i + 8]
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3])
  }
  throw new Error('no SOF marker')
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // Throwaway profile: a consent cookie from real runs must not decide the outcome.
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'geofinder-test-'))
  app = await electron.launch({ args: [repoRoot], env: { ...process.env, GEOFINDER_USER_DATA: userData } })
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.mapPanel)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userData, { recursive: true, force: true })
})

test('window opens with Google Maps in the map panel', async () => {
  expect(await page.title()).toBe('Geofinder')
  await expect(page.locator('webview')).toHaveCount(1)
  await reachGoogleMaps()
})

test('navigation lock blocks other sites and new windows', async () => {
  const windowsBefore = app.windows().length
  const contentsBefore = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)

  await inView('location.href = "https://example.com"').catch(() => {})
  await inView('window.open("https://example.com")').catch(() => {})
  await inView('window.open("https://www.google.com/maps")').catch(() => {}) // even allowed URLs: no new windows
  await page.waitForTimeout(5000)

  expect(await viewUrl()).toMatch(GOOGLE_MAPS) // Google keeps pushState-ing its own URL, so match the site
  expect(app.windows().length).toBe(windowsBefore)
  expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(contentsBefore)
})

test('provider buttons switch between Apple Maps and Google Maps', async () => {
  await page.click('button[data-provider=apple]')
  await expect.poll(viewUrl, { timeout: 60_000 }).toMatch(/^https:\/\/maps\.apple\.com\//)
  await page.waitForTimeout(3000)
  expect(await inView('document.body.innerText.length')).toBeGreaterThan(0)

  await page.click('button[data-provider=google]')
  await expect.poll(viewUrl, { timeout: 60_000 }).toMatch(GOOGLE_OK)
  await reachGoogleMaps()
})

test('capture returns a JPEG of the map view', async () => {
  await page.waitForTimeout(3000) // let tiles paint
  const bytes = await page.evaluate(async () => {
    const blob = await window.mapPanel.capture()
    return { type: blob.type, data: Array.from(new Uint8Array(await blob.arrayBuffer())) }
  })
  const data = Uint8Array.from(bytes.data)
  expect(bytes.type).toBe('image/jpeg')
  expect([...data.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  expect(data.length).toBeGreaterThan(20_000)
  expect(jpegWidth(data)).toBeLessThanOrEqual(1280)
  expect(jpegWidth(data)).toBeGreaterThan(300)
})

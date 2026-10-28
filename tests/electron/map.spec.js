import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GOOGLE_MAPS = /^https:\/\/(www\.)?google\.[a-z.]+\/maps/
const GOOGLE_OK = /^https:\/\/((www\.)?google\.[a-z.]+\/maps|consent\.google\.[a-z.]+\/)/

let app, page, userData
const navLog = [] // main-process navigation log, printed when a test fails (a bare URL mismatch explains nothing)

const viewUrl = () => page.evaluate(() => window.mapPanel.webview.getURL())
const inView = (code) => page.evaluate((c) => window.mapPanel.webview.executeJavaScript(c), code)

// Wait for the map itself. A consent page should never show (SOCS cookie pre-seeded in electron/main.js, and mapPanel
// auto-rejects as a fallback); the click below is only a harmless safety net for a slow auto-reject.
async function reachGoogleMaps() {
  await expect.poll(viewUrl, { timeout: 60_000 }).toMatch(GOOGLE_OK)
  if ((await viewUrl()).includes('consent.google.')) {
    await inView(`[...document.querySelectorAll('button, input[type=submit]')]
      .find((b) => /accept all|alle akzeptieren/i.test(b.innerText || b.value))?.click()`)
  }
  await expect.poll(viewUrl, { timeout: 60_000 }).toMatch(GOOGLE_MAPS)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // Throwaway profile: a consent cookie from real runs must not decide the outcome.
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'geofinder-test-'))
  app = await electron.launch({
    args: [repoRoot],
    env: { ...process.env, GEOFINDER_USER_DATA: userData, GEOFINDER_DEBUG_NAV: '1', GEOFINDER_MAP_ONLY: '1' },
  })
  const t0 = Date.now()
  app.process().stdout.on('data', (d) =>
    String(d).split('\n').filter((l) => l.includes('[nav]')).forEach((l) => navLog.push(`+${Date.now() - t0}ms ${l}`)))
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.mapPanel)
  // Nothing but a click on a provider button may switch provider; record any, so a stray one is visible.
  await page.evaluate(() => {
    window.__providerClicks = []
    document.addEventListener('click', (e) => {
      const b = e.target.closest?.('button[data-provider]')
      if (b) window.__providerClicks.push(b.dataset.provider)
    }, true)
  })
})

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) console.log(`navigation log:\n${navLog.join('\n')}`)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userData, { recursive: true, force: true })
})

test('window opens with Google Maps in the map panel, without a consent page', async () => {
  expect(await page.title()).toBe('Geofinder')
  await expect(page.locator('webview')).toHaveCount(1)
  await reachGoogleMaps()
  // Fresh profile (EU users get consent.google.com first): the pre-seeded SOCS cookie must skip it entirely.
  expect(navLog.filter((l) => l.includes('consent.google.')), 'main-frame navigations to the consent page').toEqual([])
})

test('navigation lock blocks other sites and new windows', async () => {
  const windowsBefore = app.windows().length
  const contentsBefore = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)

  await inView('location.href = "https://example.com"').catch(() => {})
  await inView('window.open("https://example.com")').catch(() => {})
  await inView('window.open("https://www.google.com/maps")').catch(() => {}) // even allowed URLs: no new windows
  await page.waitForTimeout(5000)

  // Nothing here may switch provider; a physical click on the window while it runs would (and is not a bug).
  expect(await page.evaluate(() => window.__providerClicks), 'provider buttons clicked during the lock test').toEqual([])
  expect(await viewUrl()).toMatch(GOOGLE_MAPS) // Google keeps pushState-ing its own URL, so match the site
  expect(app.windows().length).toBe(windowsBefore)
  expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(contentsBefore)
})

test('load() ignores URLs outside the allowlist', async () => {
  const before = await viewUrl()
  await page.evaluate(() => window.mapPanel.load('https://example.com/'))
  await page.waitForTimeout(3000)
  expect(await viewUrl()).toBe(before)
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

// Berlin start points (src/map/translate.js START_URLS); the two views describe roughly the same area.
const BERLIN = { lat: 52.52, lng: 13.43 }
const GOOGLE_START = 'https://www.google.com/maps/@52.5192871,13.4148213,14942m/data=!3m1!1e3'
const APPLE_START = 'https://maps.apple.com/frame?center=52.517882%2C13.450507&span=0.350622%2C0.985401'
// Position of whatever the map shows now: Google /@lat,lng,..., Apple center= / ll= / coordinate=.
const urlPos = (u) => {
  const g = /\/@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(u)
  if (g) return { lat: Number(g[1]), lng: Number(g[2]) }
  const a = /[?&](?:center|ll|coordinate)=(-?\d+\.?\d*)(?:,|%2C)(-?\d+\.?\d*)/i.exec(u)
  return a ? { lat: Number(a[1]), lng: Number(a[2]) } : null
}
const nearBerlin = (u) => {
  const p = urlPos(u)
  return !!p && Math.abs(p.lat - BERLIN.lat) < 0.02 && Math.abs(p.lng - BERLIN.lng) < 0.04
}

test('start points: both load, Apple keeps the Berlin frame, Google stays satellite', async () => {
  await page.evaluate((u) => window.mapPanel.load(u), APPLE_START)
  await expect.poll(viewUrl, { timeout: 60_000 }).toMatch(/^https:\/\/maps\.apple\.com\//)
  await page.waitForTimeout(3000)
  console.log(`apple start -> ${await viewUrl()}`)
  expect(nearBerlin(await viewUrl())).toBe(true)

  await page.evaluate((u) => window.mapPanel.load(u), GOOGLE_START)
  await expect.poll(() => page.evaluate(() => window.mapPanel.getUrl()), { timeout: 60_000 }).toMatch(/^https:\/\/www\.google\.[a-z.]+\/maps\/@52\.\d+,13\.\d+,\d+m\/data=/)
  await page.waitForTimeout(3000)
  console.log(`google start -> ${await page.evaluate(() => window.mapPanel.getUrl())}`)
})

test('provider buttons teleport: Google -> Apple -> Google keep the Berlin spot', async () => {
  await page.evaluate((u) => window.mapPanel.load(u), GOOGLE_START)
  await expect.poll(() => page.evaluate(() => window.mapPanel.getUrl()), { timeout: 60_000 }).toMatch(/\/maps\/@52\./)
  await page.waitForTimeout(3000) // Google rewrites Nm to fit the window; translate from what it settled on
  const gm = Number(/,(\d+)m\//.exec(await page.evaluate(() => window.mapPanel.getUrl()))?.[1])

  await page.click('button[data-provider=apple]')
  await expect.poll(viewUrl, { timeout: 60_000 }).toMatch(/^https:\/\/maps\.apple\.com\//)
  await page.waitForTimeout(4000)
  console.log(`google ${gm}m -> apple: ${await viewUrl()}`)
  expect(nearBerlin(await viewUrl()), `Apple URL ${await viewUrl()}`).toBe(true)
  // Scale carried over too: Apple's lat span in metres is about Google's Nm (Apple may refit a little to its window).
  const span = Number(/span=([\d.]+)(?:,|%2C)/.exec(await viewUrl())?.[1]) * 111320
  expect(span / gm, `Apple span ${span} m vs Google ${gm} m`).toBeGreaterThan(0.7)
  expect(span / gm).toBeLessThan(1.4)
  expect(await inView('document.body.innerText.length')).toBeGreaterThan(0)

  await page.click('button[data-provider=google]')
  await expect.poll(() => page.evaluate(() => window.mapPanel.getUrl()), { timeout: 60_000 }).toMatch(/^https:\/\/www\.google\.[a-z.]+\/maps\/@/)
  await page.waitForTimeout(4000)
  const back = await page.evaluate(() => window.mapPanel.getUrl())
  console.log(`apple -> google: ${back}`)
  expect(nearBerlin(back), `Google URL ${back}`).toBe(true)
  expect(back).toMatch(/!1e3/) // satellite
})

test('a provider button on the provider already shown resets to its start point', async () => {
  await page.click('button[data-provider=google]')
  await expect.poll(() => page.evaluate(() => window.mapPanel.getUrl()), { timeout: 60_000 }).toMatch(/\/maps\/@52\.519\d*,13\.414\d*,\d+m\/data=/)
})

test('teleport from a Street View URL lands on Apple at the same position', async () => {
  const sv = 'https://www.google.com/maps/@52.5162746,13.3777041,3a,75y,123.43h,90t/data=!3m1!1e1'
  await page.evaluate((u) => window.mapPanel.load(u), sv)
  await expect.poll(() => page.evaluate(() => window.mapPanel.getUrl()), { timeout: 60_000 }).toMatch(/\/maps\/@52\.51\d*,13\.37\d*,3a/)
  await page.waitForTimeout(2000)
  await page.click('button[data-provider=apple]')
  await expect.poll(viewUrl, { timeout: 60_000 }).toMatch(/^https:\/\/maps\.apple\.com\//)
  await page.waitForTimeout(4000)
  const u = await viewUrl()
  console.log(`street view -> apple: ${u}`)
  const p = urlPos(u)
  expect(p && Math.abs(p.lat - 52.5163) < 0.01 && Math.abs(p.lng - 13.3777) < 0.01, `Apple URL ${u}`).toBe(true)

  await page.click('button[data-provider=google]') // leave Google shown for the tests below
  await expect.poll(() => page.evaluate(() => window.mapPanel.getUrl()), { timeout: 60_000 }).toMatch(/^https:\/\/www\.google\.[a-z.]+\/maps\/@52\.51/)
})

test('getUrl returns the live Google Maps URL without tracking params', async () => {
  await expect.poll(() => page.evaluate(() => window.mapPanel.getUrl()), { timeout: 60_000 }).toMatch(/^https:\/\/www\.google\.[a-z.]+\/maps\/@/)
  const u = await page.evaluate(() => window.mapPanel.getUrl())
  expect(u).not.toMatch(/[?&](g_ep|entry)=/)
})

test('load(url) restores a Street View URL', async () => {
  const sv = 'https://www.google.com/maps/@48.7784234,9.1799782,3a,75y,123.43h,90t/data=!3m1!1e1'
  await page.evaluate((u) => window.mapPanel.load(u), sv)
  await expect
    .poll(() => page.evaluate(() => window.mapPanel.getUrl()), { timeout: 60_000 })
    .toMatch(/^https:\/\/www\.google\.[a-z.]+\/maps\/@48\.778\d*,9\.179\d*,3a,.*\/data=/)
})

// Hidden = display:none (offsetParent is null for any position:fixed ancestor, so check the computed style).
const searchBox = `(() => { const e = document.querySelector('[role=search]'); return e ? getComputedStyle(e).display : 'missing' })()`

test('play mode keeps the search box, hides sign-in; view mode hides all provider chrome', async () => {
  await page.evaluate((u) => window.mapPanel.load(u), 'https://www.google.com/maps')
  await reachGoogleMaps()
  await expect.poll(() => inView(searchBox), { timeout: 30_000 }).not.toMatch(/none|missing/)
  await expect.poll(() => inView(`(() => { const e = document.querySelector('#gb'); return e ? getComputedStyle(e).display : 'missing' })()`), { timeout: 30_000 }).toBe('none')

  // A second, 'view'-mode panel next to it (window.createMapPanel is exposed by src/main.js in maponly mode).
  await page.evaluate(() => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;right:0;bottom:0;width:640px;height:420px;z-index:10'
    document.body.append(host)
    window.viewPanel = window.createMapPanel(host, { mode: 'view' })
  })
  const inViewPanel = (code) => page.evaluate((c) => window.viewPanel.webview.executeJavaScript(c), code)
  const viewUrl2 = () => page.evaluate(() => window.viewPanel.getUrl())
  await expect.poll(viewUrl2, { timeout: 60_000 }).toMatch(GOOGLE_MAPS)
  expect(await page.locator('.map-panel-view .map-bar').count()).toBe(0) // no provider bar in view mode
  await expect.poll(() => inViewPanel(searchBox), { timeout: 30_000 }).toBe('none')
  expect(await inViewPanel(`document.querySelector('[role=search]').offsetParent`)).toBeNull()
  await page.evaluate(() => window.viewPanel.destroy())
  await expect(page.locator('webview')).toHaveCount(1)
})

test('consent fallback: a stale SOCS cookie still reaches Maps (auto Reject all)', async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'geofinder-test-'))
  const app2 = await electron.launch({
    args: [repoRoot],
    env: { ...process.env, GEOFINDER_USER_DATA: ud, GEOFINDER_DEBUG_NAV: '1', GEOFINDER_MAP_ONLY: '1', GEOFINDER_SOCS: 'CAA' }, // 'CAA' = no choice made yet
  })
  try {
    const nav2 = []
    app2.process().stdout.on('data', (d) => String(d).split('\n').filter((l) => l.includes('[nav]')).forEach((l) => nav2.push(l)))
    const page2 = await app2.firstWindow()
    await page2.waitForFunction(() => !!window.mapPanel)
    await expect
      .poll(() => page2.evaluate(() => window.mapPanel.getUrl()), { timeout: 60_000 })
      .toMatch(/^https:\/\/www\.google\.[a-z.]+\/maps\/@/)
    // Not asserting that the consent page showed: Google may stop serving it for a stale value; reaching Maps is the point.
  } finally {
    await app2.close()
    fs.rmSync(ud, { recursive: true, force: true })
  }
})

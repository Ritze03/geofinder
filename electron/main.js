import { app, BrowserWindow, session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedMapUrl } from './allowlist.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MAPS_PARTITION = 'persist:maps'
// Dev/test env hooks are ignored in packaged builds.
const ENV = app.isPackaged ? {} : process.env
const DEBUG_NAV = !!ENV.GEOFINDER_DEBUG_NAV

// Tests point this at a throwaway dir so persisted cookies/consent can't skew them.
if (ENV.GEOFINDER_USER_DATA) app.setPath('userData', ENV.GEOFINDER_USER_DATA)

// Navigation lock, enforced here (not in the renderer). Blocked silently.
app.on('web-contents-created', (_e, wc) => {
  // The host window only ever embeds <webview> tags; harden what they may get.
  wc.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    delete params.preloadURL
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    if (!isAllowedMapUrl(params.src)) event.preventDefault()
  })

  if (wc.getType() !== 'webview') return
  wc.setWindowOpenHandler(() => ({ action: 'deny' })) // window.open, target=_blank
  const lock = (details) => {
    // Subframes/resources of Google/Apple legitimately touch other domains: main frame only.
    if (details.isMainFrame && !isAllowedMapUrl(details.url)) {
      if (DEBUG_NAV) console.log('[nav] blocked', details.url)
      details.preventDefault()
    }
  }
  wc.on('will-navigate', lock)
  wc.on('will-redirect', lock)
  // electron/electron#17635: a <webview> guest gets no mousemove once the pointer leaves its rect and never the
  // mouseup, so a map drag stops dead at the edge. Tell the host page a drag began on this guest; src/map/mapPanel.js
  // then puts a transparent overlay over the window and forwards the pointer into the guest. Not preventDefault'd.
  // The guest still gets its own mouseUp when the pointer stays over it (plain click): map-up lets the host drop the overlay then.
  wc.on('before-mouse-event', (_e, m) => {
    if (m.button !== 'left') return
    if (m.type === 'mouseDown') wc.hostWebContents?.send('geofinder:map-down', wc.id)
    else if (m.type === 'mouseUp') wc.hostWebContents?.send('geofinder:map-up', wc.id)
  })
  if (DEBUG_NAV) {
    wc.on('did-navigate', (_ev, url) => console.log('[nav] did-navigate', url))
    wc.on('did-start-navigation', (d) => d.isMainFrame && console.log('[nav] start', d.url))
  }
})

// Test hooks (unset in normal runs): GEOFINDER_MAP_ONLY=1 mounts just the bare map panel (src/main.js ?maponly) instead of the game;
// GEOFINDER_QUERY='local&pid=h' adds URL params (e.g. the ?local transport and a per-window identity); GEOFINDER_SECOND_QUERY opens a 2nd window.
function rendererQuery(extra) {
  const q = new URLSearchParams(extra ?? ENV.GEOFINDER_QUERY ?? '')
  if (ENV.GEOFINDER_MAP_ONLY) q.set('maponly', '1')
  return q
}
function loadRenderer(win, extra) {
  const q = rendererQuery(extra)
  const devUrl = ENV.VITE_DEV_SERVER_URL
  if (devUrl) win.loadURL(q.size ? `${devUrl}?${q}` : devUrl)
  else win.loadFile(path.join(here, '..', 'dist', 'index.html'), { query: Object.fromEntries(q) })
}

function createWindow(query) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false, // host game tick + heartbeat must not be throttled when minimized
    },
  })
  win.webContents.on('did-finish-load', () => console.log('[main] renderer loaded'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error('[main] renderer failed to load', code, desc, url))

  loadRenderer(win, query)
}

// Google's consent cookie, so EU users never see consent.google.com before Maps. This is the real "Reject all"
// value Google itself set on a fresh profile (captured Oct 2026 by clicking "Alle ablehnen"): protobuf of
// state=4, "boq_identityfrontenduiserver_20261019.08_p0", lang "de", timestamp. If it ever goes stale, the
// consent page shows again and src/map/mapPanel.js auto-clicks "Reject all" (fallback).
// GEOFINDER_SOCS (dev/test only): 'skip' = seed nothing, anything else = seed that value instead.
const SOCS_REJECT_ALL = 'CAESNQgEEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjYxMDE5LjA4X3AwGgJkZSACGgYIgIHg1gY'
async function seedConsentCookie(maps) {
  const value = ENV.GEOFINDER_SOCS ?? SOCS_REJECT_ALL
  if (value === 'skip') return
  if ((await maps.cookies.get({ name: 'SOCS', domain: '.google.com' })).length) return // user/Google already chose
  await maps.cookies.set({
    url: 'https://www.google.com',
    name: 'SOCS',
    value,
    domain: '.google.com',
    path: '/',
    secure: true,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 13 * 30 * 24 * 3600, // Google's own cookie lasts 13 months
  })
}

app.whenReady().then(async () => {
  // Embedded Google/Apple pages get no permissions (geolocation, notifications, media, ...).
  const maps = session.fromPartition(MAPS_PARTITION)
  await seedConsentCookie(maps).catch((err) => console.error('[main] consent cookie not seeded', err))
  maps.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  maps.setPermissionCheckHandler(() => false)
  // Experiment hook for the Apple UA question; unset in normal runs.
  if (ENV.GEOFINDER_MAPS_UA) maps.setUserAgent(ENV.GEOFINDER_MAPS_UA)
  createWindow()
  // Test hook: a second game window in the same app (two players over the ?local transport, e.g. GEOFINDER_SECOND_QUERY='local&pid=c1').
  if (ENV.GEOFINDER_SECOND_QUERY) createWindow(ENV.GEOFINDER_SECOND_QUERY)
})
app.on('window-all-closed', () => app.quit())

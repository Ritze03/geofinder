import { app, BrowserWindow, ipcMain, session, webContents } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedMapUrl } from './allowlist.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MAPS_PARTITION = 'persist:maps'
const MAX_CAPTURE_WIDTH = 1280
const DEBUG_NAV = !!process.env.GEOFINDER_DEBUG_NAV

// Tests point this at a throwaway dir so persisted cookies/consent can't skew them.
if (process.env.GEOFINDER_USER_DATA) app.setPath('userData', process.env.GEOFINDER_USER_DATA)

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
  if (DEBUG_NAV) {
    wc.on('did-navigate', (_ev, url) => console.log('[nav] did-navigate', url))
    wc.on('did-start-navigation', (d) => d.isMainFrame && console.log('[nav] start', d.url))
  }
})

// Native capture of a map webview: JPEG bytes, <= 1280 px wide.
ipcMain.handle('geofinder:capture-map', async (event, id) => {
  const wc = webContents.fromId(id)
  if (!wc || wc.getType() !== 'webview' || wc.hostWebContents !== event.sender)
    throw new Error('not a map webview')
  let img = await wc.capturePage()
  // capturePage returns device pixels (HiDPI), so check the actual bitmap width.
  if (img.getSize().width > MAX_CAPTURE_WIDTH) img = img.resize({ width: MAX_CAPTURE_WIDTH, quality: 'best' })
  return img.toJPEG(80)
})

// Test hooks (unset in normal runs): GEOFINDER_MAP_ONLY=1 mounts just the bare map panel (src/main.js ?maponly) instead of the game;
// GEOFINDER_QUERY='local&pid=h' adds URL params (e.g. the ?local transport and a per-window identity); GEOFINDER_SECOND_QUERY opens a 2nd window.
function rendererQuery(extra) {
  const q = new URLSearchParams(extra ?? process.env.GEOFINDER_QUERY ?? '')
  if (process.env.GEOFINDER_MAP_ONLY) q.set('maponly', '1')
  return q
}
function loadRenderer(win, extra) {
  const q = rendererQuery(extra)
  const devUrl = process.env.VITE_DEV_SERVER_URL
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
    },
  })
  win.webContents.on('did-finish-load', () => console.log('[main] renderer loaded'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error('[main] renderer failed to load', code, desc, url))

  loadRenderer(win, query)
}

app.whenReady().then(() => {
  // Experiment hook for the Apple UA question; unset in normal runs.
  if (process.env.GEOFINDER_MAPS_UA) session.fromPartition(MAPS_PARTITION).setUserAgent(process.env.GEOFINDER_MAPS_UA)
  createWindow()
  // Test hook: a second game window in the same app (two players over the ?local transport, e.g. GEOFINDER_SECOND_QUERY='local&pid=c1').
  if (process.env.GEOFINDER_SECOND_QUERY) createWindow(process.env.GEOFINDER_SECOND_QUERY)
})
app.on('window-all-closed', () => app.quit())

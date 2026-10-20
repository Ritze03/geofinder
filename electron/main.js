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

function createWindow() {
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

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(here, '..', 'dist', 'index.html'))
}

app.whenReady().then(() => {
  // Experiment hook for the Apple UA question; unset in normal runs.
  if (process.env.GEOFINDER_MAPS_UA) session.fromPartition(MAPS_PARTITION).setUserAgent(process.env.GEOFINDER_MAPS_UA)
  createWindow()
})
app.on('window-all-closed', () => app.quit())

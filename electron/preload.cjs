// Preload must be CommonJS. Keep the exposed surface tiny.
const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, cb) {
  const handler = (_event, webContentsId) => cb(webContentsId)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('geofinder', {
  // Marker: the app runs inside Electron (real map webviews), as opposed to a plain browser (stub map).
  isElectron: true,
  // A left-button press / release reached a map <webview>; cb(webContentsId). Each returns an unsubscribe function.
  // (Works around electron/electron#17635, see src/map/mapPanel.js.)
  onMapDown: (cb) => subscribe('geofinder:map-down', cb),
  onMapUp: (cb) => subscribe('geofinder:map-up', cb),
})

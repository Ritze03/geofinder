// Preload must be CommonJS. Keep the exposed surface tiny.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('geofinder', {
  // JPEG bytes (Uint8Array) of the map webview, <= 1280 px wide.
  captureMap: (webContentsId) => ipcRenderer.invoke('geofinder:capture-map', webContentsId),
})

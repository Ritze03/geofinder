// Preload must be CommonJS. Keep the exposed surface tiny.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('geofinder', {})

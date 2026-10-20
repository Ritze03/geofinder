import { createMapPanel } from './map/mapPanel.js'

// Placeholder page: title + the map panel filling the rest of the window.
document.body.style.cssText =
  'margin:0;background:#0f1115;color:#e6e8ee;font:600 20px system-ui,sans-serif;height:100vh;display:flex;flex-direction:column'
const app = document.getElementById('app')
app.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column'
const title = document.createElement('div')
title.textContent = 'Geofinder'
title.style.cssText = 'padding:8px 16px'
const mapHost = document.createElement('div')
mapHost.style.cssText = 'flex:1;min-height:0'
app.append(title, mapHost)

window.mapPanel = createMapPanel(mapHost) // exposed for dev/tests; the game UI will own this later

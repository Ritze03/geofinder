import './styles/theme.css'
import { startApp } from './app/app.js'
import { createMapPanel } from './map/mapPanel.js'

const root = document.getElementById('app')

if (new URLSearchParams(location.search).has('maponly')) {
  // Electron smoke-test mode (GEOFINDER_MAP_ONLY=1, see electron/main.js): just the real map panel, exposed as window.mapPanel.
  document.body.style.cssText =
    'margin:0;background:#0f1115;color:#e6e8ee;font:600 20px system-ui,sans-serif;height:100vh;display:flex;flex-direction:column'
  root.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column'
  const title = document.createElement('div')
  title.textContent = 'Geofinder'
  title.style.cssText = 'padding:8px 16px'
  const mapHost = document.createElement('div')
  mapHost.style.cssText = 'flex:1;min-height:0'
  root.append(title, mapHost)
  window.mapPanel = createMapPanel(mapHost)
  window.createMapPanel = createMapPanel   // tests build extra panels (view mode, several at once)
} else {
  startApp(root)
}

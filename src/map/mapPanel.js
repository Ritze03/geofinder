import './mapPanel.css'

const PROVIDERS = {
  google: { label: 'Google Maps', url: 'https://www.google.com/maps' },
  apple: { label: 'Apple Maps', url: 'https://maps.apple.com/' },
}

// Embedded real Google/Apple Maps in a <webview>. The navigation lock lives in the
// main process (electron/main.js); this only renders and drives the webview.
//   createMapPanel(container) -> { element, webview, show(provider), capture() }
//   show('google' | 'apple')  resets the webview to that provider's start page
//   capture()                 -> Promise<Blob> (image/jpeg, <= 1280 px wide)
export function createMapPanel(container) {
  const element = document.createElement('div')
  element.className = 'map-panel'

  const bar = document.createElement('div')
  bar.className = 'map-bar'
  const seg = document.createElement('div')
  seg.className = 'map-seg'
  seg.setAttribute('role', 'group')
  seg.setAttribute('aria-label', 'Map provider')
  const buttons = {}
  for (const [key, p] of Object.entries(PROVIDERS)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.provider = key
    b.textContent = p.label
    b.addEventListener('click', () => show(key))
    buttons[key] = b
    seg.append(b)
  }
  bar.append(seg)

  const webview = document.createElement('webview')
  webview.className = 'map-view'
  webview.setAttribute('partition', 'persist:maps') // remembers the Google cookie consent
  webview.setAttribute('src', PROVIDERS.google.url)

  element.append(bar, webview)
  container.append(element)

  function mark(provider) {
    for (const [k, b] of Object.entries(buttons)) b.setAttribute('aria-pressed', String(k === provider))
  }
  mark('google')

  function show(provider) {
    const p = PROVIDERS[provider]
    if (!p) throw new Error(`unknown map provider: ${provider}`)
    mark(provider)
    webview.loadURL(p.url).catch(() => {}) // aborted/superseded loads are not errors here
  }

  async function capture() {
    const bytes = await window.geofinder.captureMap(webview.getWebContentsId())
    return new Blob([bytes], { type: 'image/jpeg' })
  }

  return { element, webview, show, capture }
}

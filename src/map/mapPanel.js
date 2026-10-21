import './mapPanel.css'
import googleView from './css/google-view.css?raw'
import googlePlay from './css/google-play.css?raw'
import appleView from './css/apple-view.css?raw'
import applePlay from './css/apple-play.css?raw'

const PROVIDERS = {
  google: { label: 'Google Maps', url: 'https://www.google.com/maps' },
  apple: { label: 'Apple Maps', url: 'https://maps.apple.com/' },
}

// Per-provider CSS, picked by the page's host: 'view' hides all provider chrome, 'play' only account + menus.
const CSS = { google: { view: googleView, play: googlePlay }, apple: { view: appleView, play: applePlay } }
const GOOGLE_HOST = /^(?:www\.)?google\.[a-z.]+$/
const CONSENT_HOST = /^consent\.google\.[a-z.]+$/
const APPLE_HOST = 'maps.apple.com'

// "Reject all" on Google's consent page (fallback if the pre-seeded SOCS cookie in electron/main.js went stale).
const REJECT_CONSENT = `(() => {
  const re = /^\\s*(reject all|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto|alles weigeren|odrzuć wszystko)\\s*$/i
  const b = [...document.querySelectorAll('button, input[type=submit]')].find((e) => re.test(e.innerText || e.value || ''))
  if (b) b.click()
  return !!b
})()`

const TRACKING_PARAMS = new Set(['entry', 'g_ep'])

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// Google appends entry=ttu&g_ep=... (tracking) to Maps URLs. Strip them textually (no re-encoding of the rest).
export function cleanMapUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return url
  }
  if (!GOOGLE_HOST.test(u.hostname) || !u.search) return url
  const kept = u.search.slice(1).split('&').filter((kv) => kv && !TRACKING_PARAMS.has(kv.split('=')[0]))
  u.search = kept.length ? `?${kept.join('&')}` : ''
  return u.href
}

// Embedded real Google/Apple Maps in a <webview>. The navigation lock lives in the
// main process (electron/main.js); this only renders and drives the webview.
//   createMapPanel(container, { mode = 'play' }) -> { element, webview, show, load, getUrl, destroy }
//   mode 'play'  provider bar; light CSS (hides sign-in + menus; search stays)
//   mode 'view'  no bar; full clean CSS (only map/panorama, zoom, compass, attribution)
//   show('google' | 'apple')  resets the webview to that provider's start page
//   load(url)    webview.loadURL(url); the main-process navigation lock still enforces the allowlist
//   getUrl()     current URL without Google's entry/g_ep params; null before dom-ready.
//                Callers can test /look-around in it (Apple expanded Look Around) for the provider tip.
//   destroy()    removes listeners, any drag overlay and the element
export function createMapPanel(container, { mode = 'play' } = {}) {
  const view = mode === 'view'
  const element = document.createElement('div')
  element.className = view ? 'map-panel map-panel-view' : 'map-panel'

  const buttons = {}
  let bar = null
  if (!view) {
    bar = document.createElement('div')
    bar.className = 'map-bar'
    const seg = document.createElement('div')
    seg.className = 'map-seg'
    seg.setAttribute('role', 'group')
    seg.setAttribute('aria-label', 'Map provider')
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
  }

  const webview = document.createElement('webview')
  webview.className = 'map-view'
  webview.setAttribute('partition', 'persist:maps') // remembers the Google cookie consent
  webview.setAttribute('src', PROVIDERS.google.url)

  element.append(...(bar ? [bar, webview] : [webview]))
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

  function load(url) {
    webview.loadURL(url).catch(() => {})
  }

  let ready = false // webview.getURL()/getWebContentsId() throw before dom-ready
  function getUrl() {
    if (!ready) return null
    try {
      return cleanMapUrl(webview.getURL())
    } catch {
      return null
    }
  }

  // --- CSS: lost on every full navigation, kept across pushState; re-insert on dom-ready + did-navigate.
  let cssKey = null
  let destroyed = false
  async function injectCss() {
    let host
    try {
      host = hostOf(webview.getURL())
    } catch {
      return
    }
    const provider = GOOGLE_HOST.test(host) ? 'google' : host === APPLE_HOST ? 'apple' : null
    const css = provider && CSS[provider][mode === 'view' ? 'view' : 'play']
    if (!css) return
    try {
      const old = cssKey
      cssKey = null
      if (old) await webview.removeInsertedCSS(old).catch(() => {})
      const key = await webview.insertCSS(css)
      if (destroyed) return
      cssKey = key
    } catch {
      /* page navigated away mid-insert: the next did-navigate/dom-ready retries */
    }
  }

  function maybeRejectConsent() {
    let host
    try {
      host = hostOf(webview.getURL())
    } catch {
      return
    }
    if (CONSENT_HOST.test(host)) webview.executeJavaScript(REJECT_CONSENT).catch(() => {})
  }

  const onDomReady = () => {
    ready = true
    injectCss()
    maybeRejectConsent()
  }
  const onNavigate = () => injectCss()
  webview.addEventListener('dom-ready', onDomReady)
  webview.addEventListener('did-navigate', onNavigate) // pushState keeps the CSS, so no did-navigate-in-page

  // --- Drag fix (electron/electron#17635): a webview guest gets no mousemove once the pointer leaves its rect and
  // never the mouseup. On a left press in this guest (main sends geofinder:map-down with its webContents id) cover the
  // window with a transparent overlay, capture the pointer, and forward moves/up into the guest via sendInputEvent.
  let overlay = null // { el, end(e, sendUp), started() }
  function openOverlay() {
    if (overlay || destroyed) return
    const ov = document.createElement('div')
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;cursor:grabbing'
    document.body.append(ov)
    // Hit-testing otherwise still routes the pointer to a webview under it (e.g. another panel) instead of the overlay.
    const webviews = [...document.querySelectorAll('webview')].map((w) => [w, w.style.pointerEvents])
    for (const [w] of webviews) w.style.pointerEvents = 'none'
    const rel = (e) => {
      const r = webview.getBoundingClientRect()
      return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) }
    }
    let captured = false
    const send = (ev) => {
      try {
        webview.sendInputEvent(ev)
      } catch {
        /* webview gone */
      }
    }
    const end = (e, sendUp) => {
      if (overlay?.el !== ov) return
      overlay = null
      ov.remove()
      for (const [w, prev] of webviews) w.style.pointerEvents = prev
      if (sendUp) send({ type: 'mouseUp', ...(e ? rel(e) : { x: 0, y: 0 }), button: 'left', clickCount: 1 })
    }
    ov.addEventListener('pointermove', (e) => {
      // Button already up on the first move: it was a plain click (the guest got its own mouseup).
      if (e.buttons === 0) return end(e, false)
      if (!captured) {
        captured = true
        try {
          ov.setPointerCapture(e.pointerId) // keeps moves coming outside the window
        } catch {
          /* pointer already gone */
        }
      }
      send({ type: 'mouseMove', ...rel(e), button: 'left', modifiers: ['leftButtonDown'] })
    })
    ov.addEventListener('pointerup', (e) => end(e, true))
    ov.addEventListener('pointercancel', (e) => end(e, true))
    // Capture taken away mid-drag (not by our own end()): release the guest's button so it can't stay stuck.
    // (No window 'blur' handler on purpose: the guest taking focus on mousedown blurs the host window at once.)
    ov.addEventListener('lostpointercapture', (e) => captured && end(e, true))
    overlay = { el: ov, end, started: () => captured }
  }

  const isMine = (id) => {
    try {
      return ready && webview.getWebContentsId() === id
    } catch {
      return false // not attached yet
    }
  }
  const unsubscribe = []
  try {
    unsubscribe.push(window.geofinder?.onMapDown?.((id) => isMine(id) && openOverlay()))
    // A click without a drag: the guest got its own mouseUp, so just drop the overlay (a drag's mouseUp reaches the overlay instead).
    unsubscribe.push(window.geofinder?.onMapUp?.((id) => isMine(id) && overlay && !overlay.started() && overlay.end(null, false)))
  } catch {
    /* plain browser: no drag fix needed */
  }

  function destroy() {
    destroyed = true
    for (const off of unsubscribe) off?.()
    overlay?.end(null, false)
    webview.removeEventListener('dom-ready', onDomReady)
    webview.removeEventListener('did-navigate', onNavigate)
    element.remove()
  }

  return { element, webview, show, load, getUrl, destroy }
}

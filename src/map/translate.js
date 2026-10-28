// "Teleport" between map providers: pure functions that read where a Google/Apple Maps URL looks and build the
// other provider's URL for the same spot. No DOM, no Electron. Approximate on purpose (scale is a rough match).
//   parseMapUrl(url)              -> { provider, lat, lng, height, streetView } | null
//   translateMapUrl(url, target)  -> URL string for 'google' | 'apple' at the same spot, or null (caller uses the start point)
//   START_URLS                    -> { google, apple } Berlin start points
// `height` = metres of map height in view (null when the URL carries no scale), one unit for both providers.
import { isAllowedMapUrl } from '../../electron/allowlist.js'

// Start points ("spawn"): Berlin, satellite on Google, the /frame embed on Apple. No entry/g_ep tracking params.
export const START_URLS = {
  google: 'https://www.google.com/maps/@52.5192871,13.4148213,14942m/data=!3m1!1e3',
  apple: 'https://maps.apple.com/frame?center=52.517882%2C13.450507&span=0.350622%2C0.985401',
}

const M_PER_DEG = 111320
// Measured in the real app (1916x942 map view, headless Electron, Google satellite vs Apple /frame, same centre): Google's
// "Nm" is about the metres of map height in view, and Apple's span lat * 111320 is the same height (landmark distances on
// screen matched 1:1). Zoom levels (Google "Nz", Apple "z=") are Web Mercator: height = metres per pixel * a nominal 960 px
// view, which puts z=12 at lat 52.5 at 21.9 km, the same height Google reports as 21882m there.
// (The two start points are NOT the same view in that window: Google 14942m is 15 km high, Apple 0.3506 deg is 39 km.)
const VIEW_PX = 960
const EQUATOR_M_PER_PX = 156543.03
// Apple fits (contains) the requested span in its window and keeps the lat span exact only if the lng span is not the
// binding side; ask for a square-ish lng span (in metres) so the height always binds on a landscape window.
const FRAME_ASPECT_M = 1
const CLOSE_HEIGHT = 400 // no scale known (Street View, bare coordinates): a block or two
const MIN_HEIGHT = 50
const MAX_HEIGHT = 2e7

const num = String.raw`-?\d+(?:\.\d+)?`
const GOOGLE_AT = new RegExp(`/@(${num}),(${num})(?:,([^/]*))?`)
const GOOGLE_HOST = /^(?:www\.)?google\.[a-z.]+$/

const cosLat = (lat) => Math.max(Math.cos((lat * Math.PI) / 180), 0.05)
const heightFromZoom = (z, lat) => (EQUATOR_M_PER_PX * cosLat(lat) * VIEW_PX) / 2 ** z
const clampHeight = (h) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h))
const validPos = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180

function parseLatLng(s) {
  const m = new RegExp(`^\\s*(${num})\\s*,\\s*(${num})\\s*$`).exec(s || '')
  return m ? [Number(m[1]), Number(m[2])] : null
}

function parseGoogle(u) {
  const m = GOOGLE_AT.exec(u.pathname)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  const tail = (m[3] || '').split(',')[0] // "15z" | "14942m" | "3a" (Street View, then 75y,123h,90t) | ""
  let height = null
  let streetView = false
  let t
  if ((t = /^(\d+(?:\.\d+)?)z$/.exec(tail))) height = heightFromZoom(Number(t[1]), lat)
  else if ((t = /^(\d+(?:\.\d+)?)m$/.exec(tail))) height = Number(t[1])
  else if (/^\d+a$/.test(tail)) streetView = true
  return { provider: 'google', lat, lng, height, streetView }
}

// Apple: /frame?center=&span=, ?ll=&z=, ?ll=&spn=, ?coordinate= (place, look-around), ?sll=. Param names are case-insensitive.
function parseApple(u) {
  const q = {}
  for (const [k, v] of u.searchParams) q[k.toLowerCase()] ??= v
  const pos = parseLatLng(q.center) || parseLatLng(q.ll) || parseLatLng(q.coordinate) || parseLatLng(q.sll)
  if (!pos) return null
  const [lat, lng] = pos
  const streetView = u.pathname.startsWith('/look-around')
  let height = null
  const span = parseLatLng(q.span) || parseLatLng(q.spn)
  if (span && span[0] > 0) height = span[0] * M_PER_DEG
  else if (q.z && Number.isFinite(Number(q.z))) height = heightFromZoom(Number(q.z), lat)
  return { provider: 'apple', lat, lng, height, streetView }
}

export function parseMapUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  const r = GOOGLE_HOST.test(u.hostname) ? parseGoogle(u) : u.hostname === 'maps.apple.com' ? parseApple(u) : null
  return r && validPos(r.lat, r.lng) ? r : null
}

const fix = (n, d) => String(Number(n.toFixed(d))) // trims trailing zeros

function buildGoogle({ lat, lng, height }) {
  const m = Math.round(clampHeight(height))
  return `https://www.google.com/maps/@${fix(lat, 7)},${fix(lng, 7)},${m}m/data=!3m1!1e3`
}

function buildApple({ lat, lng, height }) {
  const dLat = clampHeight(height) / M_PER_DEG
  const dLng = Math.min(360, (dLat * FRAME_ASPECT_M) / cosLat(lat))
  return `https://maps.apple.com/frame?center=${fix(lat, 6)}%2C${fix(lng, 6)}&span=${fix(dLat, 6)}%2C${fix(dLng, 6)}`
}

/** URL for `target` ('google' | 'apple') at the spot `url` shows, or null when it cannot be read or already belongs to
 *  `target` (the caller then falls back to START_URLS[target]). */
export function translateMapUrl(url, target) {
  const from = parseMapUrl(url)
  if (!from || from.provider === target) return null
  const height = from.streetView || from.height == null ? CLOSE_HEIGHT : from.height
  const out = (target === 'google' ? buildGoogle : buildApple)({ lat: from.lat, lng: from.lng, height })
  return isAllowedMapUrl(out) ? out : null
}

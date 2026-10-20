// Navigation allowlist for the embedded map webview. Pure + security-relevant:
// parse with URL, match hostname/pathname exactly, never prefixes of the raw string.

// google.<tld>: .com, two-letter ccTLDs (.de), and .co.uk / .com.au style second levels.
const GOOGLE_HOST = String.raw`google\.(?:com|[a-z]{2}|(?:co|com)\.[a-z]{2})`
const GOOGLE_MAPS_HOST = new RegExp(`^(?:www\\.)?${GOOGLE_HOST}$`)
const GOOGLE_CONSENT_HOST = new RegExp(`^consent\\.${GOOGLE_HOST}$`)
const APPLE_MAPS_HOST = 'maps.apple.com'

export function isAllowedMapUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = u.hostname
  if (GOOGLE_MAPS_HOST.test(host)) return u.pathname === '/maps' || u.pathname.startsWith('/maps/')
  if (GOOGLE_CONSENT_HOST.test(host)) return true
  return host === APPLE_MAPS_HOST
}

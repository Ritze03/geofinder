import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedMapUrl } from '../../electron/allowlist.js'
import { START_URLS, parseMapUrl, translateMapUrl } from './translate.js'

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`)

test('start points pass the allowlist and keep satellite on Google', () => {
  assert.ok(isAllowedMapUrl(START_URLS.google))
  assert.ok(isAllowedMapUrl(START_URLS.apple))
  assert.match(START_URLS.google, /data=!3m1!1e3$/)
  assert.doesNotMatch(START_URLS.google, /g_ep|entry/)
})

test('parses Google map, metre, place and Street View URLs', () => {
  const z = parseMapUrl('https://www.google.com/maps/@48.7784,9.1799,15z')
  assert.deepEqual([z.provider, z.lat, z.lng, z.streetView], ['google', 48.7784, 9.1799, false])
  assert.ok(z.height > 1000 && z.height < 20000)
  const m = parseMapUrl(START_URLS.google)
  assert.equal(m.lat, 52.5192871)
  assert.equal(m.height, 14942)
  const p = parseMapUrl('https://www.google.de/maps/place/Brandenburger+Tor/@52.5162746,13.3777041,17z/data=!3m1!4b1')
  assert.deepEqual([p.lat, p.lng], [52.5162746, 13.3777041])
  const sv = parseMapUrl('https://www.google.com/maps/@48.7784234,9.1799782,3a,75y,123.43h,90t/data=!3m1!1e1')
  assert.equal(sv.streetView, true)
  assert.equal(sv.height, null)
  assert.equal(parseMapUrl('https://www.google.com/maps'), null)
  assert.equal(parseMapUrl('https://www.google.com/maps/@95,13,15z'), null)
})

test('parses Apple frame, ll/z and look-around URLs', () => {
  const f = parseMapUrl(START_URLS.apple)
  assert.deepEqual([f.provider, f.lat, f.lng], ['apple', 52.517882, 13.450507])
  near(f.height, 0.350622 * 111320, 1, 'span height')
  const z = parseMapUrl('https://maps.apple.com/?ll=48.7784,9.1799&z=15')
  assert.deepEqual([z.lat, z.lng], [48.7784, 9.1799])
  assert.ok(z.height > 1000 && z.height < 20000)
  const la = parseMapUrl('https://maps.apple.com/look-around?coordinate=48.77,9.18&span=0.01,0.01')
  assert.equal(la.streetView, true)
  assert.equal(parseMapUrl('https://maps.apple.com/'), null)
  assert.equal(parseMapUrl('https://example.com/?ll=1,2'), null)
  assert.equal(parseMapUrl('not a url'), null)
})

test('calibration: Google "Nm" is the metres of height, Apple span lat * 111320 is the same height', () => {
  const a = parseMapUrl(translateMapUrl('https://www.google.com/maps/@52.5192871,13.4148213,21882m/data=!3m1!1e3', 'apple'))
  near(a.lat, 52.5192871, 1e-6, 'lat')
  near(a.lng, 13.4148213, 1e-6, 'lng')
  near(a.height, 21882, 30, 'height')
  assert.match(translateMapUrl('https://www.google.com/maps/@52.5,13.4,21882m', 'apple'), /^https:\/\/maps\.apple\.com\/frame\?center=52\.5%2C13\.4&span=0\.19656\d*%2C/)
  assert.match(translateMapUrl(START_URLS.apple, 'google'), /^https:\/\/www\.google\.com\/maps\/@52\.517882,13\.450507,39031m\/data=!3m1!1e3$/)
})

test('Google zoom and Apple z agree, and z=12 at 52.5N is about Google 21.9 km', () => {
  near(parseMapUrl('https://www.google.com/maps/@52.5192871,13.4,12z').height, 21882, 800, 'z=12')
  const a = parseMapUrl(translateMapUrl('https://www.google.com/maps/@52.5,13.4,14z', 'apple'))
  const b = parseMapUrl('https://maps.apple.com/?ll=52.5,13.4&z=14')
  near(a.height / b.height, 1, 0.01, 'z=14 heights')
})

test('round trip keeps position and scale', () => {
  const g = 'https://www.google.com/maps/@48.7784,9.1799,3200m/data=!3m1!1e3'
  const back = parseMapUrl(translateMapUrl(translateMapUrl(g, 'apple'), 'google'))
  near(back.lat, 48.7784, 1e-5, 'lat')
  near(back.lng, 9.1799, 1e-5, 'lng')
  near(back.height / parseMapUrl(g).height, 1, 0.01, 'height')
})

test('Street View carries the position at a close zoom, always in satellite/frame form', () => {
  const apple = translateMapUrl('https://www.google.com/maps/@48.7784234,9.1799782,3a,75y,123.43h,90t/data=!3m1!1e1', 'apple')
  const a = parseMapUrl(apple)
  assert.deepEqual([a.lat, a.lng], [48.778423, 9.179978])
  assert.ok(a.height < 1000)
  const google = translateMapUrl('https://maps.apple.com/look-around?coordinate=48.7784,9.1799', 'google')
  assert.match(google, /^https:\/\/www\.google\.com\/maps\/@48\.7784,9\.1799,\d+m\/data=!3m1!1e3$/)
})

test('unreadable or same-provider URLs return null (caller falls back to the start point)', () => {
  assert.equal(translateMapUrl('https://www.google.com/maps', 'apple'), null)
  assert.equal(translateMapUrl('https://maps.apple.com/', 'google'), null)
  assert.equal(translateMapUrl(null, 'google'), null)
  assert.equal(translateMapUrl('https://example.com/', 'google'), null)
  assert.equal(translateMapUrl(START_URLS.google, 'google'), null)
})

test('translated URLs always pass the navigation allowlist, even for extreme input', () => {
  const inputs = [
    START_URLS.google, START_URLS.apple,
    'https://www.google.com/maps/@-33.8688,151.2093,2z',
    'https://www.google.com/maps/@89.9,-179.9,1m',
    'https://www.google.com/maps/@0,0,99999999m',
    'https://www.google.com/maps/@64.1,-21.9,21z',
    'https://www.google.com/maps/@64.1,-21.9,3a,90y,0h,90t',
    'https://maps.apple.com/frame?center=89.5%2C10&span=0.00001%2C0.00002',
    'https://maps.apple.com/?ll=-45,170&z=3',
  ]
  for (const url of inputs) {
    for (const target of ['google', 'apple']) {
      const out = translateMapUrl(url, target)
      if (out !== null) assert.ok(isAllowedMapUrl(out), `${url} -> ${out}`)
      assert.ok(out === null || parseMapUrl(out)?.provider === target, `${url} -> ${out}`)
    }
  }
})

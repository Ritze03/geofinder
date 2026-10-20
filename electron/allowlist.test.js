import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedMapUrl as ok } from './allowlist.js'

test('allowed', () => {
  for (const u of [
    'https://www.google.com/maps',
    'https://www.google.com/maps?hl=en',
    'https://www.google.com/maps/@48.1,11.5,15z',
    'https://google.com/maps/place/Berlin',
    'https://www.google.de/maps/@52.5,13.4,14z/data=!3m1!1e3',
    'https://www.google.co.uk/maps',
    'https://www.google.com.au/maps/',
    'https://consent.google.com/m?continue=https://www.google.com/maps',
    'https://consent.google.de/save',
    'https://maps.apple.com/',
    'https://maps.apple.com/?ll=1,2',
  ]) assert.equal(ok(u), true, u)
})

test('blocked', () => {
  for (const u of [
    'https://example.com',
    'https://www.google.com/search?q=maps',
    'https://www.google.com/mapsfoo',
    'https://www.google.com/',
    'https://www.google.com/url?q=https://www.google.com/maps',
    'https://accounts.google.com/signin',
    'https://mail.google.com/maps',
    'https://evil.com/www.google.com/maps',
    'https://www.google.com.evil.com/maps',
    'https://www.google.com@evil.com/maps',
    'https://evilgoogle.com/maps',
    'https://maps.apple.com.evil.com/',
    'https://evilmaps.apple.com/',
    'https://apple.com/',
    'https://beta.maps.apple.com/',
    'http://www.google.com/maps',
    'http://maps.apple.com/',
    'http://consent.google.com/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
    'about:blank',
    '',
    'not a url',
  ]) assert.equal(ok(u), false, u)
})

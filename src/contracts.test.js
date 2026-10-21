import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from './contracts.js';

const bytes = (s) => new TextEncoder().encode(s).length;

test('every MSG name is <= 32 bytes, unique, and equals its key', () => {
  const names = Object.values(C.MSG);
  assert.equal(new Set(names).size, names.length);
  for (const [k, v] of Object.entries(C.MSG)) { assert.equal(k, v); assert.ok(bytes(v) <= 32, v); }
  assert.ok(bytes('hb') <= 32);
});

test('makeRoomCode: GEO- + 4 unambiguous chars, normalizes to itself', () => {
  for (let i = 0; i < 500; i++) {
    const c = C.makeRoomCode();
    assert.match(c, /^GEO-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/);
    assert.equal(C.normalizeRoomCode(c), c);
  }
});

test('normalizeRoomCode', () => {
  assert.equal(C.normalizeRoomCode('GEO-7Q4K'), 'GEO-7Q4K');
  assert.equal(C.normalizeRoomCode('  geo-7q4k \n'), 'GEO-7Q4K');
  assert.equal(C.normalizeRoomCode('7q4k'), 'GEO-7Q4K');
  assert.equal(C.normalizeRoomCode('geo7q4k'), 'GEO-7Q4K');
  assert.equal(C.normalizeRoomCode('GEO 7Q4K'), 'GEO-7Q4K');
  for (const bad of ['', '   ', 'GEO-', 'GEO-7Q4', 'GEO-7Q4KK', 'GEO-0Q4K', 'GEO-OQ4K', 'GEO-1Q4K', 'GEO-IQ4K', 'GEO-LQ4K', 'XYZ-7Q4K', 'GEO-7Q4!', null, undefined, 42, {}]) {
    assert.equal(C.normalizeRoomCode(bad), null, String(bad));
  }
});

test('makeId: 8 chars, no ambiguous chars, no collisions in a sample', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const id = C.makeId(); assert.match(id, /^[a-hj-km-np-z2-9]{8}$/); seen.add(id); }
  assert.equal(seen.size, 2000);
});

test('sanitizeProfile clamps garbage and keeps valid input', () => {
  assert.deepEqual(C.sanitizeProfile(undefined), { name: 'Player', color: 'coral', head: 'round', face: 'happy' });
  assert.deepEqual(C.sanitizeProfile({ name: '  Mo  ', color: 'sky', head: 'hex', face: 'sleepy' }), { name: 'Mo', color: 'sky', head: 'hex', face: 'sleepy' });
  const p = C.sanitizeProfile({ name: 'x'.repeat(40), color: 'nope', head: 5, face: null, extra: 1 });
  assert.equal(p.name.length, C.NAME_MAX);
  assert.deepEqual(Object.keys(p).sort(), ['color', 'face', 'head', 'name']);
});

test('presets, constants and enums are frozen and consistent', () => {
  for (const o of [C.MSG, C.INTENT, C.HOST_INTENT, C.SESSION_EVENT, C.PHASE, C.ERR, C.KEYS, C.COLORS, C.HEADS, C.FACES, C.ROUND_TIMES_MIN, C.DEFAULT_CATEGORIES]) assert.ok(Object.isFrozen(o));
  assert.ok(Object.isFrozen(C.COLORS[0]));
  assert.ok(C.ROUND_TIMES_MIN.includes(C.DEFAULT_ROUND_MIN));
  assert.equal(C.DONE_COUNTDOWN_MS, 60_000);
  assert.equal(C.MAX_PLAYERS, 8);
  assert.equal(C.URL_MAX, 2048);
  assert.equal(C.PROTOCOL_VERSION, 2);
  assert.equal(C.KEYS.profile(), 'geofinder:profile');
  assert.equal(C.KEYS.playerId('b'), 'geofinder:player:b');
  assert.equal(C.PHASE.profile, 'profile');
});

test('createInitialState', () => {
  const s = C.createInitialState({ playerId: 'p1', profile: { name: 'Mo', color: 'sky', head: 'hex', face: 'wink' } }, 'GEO-7Q4K');
  assert.equal(s.roomCode, 'GEO-7Q4K');
  assert.equal(s.phase, 'lobby');
  assert.equal(s.players.length, 1);
  assert.deepEqual(s.players[0], { playerId: 'p1', profile: { name: 'Mo', color: 'sky', head: 'hex', face: 'wink' }, isHost: true, connected: true, ready: false, done: false });
  assert.equal(s.categories.length, C.DEFAULT_CATEGORIES.length);
  assert.equal(s.categories[0].id, 'cat1');
  assert.equal(s.settings.roundMinutes, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.match(C.createInitialState({ playerId: 'p', profile: {} }).roomCode, /^GEO-/);
});

test('clock helpers', () => {
  const off = C.clockOffset(10_000, 4_000);
  assert.equal(off, 6_000);
  assert.equal(C.msLeft(70_000, off, 4_000), 60_000);
  assert.equal(C.msLeft(70_000, off, 100_000), 0);
  assert.equal(C.msLeft(null, off), null);
});

test('the old image protocol is gone (names assembled so that a repo-wide grep for the removed identifiers stays clean)', () => {
  const OLD_INTENT = 'chat' + 'Image', OLD_META = 'Image' + 'Meta', OLD_PREFIX = 'IMAGE' + '_';
  assert.deepEqual(Object.values(C.MSG).sort(), ['hello', 'intent', 'reject', 'state']);
  assert.deepEqual(Object.keys(C).filter((k) => k.startsWith(OLD_PREFIX)), []);
  assert.equal(C[OLD_META], undefined);
  assert.equal(C.INTENT[OLD_INTENT], undefined);
  assert.equal(C.INTENT.chatLink, 'chatLink');
  assert.equal(C.INTENT.capture, 'capture');
});

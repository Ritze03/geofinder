import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE, ERR, SYSTEM, INTENT, HOST_INTENT, createInitialState, defaultProfile,
  MAX_PLAYERS, MAX_CATEGORIES, MAX_SUGGESTIONS, CATEGORY_LABEL_MAX, CHAT_TEXT_MAX, CHAT_HISTORY_MAX, DONE_COUNTDOWN_MS, NAME_MAX, URL_MAX, RATING_NO_FIT,
} from '../contracts.js';
import { applyIntent, allReady, allDone, canStart, startBlocker, myCapture, reviewCategory, pointsOf, categoryScore, raterMeans, formatPoints, ratingProgress, ranking, ratingOf, stateFor, normalizes } from './index.js';

const T0 = 1_000_000;
const GURL = 'https://www.google.com/maps/@48.7784234,9.1799782,3a,53.6y,123.43h,100.86t/data=!3m7!1e1!3m5!1sCIHM0ogKEICAgIDy7c62GQ!2e10!7i11264!8i5632';
const APPLE_LA = 'https://maps.apple.com/look-around?z=17&coordinate=37.819887%2C-122.478529&_mvs=CiQJVlxWNPLoQkAR';
const APPLE_MAP = 'https://maps.apple.com/frame?z=17&center=37.821476%2C-122.481293&span=0.007983%2C0.017499';
const prof = (name) => ({ ...defaultProfile(), name });

/** Apply and require success; returns the new state. */
function ok(state, actor, intent, now = T0) {
  const r = applyIntent(state, actor, intent, now);
  assert.equal(r.error, null, `${intent?.type} failed with ${r.error}`);
  return r.state;
}
/** Apply and require `code`; also asserts the original state object is returned. */
function bad(state, actor, intent, code, now = T0) {
  const before = JSON.stringify(state);
  const r = applyIntent(state, actor, intent, now);
  assert.equal(r.error, code, `${intent?.type}: expected ${code}, got ${r.error}`);
  assert.equal(r.state, state, 'error must return the original state object');
  assert.equal(JSON.stringify(state), before);
}
const join = (s, id, now = T0) => ok(s, SYSTEM, { type: HOST_INTENT.join, playerId: id, profile: prof(id) }, now);
const leave = (s, id, now = T0) => ok(s, SYSTEM, { type: HOST_INTENT.leave, playerId: id }, now);
const tick = (s, now) => applyIntent(s, SYSTEM, { type: HOST_INTENT.tick }, now);
const P = (s, id) => s.players.find((p) => p.playerId === id);

/** Lobby with host 'h' + players p1..p(n-1). */
function lobby(n = 3) {
  let s = createInitialState({ playerId: 'h', profile: prof('host') }, 'GEO-TEST');
  for (let i = 1; i < n; i++) s = join(s, `p${i}`);
  return s;
}
const readyAll = (s) => s.players.reduce((st, p) => ok(st, p.playerId, { type: INTENT.setReady, ready: true }), s);
/** Game in play phase, started at T0 (3 players unless given). */
function play(n = 3) {
  return ok(readyAll(lobby(n)), 'h', { type: INTENT.startGame }, T0);
}
const doneAll = (s, now) => s.players.filter((p) => p.connected && !p.done).reduce((st, p) => ok(st, p.playerId, { type: INTENT.setDone, done: true }, now), s);
/** Play game where p1 and p2 captured cat1 and everybody ended the round via the timer -> review at index 0. */
function review() {
  let s = play(3);
  s = ok(s, 'p1', { type: INTENT.capture, captureId: 'img1', categoryId: 'cat1', url: GURL }, T0 + 1);
  s = ok(s, 'p2', { type: INTENT.capture, captureId: 'img2', categoryId: 'cat1', url: GURL }, T0 + 2);
  s = ok(s, 'h', { type: INTENT.capture, captureId: 'img3', categoryId: 'cat1', url: GURL }, T0 + 3);
  const r = tick(s, s.roundEndsAt);
  assert.equal(r.state.phase, PHASE.review);
  return r.state;
}

describe('purity and dispatch', () => {
  test('does not mutate the input; bumps rev by exactly 1 on change', () => {
    const s = lobby(2);
    const frozenCopy = structuredClone(s);
    const r = applyIntent(s, 'h', { type: INTENT.setReady, ready: true }, T0);
    assert.deepEqual(s, frozenCopy);
    assert.equal(r.state.rev, s.rev + 1);
    assert.notEqual(r.state, s);
  });
  test('unknown intent type / garbage -> invalid', () => {
    const s = lobby(2);
    bad(s, 'h', { type: 'nope' }, ERR.invalid);
    bad(s, 'h', { type: 'toString' }, ERR.invalid);
    bad(s, 'h', { type: '__proto__' }, ERR.invalid);
    bad(s, 'h', null, ERR.invalid);
    bad(s, 'h', {}, ERR.invalid);
  });
  test('unknown actor -> forbidden; HOST_INTENT only from SYSTEM', () => {
    const s = lobby(2);
    bad(s, 'ghost', { type: INTENT.setReady, ready: true }, ERR.forbidden);
    bad(s, 'h', { type: HOST_INTENT.join, playerId: 'x', profile: prof('x') }, ERR.forbidden);
    bad(s, 'p1', { type: HOST_INTENT.tick }, ERR.forbidden);
    bad(s, 'h', { type: HOST_INTENT.leave, playerId: 'p1' }, ERR.forbidden);
  });
  test('SYSTEM cannot send player intents', () => {
    bad(lobby(2), SYSTEM, { type: INTENT.setReady, ready: true }, ERR.forbidden);
  });
  test('result states are JSON round-trippable', () => {
    const s = review();
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  });
});

describe('join / leave', () => {
  test('lobby join appends in order, profile sanitized', () => {
    let s = lobby(1);
    s = ok(s, SYSTEM, { type: HOST_INTENT.join, playerId: 'a', profile: { name: '  ' + 'x'.repeat(40), color: 'nope' } });
    assert.deepEqual(s.players.map((p) => p.playerId), ['h', 'a']);
    assert.equal(P(s, 'a').profile.name.length, NAME_MAX);
    assert.equal(P(s, 'a').profile.color, 'coral');
    assert.deepEqual([P(s, 'a').isHost, P(s, 'a').connected, P(s, 'a').ready, P(s, 'a').done], [false, true, false, false]);
  });
  test('9th player -> full', () => {
    let s = lobby(MAX_PLAYERS);
    assert.equal(s.players.length, MAX_PLAYERS);
    bad(s, SYSTEM, { type: HOST_INTENT.join, playerId: 'late', profile: prof('late') }, ERR.full);
  });
  test('bad playerId -> invalid', () => {
    const s = lobby(1);
    bad(s, SYSTEM, { type: HOST_INTENT.join, playerId: '', profile: prof('x') }, ERR.invalid);
    bad(s, SYSTEM, { type: HOST_INTENT.join, playerId: '__proto__', profile: prof('x') }, ERR.invalid);
  });
  test('new player after the lobby -> started; known player rejoins its seat keeping ready/done', () => {
    let s = play(3);
    bad(s, SYSTEM, { type: HOST_INTENT.join, playerId: 'new', profile: prof('new') }, ERR.started);
    s = ok(s, 'p1', { type: INTENT.setDone, done: true });
    s = leave(s, 'p1');
    assert.equal(P(s, 'p1').connected, false);
    assert.equal(P(s, 'p1').done, true);
    assert.equal(P(s, 'p1').ready, true);
    s = ok(s, SYSTEM, { type: HOST_INTENT.join, playerId: 'p1', profile: { ...prof('renamed') } });
    assert.equal(P(s, 'p1').connected, true);
    assert.equal(P(s, 'p1').done, true);
    assert.equal(P(s, 'p1').ready, true);
    assert.equal(P(s, 'p1').profile.name, 'renamed');
    assert.equal(s.players.length, 3);
  });
  test('rejoin works in review and results too', () => {
    let s = review();
    s = leave(s, 'p2');
    s = ok(s, SYSTEM, { type: HOST_INTENT.join, playerId: 'p2', profile: prof('p2') });
    assert.equal(P(s, 'p2').connected, true);
  });
  test('lobby leave removes the player and their pending suggestions', () => {
    let s = lobby(3);
    s = ok(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'a bridge' });
    s = ok(s, 'p2', { type: INTENT.suggestCategory, id: 's2', label: 'a tower' });
    s = leave(s, 'p1');
    assert.deepEqual(s.players.map((p) => p.playerId), ['h', 'p2']);
    assert.deepEqual(s.suggestions.map((x) => x.id), ['s2']);
  });
  test('leave from play on keeps the player as connected:false', () => {
    let s = play(3);
    s = leave(s, 'p1');
    assert.equal(s.players.length, 3);
    assert.equal(P(s, 'p1').connected, false);
    s = ok(s, 'h', { type: INTENT.setDone, done: true }); // sanity: game continues
  });
  test('leave of unknown player -> notFound', () => {
    bad(lobby(2), SYSTEM, { type: HOST_INTENT.leave, playerId: 'zzz' }, ERR.notFound);
  });
  test('host leaving in the lobby is only marked away (the seat stays)', () => {
    const s = leave(lobby(2), 'h');
    assert.equal(s.players.length, 2);
    assert.equal(P(s, 'h').connected, false);
  });
});

describe('lobby: profile and ready', () => {
  test('setProfile sanitizes; lobby only', () => {
    let s = lobby(2);
    s = ok(s, 'p1', { type: INTENT.setProfile, profile: { name: 'Zed', color: 'sky', head: 'hex', face: 'wink' } });
    assert.deepEqual(P(s, 'p1').profile, { name: 'Zed', color: 'sky', head: 'hex', face: 'wink' });
    s = ok(s, 'p1', { type: INTENT.setProfile, profile: { name: '', color: 'bogus' } });
    assert.equal(P(s, 'p1').profile.name, 'Player');
    assert.equal(P(s, 'p1').profile.color, 'coral');
    bad(play(2), 'p1', { type: INTENT.setProfile, profile: prof('x') }, ERR.wrongPhase);
  });
  test('setReady is idempotent (no rev bump, same state) and not a toggle', () => {
    let s = lobby(2);
    s = ok(s, 'p1', { type: INTENT.setReady, ready: true });
    const r = applyIntent(s, 'p1', { type: INTENT.setReady, ready: true }, T0);
    assert.equal(r.error, null);
    assert.equal(r.state, s);
    assert.equal(r.state.rev, s.rev);
    s = ok(s, 'p1', { type: INTENT.setReady, ready: false });
    assert.equal(P(s, 'p1').ready, false);
    bad(s, 'p1', { type: INTENT.setReady, ready: 'yes' }, ERR.invalid);
  });
  test('setReady lobby only', () => {
    bad(play(2), 'p1', { type: INTENT.setReady, ready: true }, ERR.wrongPhase);
  });
  test('allReady counts connected players only; needs >= 1', () => {
    let s = lobby(3);
    assert.equal(allReady(s), false);
    s = ok(s, 'h', { type: INTENT.setReady, ready: true });
    s = ok(s, 'p1', { type: INTENT.setReady, ready: true });
    assert.equal(allReady(s), false);
    s = leave(s, 'p2');   // lobby: removed
    assert.equal(allReady(s), true);
    assert.equal(allReady({ ...s, players: [] }), false);
  });
});

describe('lobby: suggestions and categories', () => {
  test('suggest: non-host only, trimmed, stored with author and time', () => {
    let s = lobby(2);
    s = ok(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: '  a bridge  ' }, 777);
    assert.deepEqual(s.suggestions, [{ id: 's1', playerId: 'p1', label: 'a bridge', at: 777 }]);
    bad(s, 'h', { type: INTENT.suggestCategory, id: 's2', label: 'x' }, ERR.forbidden);
  });
  test('suggest: label validation and phase', () => {
    const s = lobby(2);
    bad(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: '   ' }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'x'.repeat(CATEGORY_LABEL_MAX + 1) }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 5 }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.suggestCategory, label: 'ok' }, ERR.invalid);
    ok(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'x'.repeat(CATEGORY_LABEL_MAX) });
    bad(play(2), 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'ok' }, ERR.wrongPhase);
  });
  test('suggest: MAX_SUGGESTIONS cap -> limit', () => {
    let s = lobby(2);
    for (let i = 0; i < MAX_SUGGESTIONS; i++) s = ok(s, 'p1', { type: INTENT.suggestCategory, id: `s${i}`, label: `l${i}` });
    bad(s, 'p1', { type: INTENT.suggestCategory, id: 'over', label: 'x' }, ERR.limit);
  });
  test('duplicate id is ignored: no change, no error, no rev bump', () => {
    let s = lobby(2);
    s = ok(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'a' });
    const r = applyIntent(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'different' }, T0);
    assert.equal(r.error, null);
    assert.equal(r.state, s);
    assert.equal(s.suggestions[0].label, 'a');
    // also against category ids
    const r2 = applyIntent(s, 'p1', { type: INTENT.suggestCategory, id: 'cat1', label: 'x' }, T0);
    assert.equal(r2.state, s);
  });
  test('accept: moves the suggestion into categories (id kept), removes it; accepts `id` or `suggestionId`', () => {
    let s = lobby(2);
    s = ok(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'a bridge' });
    s = ok(s, 'p1', { type: INTENT.suggestCategory, id: 's2', label: 'a tower' });
    const n = s.categories.length;
    s = ok(s, 'h', { type: INTENT.acceptSuggestion, suggestionId: 's1' });
    assert.deepEqual(s.categories.at(-1), { id: 's1', label: 'a bridge' });
    assert.equal(s.categories.length, n + 1);
    assert.deepEqual(s.suggestions.map((x) => x.id), ['s2']);
    s = ok(s, 'h', { type: INTENT.acceptSuggestion, id: 's2' });
    assert.equal(s.suggestions.length, 0);
    assert.equal(s.categories.at(-1).id, 's2');
  });
  test('accept/reject: host only, lobby only, must exist', () => {
    let s = lobby(2);
    s = ok(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'a bridge' });
    bad(s, 'p1', { type: INTENT.acceptSuggestion, suggestionId: 's1' }, ERR.forbidden);
    bad(s, 'p1', { type: INTENT.rejectSuggestion, suggestionId: 's1' }, ERR.forbidden);
    bad(s, 'h', { type: INTENT.acceptSuggestion, suggestionId: 'nope' }, ERR.notFound);
    bad(s, 'h', { type: INTENT.rejectSuggestion, suggestionId: 'nope' }, ERR.notFound);
    const r = ok(s, 'h', { type: INTENT.rejectSuggestion, suggestionId: 's1' });
    assert.equal(r.suggestions.length, 0);
    assert.equal(r.categories.length, s.categories.length);
    bad(play(2), 'h', { type: INTENT.acceptSuggestion, suggestionId: 's1' }, ERR.wrongPhase);
    bad(play(2), 'h', { type: INTENT.rejectSuggestion, suggestionId: 's1' }, ERR.wrongPhase);
  });
  test('MAX_CATEGORIES applies to add and accept; failed accept keeps the suggestion', () => {
    let s = lobby(2);
    s = ok(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'x' });
    while (s.categories.length < MAX_CATEGORIES) s = ok(s, 'h', { type: INTENT.addCategory, id: `c${s.categories.length}`, label: 'l' });
    bad(s, 'h', { type: INTENT.addCategory, id: 'more', label: 'l' }, ERR.limit);
    bad(s, 'h', { type: INTENT.acceptSuggestion, suggestionId: 's1' }, ERR.limit);
    assert.equal(s.suggestions.length, 1);
  });
  test('addCategory: host only, label validation, duplicate id ignored', () => {
    let s = lobby(2);
    bad(s, 'p1', { type: INTENT.addCategory, id: 'c', label: 'x' }, ERR.forbidden);
    bad(s, 'h', { type: INTENT.addCategory, id: 'c', label: '  ' }, ERR.invalid);
    bad(s, 'h', { type: INTENT.addCategory, id: 'c', label: 'x'.repeat(CATEGORY_LABEL_MAX + 1) }, ERR.invalid);
    s = ok(s, 'h', { type: INTENT.addCategory, id: 'c', label: ' mine ' });
    assert.deepEqual(s.categories.at(-1), { id: 'c', label: 'mine' });
    const r = applyIntent(s, 'h', { type: INTENT.addCategory, id: 'c', label: 'again' }, T0);
    assert.equal(r.state, s);
    bad(review(), 'h', { type: INTENT.addCategory, id: 'c', label: 'x' }, ERR.wrongPhase);
  });
  test('remove / rename: host only, lobby only, must exist, label validated', () => {
    let s = lobby(2);
    bad(s, 'p1', { type: INTENT.removeCategory, categoryId: 'cat1' }, ERR.forbidden);
    bad(s, 'p1', { type: INTENT.renameCategory, categoryId: 'cat1', label: 'x' }, ERR.forbidden);
    bad(s, 'h', { type: INTENT.removeCategory, categoryId: 'zzz' }, ERR.notFound);
    bad(s, 'h', { type: INTENT.renameCategory, categoryId: 'zzz', label: 'x' }, ERR.notFound);
    bad(s, 'h', { type: INTENT.renameCategory, categoryId: 'cat1', label: ' ' }, ERR.invalid);
    const n = s.categories.length;
    s = ok(s, 'h', { type: INTENT.renameCategory, categoryId: 'cat1', label: '  renamed ' });
    assert.equal(s.categories[0].label, 'renamed');
    s = ok(s, 'h', { type: INTENT.removeCategory, categoryId: 'cat1' });
    assert.equal(s.categories.length, n - 1);
    assert.equal(s.categories.some((c) => c.id === 'cat1'), false);
    const p = play(2);
    bad(p, 'h', { type: INTENT.removeCategory, categoryId: 'cat1' }, ERR.wrongPhase);
    bad(p, 'h', { type: INTENT.renameCategory, categoryId: 'cat1', label: 'x' }, ERR.wrongPhase);
  });
  test('setRoundTime: host only, preset only, lobby only', () => {
    let s = lobby(2);
    bad(s, 'p1', { type: INTENT.setRoundTime, minutes: 15 }, ERR.forbidden);
    bad(s, 'h', { type: INTENT.setRoundTime, minutes: 7 }, ERR.invalid);
    bad(s, 'h', { type: INTENT.setRoundTime, minutes: '15' }, ERR.invalid);
    s = ok(s, 'h', { type: INTENT.setRoundTime, minutes: 15 });
    assert.equal(s.settings.roundMinutes, 15);
    bad(play(2), 'h', { type: INTENT.setRoundTime, minutes: 15 }, ERR.wrongPhase);
  });
});

describe('startGame', () => {
  test('non-host -> forbidden; wrong phase -> wrongPhase', () => {
    const s = readyAll(lobby(3));
    bad(s, 'p1', { type: INTENT.startGame }, ERR.forbidden);
    bad(play(3), 'h', { type: INTENT.startGame }, ERR.wrongPhase);
  });
  test('< MIN_PLAYERS connected -> tooFewPlayers', () => {
    const s = readyAll(lobby(1));
    bad(s, 'h', { type: INTENT.startGame }, ERR.tooFewPlayers);
    assert.equal(canStart(s), false);
    assert.equal(startBlocker(s), ERR.tooFewPlayers);
  });
  test('no categories -> noCategories', () => {
    let s = lobby(2);
    for (const c of [...s.categories]) s = ok(s, 'h', { type: INTENT.removeCategory, categoryId: c.id });
    s = readyAll(s);
    bad(s, 'h', { type: INTENT.startGame }, ERR.noCategories);
    assert.equal(startBlocker(s), ERR.noCategories);
  });
  test('gated on every connected player incl. the host being ready', () => {
    let s = lobby(3);
    s = ok(s, 'p1', { type: INTENT.setReady, ready: true });
    s = ok(s, 'p2', { type: INTENT.setReady, ready: true });
    bad(s, 'h', { type: INTENT.startGame }, ERR.notReady);   // host not ready
    assert.equal(canStart(s), false);
    s = ok(s, 'h', { type: INTENT.setReady, ready: true });
    assert.equal(canStart(s), true);
    s = ok(s, 'p2', { type: INTENT.setReady, ready: false });
    bad(s, 'h', { type: INTENT.startGame }, ERR.notReady);
  });
  test('success: play phase, timers, flags reset, suggestions cleared', () => {
    let s = lobby(3);
    s = ok(s, 'p1', { type: INTENT.suggestCategory, id: 's1', label: 'x' });
    s = ok(s, 'h', { type: INTENT.setRoundTime, minutes: 15 });
    s = readyAll(s);
    const r = applyIntent(s, 'h', { type: INTENT.startGame }, 5_000);
    assert.equal(r.error, null);
    assert.equal(r.state.phase, PHASE.play);
    assert.equal(r.state.roundEndsAt, 5_000 + 15 * 60_000);
    assert.equal(r.state.doneCountdownEndsAt, null);
    assert.deepEqual(r.state.suggestions, []);
    assert.ok(r.state.players.every((p) => p.done === false));
    assert.equal(r.state.rev, s.rev + 1);
  });
});

describe('play: capture', () => {
  test('stores a CaptureRef; last capture replaces the earlier one', () => {
    let s = play(3);
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'cat1', url: GURL }, T0 + 10);
    assert.deepEqual(myCapture(s, 'p1', 'cat1'), { captureId: 'a', playerId: 'p1', categoryId: 'cat1', at: T0 + 10, url: GURL });
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'b', categoryId: 'cat1', url: APPLE_LA }, T0 + 20);
    assert.deepEqual(myCapture(s, 'p1', 'cat1'), { captureId: 'b', playerId: 'p1', categoryId: 'cat1', at: T0 + 20, url: APPLE_LA });
    assert.equal(Object.keys(s.captures.cat1).length, 1);
    s = ok(s, 'p2', { type: INTENT.capture, captureId: 'c', categoryId: 'cat1', url: GURL }, T0 + 30);
    assert.equal(myCapture(s, 'p1', 'cat1').captureId, 'b');
    assert.equal(myCapture(s, 'p2', 'cat1').captureId, 'c');
  });
  test('unknown category -> notFound; bad ids -> invalid; wrong phase', () => {
    const s = play(3);
    bad(s, 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'nope', url: GURL }, ERR.notFound);
    bad(s, 'p1', { type: INTENT.capture, captureId: '', categoryId: 'cat1', url: GURL }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.capture, captureId: 'a', url: GURL }, ERR.invalid);
    bad(lobby(2), 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'cat1', url: GURL }, ERR.wrongPhase);
    bad(review(), 'p1', { type: INTENT.capture, captureId: 'zz', categoryId: 'cat1', url: GURL }, ERR.wrongPhase);
  });
  test('duplicate captureId is ignored (retry), even from another player', () => {
    let s = play(3);
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'cat1', url: GURL });
    for (const [who, cat] of [['p1', 'cat1'], ['p2', 'cat1'], ['p1', 'cat2']]) {
      const r = applyIntent(s, who, { type: INTENT.capture, captureId: 'a', categoryId: cat, url: GURL }, T0 + 5);
      assert.equal(r.error, null);
      assert.equal(r.state, s);
    }
  });
});

describe('play: mid-game addCategory', () => {
  test('host adds a category, clears every done flag and cancels the countdown', () => {
    let s = play(3);
    s = doneAll(s, T0 + 100);
    assert.equal(s.doneCountdownEndsAt, T0 + 100 + DONE_COUNTDOWN_MS);
    const n = s.categories.length;
    s = ok(s, 'h', { type: INTENT.addCategory, id: 'late', label: 'a windmill' }, T0 + 200);
    assert.equal(s.categories.length, n + 1);
    assert.equal(s.categories.at(-1).id, 'late');
    assert.ok(s.players.every((p) => !p.done));
    assert.equal(s.doneCountdownEndsAt, null);
    assert.equal(s.phase, PHASE.play);
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'x', categoryId: 'late', url: GURL });   // and it can be captured
    assert.ok(myCapture(s, 'p1', 'late'));
  });
  test('non-host mid-game add -> forbidden; limit applies; duplicate id ignored without clearing done', () => {
    let s = play(3);
    bad(s, 'p1', { type: INTENT.addCategory, id: 'late', label: 'x' }, ERR.forbidden);
    s = ok(s, 'p1', { type: INTENT.setDone, done: true });
    const r = applyIntent(s, 'h', { type: INTENT.addCategory, id: 'cat1', label: 'dup' }, T0);
    assert.equal(r.state, s);
    assert.equal(P(r.state, 'p1').done, true);
    while (s.categories.length < MAX_CATEGORIES) s = ok(s, 'h', { type: INTENT.addCategory, id: `c${s.categories.length}`, label: 'l' });
    bad(s, 'h', { type: INTENT.addCategory, id: 'over', label: 'l' }, ERR.limit);
  });
});

describe('play: done countdown', () => {
  test('starts when all connected are done; not before', () => {
    let s = play(3);
    s = ok(s, 'p1', { type: INTENT.setDone, done: true }, T0 + 10);
    s = ok(s, 'p2', { type: INTENT.setDone, done: true }, T0 + 20);
    assert.equal(s.doneCountdownEndsAt, null);
    assert.equal(allDone(s), false);
    s = ok(s, 'h', { type: INTENT.setDone, done: true }, T0 + 30);
    assert.equal(allDone(s), true);
    assert.equal(s.doneCountdownEndsAt, T0 + 30 + DONE_COUNTDOWN_MS);
  });
  test('setDone is idempotent: no bump, and an extra done never moves the deadline', () => {
    let s = doneAll(play(3), T0 + 30);
    const r = applyIntent(s, 'p1', { type: INTENT.setDone, done: true }, T0 + 5000);
    assert.equal(r.state, s);
    assert.equal(r.state.doneCountdownEndsAt, T0 + 30 + DONE_COUNTDOWN_MS);
    bad(s, 'p1', { type: INTENT.setDone, done: 1 }, ERR.invalid);
  });
  test('un-ready cancels; all done again restarts from a full 60 s', () => {
    let s = doneAll(play(3), T0 + 100);
    assert.equal(s.doneCountdownEndsAt, T0 + 100 + DONE_COUNTDOWN_MS);
    s = ok(s, 'p2', { type: INTENT.setDone, done: false }, T0 + 40_000);
    assert.equal(s.doneCountdownEndsAt, null);
    s = ok(s, 'p2', { type: INTENT.setDone, done: true }, T0 + 50_000);
    assert.equal(s.doneCountdownEndsAt, T0 + 50_000 + DONE_COUNTDOWN_MS);   // not the old deadline
  });
  test('round ends when the countdown elapses (tick), not before', () => {
    const s = doneAll(play(3), T0 + 100);
    const dl = s.doneCountdownEndsAt;
    const early = tick(s, dl - 1);
    assert.equal(early.state, s);
    const r = tick(s, dl);
    assert.equal(r.error, null);
    assert.equal(r.state.phase, PHASE.review);
    assert.equal(r.state.reviewIndex, 0);
    assert.equal(r.state.roundEndsAt, null);
    assert.equal(r.state.doneCountdownEndsAt, null);
    assert.equal(r.state.rev, s.rev + 1);
  });
  test('a leave that completes all-done starts the countdown; a rejoin of a not-done player cancels it', () => {
    let s = play(3);
    s = ok(s, 'h', { type: INTENT.setDone, done: true }, T0 + 10);
    s = ok(s, 'p1', { type: INTENT.setDone, done: true }, T0 + 20);
    assert.equal(s.doneCountdownEndsAt, null);
    s = leave(s, 'p2', T0 + 30);   // p2 was the only one not done
    assert.equal(allDone(s), true);
    assert.equal(s.doneCountdownEndsAt, T0 + 30 + DONE_COUNTDOWN_MS);
    s = ok(s, SYSTEM, { type: HOST_INTENT.join, playerId: 'p2', profile: prof('p2') }, T0 + 40);
    assert.equal(P(s, 'p2').done, false);
    assert.equal(s.doneCountdownEndsAt, null);
  });
  test('a rejoin of a done player keeps a running countdown', () => {
    let s = doneAll(play(3), T0 + 10);
    const dl = s.doneCountdownEndsAt;
    s = leave(s, 'p1', T0 + 20);
    assert.equal(s.doneCountdownEndsAt, dl);
    s = ok(s, SYSTEM, { type: HOST_INTENT.join, playerId: 'p1', profile: prof('p1') }, T0 + 30);
    assert.equal(s.doneCountdownEndsAt, dl);
  });
  test('setDone only in play', () => {
    bad(lobby(2), 'p1', { type: INTENT.setDone, done: true }, ERR.wrongPhase);
    bad(review(), 'p1', { type: INTENT.setDone, done: true }, ERR.wrongPhase);
  });
});

describe('tick / round timer', () => {
  test('round timer ends the round regardless of done state', () => {
    const s = play(3);   // nobody done
    const end = s.roundEndsAt;
    assert.equal(tick(s, end - 1).state, s);
    const r = tick(s, end);
    assert.equal(r.state.phase, PHASE.review);
    assert.equal(r.state.reviewIndex, 0);
    assert.equal(r.state.roundEndsAt, null);
    assert.equal(r.state.doneCountdownEndsAt, null);
  });
  test('round timer wins over a still-running done countdown', () => {
    let s = play(3);
    s = doneAll(s, s.roundEndsAt - 1000);   // countdown would end well after the round
    const r = tick(s, s.roundEndsAt);
    assert.equal(r.state.phase, PHASE.review);
    assert.equal(r.state.doneCountdownEndsAt, null);
  });
  test('tick that changes nothing returns the SAME state without a rev bump (all phases)', () => {
    for (const s of [lobby(2), play(3), review()]) {
      const r = tick(s, T0 + 1);
      assert.equal(r.error, null);
      assert.equal(r.state, s);
      assert.equal(r.state.rev, s.rev);
    }
  });
  test('tick after the round ended is a no-op (does not re-fire)', () => {
    const r1 = tick(play(3), T0 + 99 * 60_000);
    const r2 = tick(r1.state, T0 + 100 * 60_000);
    assert.equal(r2.state, r1.state);
  });
});

describe('chat', () => {
  test('text: trimmed, appended with author/time/null url; allowed in every phase', () => {
    for (const s0 of [lobby(2), play(2), review(), ok(review(), 'h', { type: INTENT.showResults })]) {
      const s = ok(s0, 'p1', { type: INTENT.chatText, id: 'm1', text: '  hello  ' }, 4242);
      assert.deepEqual(s.chat.at(-1), { id: 'm1', playerId: 'p1', at: 4242, text: 'hello', url: null });
    }
  });
  test('text validation: empty / too long / not a string / missing id', () => {
    const s = lobby(2);
    bad(s, 'p1', { type: INTENT.chatText, id: 'm', text: '   ' }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.chatText, id: 'm', text: 'x'.repeat(CHAT_TEXT_MAX + 1) }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.chatText, id: 'm', text: 5 }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.chatText, text: 'hi' }, ERR.invalid);
    ok(s, 'p1', { type: INTENT.chatText, id: 'm', text: 'x'.repeat(CHAT_TEXT_MAX) });
  });
  test('link: with and without caption', () => {
    let s = lobby(2);
    s = ok(s, 'p1', { type: INTENT.chatLink, id: 'm1', url: GURL }, 10);
    assert.deepEqual(s.chat.at(-1), { id: 'm1', playerId: 'p1', at: 10, text: null, url: GURL });
    s = ok(s, 'p1', { type: INTENT.chatLink, id: 'm2', url: APPLE_LA, text: ' look ' }, 11);
    assert.deepEqual(s.chat.at(-1), { id: 'm2', playerId: 'p1', at: 11, text: 'look', url: APPLE_LA });
    s = ok(s, 'p1', { type: INTENT.chatLink, id: 'm3', url: APPLE_MAP, text: '   ' }, 12);
    assert.equal(s.chat.at(-1).text, null);
    bad(s, 'p1', { type: INTENT.chatLink, id: 'm4' }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.chatLink, id: 'm4', url: GURL, text: 'x'.repeat(CHAT_TEXT_MAX + 1) }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.chatLink, id: 'm4', url: GURL, text: 5 }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.chatLink, url: GURL }, ERR.invalid);   // missing id
  });
  test('link: allowed in every phase; duplicate id ignored; the old image-chat intent is gone', () => {
    for (const s0 of [lobby(2), play(2), review(), ok(review(), 'h', { type: INTENT.showResults })]) {
      const s = ok(s0, 'p1', { type: INTENT.chatLink, id: 'lk', url: GURL });
      assert.equal(s.chat.at(-1).url, GURL);
      const r = applyIntent(s, 'p1', { type: INTENT.chatLink, id: 'lk', url: APPLE_LA }, T0);
      assert.equal(r.state, s);
    }
    bad(lobby(2), 'p1', { type: 'chatImage', id: 'm', url: GURL }, ERR.invalid);
  });
  test('duplicate chat id is ignored', () => {
    const s = ok(lobby(2), 'p1', { type: INTENT.chatText, id: 'm1', text: 'a' });
    const r = applyIntent(s, 'p1', { type: INTENT.chatText, id: 'm1', text: 'b' }, T0);
    assert.equal(r.state, s);
    assert.equal(s.chat.length, 1);
  });
  test('history is trimmed to CHAT_HISTORY_MAX keeping the newest', () => {
    let s = lobby(2);
    for (let i = 0; i < CHAT_HISTORY_MAX + 5; i++) s = ok(s, 'p1', { type: INTENT.chatText, id: `m${i}`, text: `t${i}` });
    assert.equal(s.chat.length, CHAT_HISTORY_MAX);
    assert.equal(s.chat[0].id, 'm5');
    assert.equal(s.chat.at(-1).id, `m${CHAT_HISTORY_MAX + 4}`);
  });
});

describe('review: navigation', () => {
  test('reviewNext / reviewPrev are host-only, review-only and clamped (clamp = no-op, no rev bump)', () => {
    let s = review();
    const last = s.categories.length - 1;
    bad(s, 'p1', { type: INTENT.reviewNext }, ERR.forbidden);
    bad(s, 'p1', { type: INTENT.reviewPrev }, ERR.forbidden);
    bad(play(2), 'h', { type: INTENT.reviewNext }, ERR.wrongPhase);
    const r0 = applyIntent(s, 'h', { type: INTENT.reviewPrev }, T0);
    assert.equal(r0.error, null);
    assert.equal(r0.state, s);
    assert.equal(s.reviewIndex, 0);
    for (let i = 0; i < last; i++) s = ok(s, 'h', { type: INTENT.reviewNext });
    assert.equal(s.reviewIndex, last);
    const r1 = applyIntent(s, 'h', { type: INTENT.reviewNext }, T0);
    assert.equal(r1.state, s);
    s = ok(s, 'h', { type: INTENT.reviewPrev });
    assert.equal(s.reviewIndex, last - 1);
    assert.equal(reviewCategory(s).id, s.categories[last - 1].id);
  });
  test('showResults from any index; host only; review only', () => {
    let s = review();
    bad(s, 'p1', { type: INTENT.showResults }, ERR.forbidden);
    bad(play(2), 'h', { type: INTENT.showResults }, ERR.wrongPhase);
    s = ok(s, 'h', { type: INTENT.showResults });
    assert.equal(s.phase, PHASE.results);
    assert.equal(reviewCategory(s), null);
    bad(s, 'h', { type: INTENT.showResults }, ERR.wrongPhase);
  });
  test('reviewAgain: results -> review at index 0, ratings kept; host only; results only', () => {
    let s = review();
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 4 });
    s = ok(s, 'h', { type: INTENT.reviewNext });
    s = ok(s, 'h', { type: INTENT.showResults });
    bad(s, 'p1', { type: INTENT.reviewAgain }, ERR.forbidden);
    s = ok(s, 'h', { type: INTENT.reviewAgain });
    assert.equal(s.phase, PHASE.review);
    assert.equal(s.reviewIndex, 0);
    assert.equal(ratingOf(s, 'cat1', 'p2', 'p1'), 4);
    bad(s, 'h', { type: INTENT.reviewAgain }, ERR.wrongPhase);
  });
  test('playAgain: results -> lobby keeping players/categories/settings, clearing everything else', () => {
    let s = review();
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 4 });
    s = ok(s, 'p1', { type: INTENT.chatText, id: 'm', text: 'gg' });
    s = ok(s, 'h', { type: INTENT.showResults });
    bad(s, 'p1', { type: INTENT.playAgain }, ERR.forbidden);
    bad(review(), 'h', { type: INTENT.playAgain }, ERR.wrongPhase);
    const before = s;
    s = ok(s, 'h', { type: INTENT.playAgain });
    assert.equal(s.phase, PHASE.lobby);
    assert.deepEqual(s.players.map((p) => p.playerId), ['h', 'p1', 'p2']);
    assert.deepEqual(s.categories, before.categories);
    assert.deepEqual(s.settings, before.settings);
    assert.deepEqual(s.captures, {});
    assert.deepEqual(s.ratings, {});
    assert.deepEqual(s.chat, []);
    assert.deepEqual(s.suggestions, []);
    assert.equal(s.roundEndsAt, null);
    assert.equal(s.doneCountdownEndsAt, null);
    assert.equal(s.reviewIndex, 0);
    assert.ok(s.players.every((p) => !p.ready && !p.done));
    assert.equal(canStart(s), false);
    s = readyAll(s);
    assert.equal(canStart(s), true);
  });
  test('playAgain frees the seats of players who are away', () => {
    let s = review();
    s = leave(s, 'p2');
    s = ok(s, 'h', { type: INTENT.showResults });
    s = ok(s, 'h', { type: INTENT.playAgain });
    assert.deepEqual(s.players.map((p) => p.playerId), ['h', 'p1']);
  });
});

describe('review: rate', () => {
  test('sets ratings[cat][target][rater]; re-rating overwrites', () => {
    let s = review();
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 3 });
    assert.deepEqual(s.ratings, { cat1: { p2: { p1: 3 } } });
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 5 });
    assert.deepEqual(s.ratings, { cat1: { p2: { p1: 5 } } });
    s = ok(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 1 });
    assert.deepEqual(s.ratings.cat1.p2, { p1: 5, h: 1 });
  });
  test('same rating again is an idempotent no-op', () => {
    const s = ok(review(), 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 3 });
    const r = applyIntent(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 3 }, T0);
    assert.equal(r.state, s);
  });
  test('review phase only', () => {
    bad(play(3), 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 3 }, ERR.wrongPhase);
    const res = ok(review(), 'h', { type: INTENT.showResults });
    bad(res, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 3 }, ERR.wrongPhase);
  });
  test('categoryId must be the category under review', () => {
    let s = review();
    bad(s, 'p1', { type: INTENT.rate, categoryId: 'cat2', targetPlayerId: 'p2', stars: 3 }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.rate, categoryId: 'nope', targetPlayerId: 'p2', stars: 3 }, ERR.invalid);
    s = ok(s, 'h', { type: INTENT.reviewNext });
    bad(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 3 }, ERR.invalid);
  });
  test('stars must be an integer in 1..5 (or RATING_NO_FIT)', () => {
    const s = review();
    for (const stars of [6, -1, 0.5, 2.5, NaN, '3', '0', null, undefined, false, Infinity, -0.0001]) {
      bad(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars }, ERR.invalid);
    }
    for (const stars of [1, 2, 3, 4, 5]) ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars });
  });
  test('RATING_NO_FIT (0) is accepted, stored as 0 and can be switched with stars both ways', () => {
    assert.equal(RATING_NO_FIT, 0);
    let s = ok(review(), 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: RATING_NO_FIT });
    assert.equal(s.ratings.cat1.p2.p1, RATING_NO_FIT);
    assert.equal(ratingOf(s, 'cat1', 'p2', 'p1'), 0);
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 4 });
    assert.equal(s.ratings.cat1.p2.p1, 4);
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: RATING_NO_FIT });
    assert.equal(s.ratings.cat1.p2.p1, 0);
  });
  test('no-fit keeps every other rule: no self-rating, needs a capture, review phase only', () => {
    const s = review();
    bad(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p1', stars: RATING_NO_FIT }, ERR.forbidden);
    bad(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'ghost', stars: RATING_NO_FIT }, ERR.notFound);
    bad(play(3), 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: RATING_NO_FIT }, ERR.wrongPhase);
  });
  test('self-rating is forbidden (even for a player without a capture)', () => {
    const s = review();
    bad(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p1', stars: 5 }, ERR.forbidden);
    bad(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'h', stars: 5 }, ERR.forbidden);
  });
  test('target must have a capture for the category', () => {
    let s = play(3);
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'cat1', url: GURL });
    s = tick(s, s.roundEndsAt).state;
    bad(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 3 }, ERR.notFound);   // p2 has none
    bad(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'ghost', stars: 3 }, ERR.notFound);
    bad(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'constructor', stars: 3 }, ERR.notFound);
    ok(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p1', stars: 3 });
  });
});

describe('review: rating progress', () => {
  const rate = (s, who, target, stars = 3, cat = 'cat1') => ok(s, who, { type: INTENT.rate, categoryId: cat, targetPlayerId: target, stars });
  test('counts players who rated every other capture of the category', () => {
    let s = review();   // h, p1, p2 all captured cat1: everybody has two captures to rate
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 0, total: 3 });
    s = rate(s, 'p1', 'h');
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 0, total: 3 });   // p1 still owes p2
    s = rate(s, 'p1', 'p2');
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 1, total: 3 });
    s = rate(s, 'p2', 'h'); s = rate(s, 'p2', 'p1');
    s = rate(s, 'h', 'p1'); s = rate(s, 'h', 'p2');
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 3, total: 3 });
    s = rate(s, 'h', 'p1', 5);   // re-rating changes nothing
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 3, total: 3 });
  });
  test('a player without a capture still has to rate the others; the owner of the only capture has nothing to rate', () => {
    let s = play(3);
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'cat1', url: GURL });
    s = tick(s, s.roundEndsAt).state;
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 0, total: 2 });   // h and p2 rate p1; p1 has nothing to rate
    s = rate(s, 'h', 'p1');
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 1, total: 2 });
    s = rate(s, 'p2', 'p1');
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 2, total: 2 });
  });
  test('nothing submitted: 0 / 0; other categories are counted on their own', () => {
    const s = rate(review(), 'p1', 'h');
    assert.deepEqual(ratingProgress(s, 'cat2'), { done: 0, total: 0 });
    assert.deepEqual(ratingProgress(s, 'nope'), { done: 0, total: 0 });
  });
  test('away players are not counted (they cannot rate)', () => {
    let s = review();
    s = leave(s, 'p2');
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 0, total: 2 });
    s = rate(s, 'p1', 'h'); s = rate(s, 'p1', 'p2');
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 1, total: 2 });   // h still has to rate p1 and p2 (p2's capture stays)
  });
});

describe('scoring', () => {
  /** 3 players, 2 categories, all captured; ratings given via real intents. */
  function scored() {
    let s = play(3);
    for (const [pid, cat] of [['h', 'cat1'], ['p1', 'cat1'], ['p2', 'cat1'], ['h', 'cat2'], ['p1', 'cat2']]) {
      s = ok(s, pid, { type: INTENT.capture, captureId: `${pid}-${cat}`, categoryId: cat, url: GURL });   // p2 skips cat2
    }
    s = tick(s, s.roundEndsAt).state;
    const rate = (who, cat, target, stars) => { s = ok(s, who, { type: INTENT.rate, categoryId: cat, targetPlayerId: target, stars }); };
    rate('p1', 'cat1', 'h', 5); rate('p2', 'cat1', 'h', 4);     // h: 9
    rate('h', 'cat1', 'p1', 2); rate('p2', 'cat1', 'p1', 2);    // p1: 4
    rate('h', 'cat1', 'p2', 3); rate('p1', 'cat1', 'p2', 1);    // p2: 4
    s = ok(s, 'h', { type: INTENT.reviewNext });
    rate('p1', 'cat2', 'h', 1); rate('p2', 'cat2', 'h', 1);     // h: +2 = 11
    rate('h', 'cat2', 'p1', 5);                                  // p1: +5 = 9
    return s;
  }
  const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-5, `${msg ?? ''} expected ${expected}, got ${actual}`);
  // Raw stars given: h [2,3,5] (mean 10/3), p1 [5,1,1] (mean 7/3), p2 [4,2,1] (mean 7/3); each counts as stars - mean + 3.
  test('pointsOf sums every rating received, normalised per rater; missing capture scores 0', () => {
    const s = scored();
    near(pointsOf(s, 'h'), 41 / 3);    // p1 5 -> 17/3, p2 4 -> 14/3, p1 1 -> 5/3, p2 1 -> 5/3
    near(pointsOf(s, 'p1'), 9);        // h 2 -> 5/3, p2 2 -> 8/3, h 5 -> 14/3
    near(pointsOf(s, 'p2'), 13 / 3);   // nothing in cat2: no capture, no ratings
    assert.equal(pointsOf(s, 'nobody'), 0);
    assert.equal(pointsOf(play(3), 'h'), 0);
  });
  test('categoryScore: normalised points and rating count of one category', () => {
    const s = scored();
    const c = categoryScore(s, 'cat1', 'h');
    near(c.points, 17 / 3 + 14 / 3);
    assert.equal(c.count, 2);
    assert.deepEqual(categoryScore(s, 'cat2', 'p2'), { points: 0, count: 0, noFit: 0 });
  });
  test('every rater averages SCORE_MEAN: all points together = 3 per rating', () => {
    const s = scored();
    near(['h', 'p1', 'p2'].reduce((a, id) => a + pointsOf(s, id), 0), 3 * 9);
  });
  test('raterMeans: mean of all stars a rater gave over every category', () => {
    const m = raterMeans(scored());
    near(m.h, 10 / 3); near(m.p1, 7 / 3); near(m.p2, 7 / 3);
    assert.deepEqual(raterMeans(review()), {});
  });
  test('re-rating changes the sum (overwrite, not add) and the rater mean with it', () => {
    let s = scored();
    s = ok(s, 'h', { type: INTENT.reviewPrev });
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'h', stars: 1 });   // p1 now gives [1,1,1]: all count 3
    near(pointsOf(s, 'h'), 3 + 3 + 14 / 3 + 5 / 3);   // p1 3+3, p2 (mean 7/3) 4 -> 14/3, 1 -> 5/3
  });
  test('normalisation: a harsh rater (2 stars, one 4) counts the 2s as ~3 and the 4 as ~5', () => {
    const s = review();
    // p1 rates h and p2 in each of the categories: 13 x 2 stars and a single 4 stars (cat3 -> h)
    s.ratings = {};
    s.categories.forEach((c, i) => { s.ratings[c.id] = { h: { p1: i === 2 ? 4 : 2 }, p2: { p1: 2 } }; });
    const n = s.categories.length * 2;
    const mean = (2 * (n - 1) + 4) / n;
    near(raterMeans(s).p1, mean);
    near(categoryScore(s, 'cat1', 'p2').points, 2 - mean + 3);
    assert.ok(Math.abs(2 - mean + 3 - 3) < 0.25 && Math.abs(4 - mean + 3 - 5) < 0.25, '2 -> ~3, 4 -> ~5');
    near(categoryScore(s, 'cat3', 'h').points, 4 - mean + 3);
    near(pointsOf(s, 'h') + pointsOf(s, 'p2'), 3 * n);
  });
  test('normalisation: a rater who gives 1 star to everything counts everything as 3', () => {
    const s = review();
    s.ratings = { cat1: { h: { p1: 1 }, p2: { p1: 1 } }, cat2: { h: { p1: 1 } } };
    near(pointsOf(s, 'h'), 6);
    near(pointsOf(s, 'p2'), 3);
    assert.deepEqual(ranking(s).map((x) => x.playerId), ['h', 'p2', 'p1']);
  });
  test('normalisation: a rater with a single rating counts it as 3, whatever the stars', () => {
    for (const stars of [1, 3, 5]) {
      const s = ok(review(), 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars });
      near(pointsOf(s, 'p2'), 3);
      assert.deepEqual(categoryScore(s, 'cat1', 'p2'), { points: 3, count: 1, noFit: 0 });
    }
  });
  test('normalisation: mixed raters are shifted independently and a harsh 5 can beat a generous 5', () => {
    const s = review();
    // p1 (harsh): h 1, p2 5 -> mean 3. p2 (generous): h 5, p1 5 -> mean 5 (counts 3 each). h: p1 2, p2 4 -> mean 3.
    s.ratings = { cat1: { h: { p1: 1, p2: 5 }, p2: { p1: 5, h: 4 }, p1: { p2: 5, h: 2 } } };
    near(pointsOf(s, 'h'), (1 - 3 + 3) + 3);        // p1 -> 1, p2 -> 3
    near(pointsOf(s, 'p2'), (5 - 3 + 3) + (4 - 3 + 3));   // p1 -> 5, h -> 4
    near(pointsOf(s, 'p1'), 3 + (2 - 3 + 3));       // p2 -> 3, h -> 2
  });
  test('no clamping: a normalised rating may exceed 5 or drop below 0', () => {
    const s = review();
    s.ratings = { cat1: { h: { p1: 5 }, p2: { p1: 1 } }, cat2: { h: { p1: 1 }, p2: { p1: 1 } }, cat3: { h: { p1: 1 }, p2: { p1: 1 } }, cat4: { h: { p1: 1 }, p2: { p1: 1 } } };
    const m = (5 + 7) / 8;   // p1 gave 5 and seven 1s: mean 1.5
    near(categoryScore(s, 'cat1', 'h').points, 5 - m + 3);   // 6.5
    assert.ok(categoryScore(s, 'cat1', 'h').points > 5);
    s.ratings = { cat1: { h: { p1: 1 } }, cat2: { h: { p1: 5 } }, cat3: { h: { p1: 5 } }, cat4: { h: { p1: 5 } }, cat5: { h: { p1: 5 } } };
    near(categoryScore(s, 'cat1', 'h').points, 1 - 4.2 + 3);   // -0.2
    assert.ok(categoryScore(s, 'cat1', 'h').points < 0);
  });
  test('ranking: points descending with rank numbers', () => {
    const r = ranking(scored());
    assert.deepEqual(r.map((x) => [x.playerId, x.rank]), [['h', 1], ['p1', 2], ['p2', 3]]);
    near(r[0].points, 41 / 3); near(r[1].points, 9); near(r[2].points, 13 / 3);
  });
  test('ranking: ties keep join order and share a rank (1,1,3)', () => {
    let s = review();   // 3 players, nobody rated
    assert.deepEqual(ranking(s).map((x) => [x.playerId, x.rank]), [['h', 1], ['p1', 1], ['p2', 1]]);
    s = ok(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 5 });   // a lone rating counts as 3
    assert.deepEqual(ranking(s).map((x) => [x.playerId, x.points, x.rank]), [['p2', 3, 1], ['h', 0, 2], ['p1', 0, 2]]);
    s = ok(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p1', stars: 5 });   // h gave [5,5]: both count 3
    assert.deepEqual(ranking(s).map((x) => [x.playerId, x.points, x.rank]), [['p1', 3, 1], ['p2', 3, 1], ['h', 0, 3]]);   // p1 and p2 tie, join order p1 < p2
  });
  test("doesn't fit: 0 points, left out of the rater's mean (rater gives [2,2,NO_FIT,4] -> mean over [2,2,4])", () => {
    const s = review();
    s.ratings = { cat1: { h: { p1: 2 } }, cat2: { h: { p1: 2 } }, cat3: { h: { p1: RATING_NO_FIT } }, cat4: { h: { p1: 4 } } };
    near(raterMeans(s).p1, 8 / 3);
    near(categoryScore(s, 'cat1', 'h').points, 2 - 8 / 3 + 3);
    near(categoryScore(s, 'cat4', 'h').points, 4 - 8 / 3 + 3);
    assert.deepEqual(categoryScore(s, 'cat3', 'h'), { points: 0, count: 1, noFit: 1 });
    near(pointsOf(s, 'h'), 9);   // the three star ratings still average SCORE_MEAN (3 x 3), the no-fit adds 0
  });
  test("doesn't fit: a rater with only no-fits has no mean and everything scores 0", () => {
    const s = review();
    s.ratings = { cat1: { h: { p1: RATING_NO_FIT }, p2: { p1: RATING_NO_FIT } } };
    assert.deepEqual(raterMeans(s), {});
    assert.equal(pointsOf(s, 'h'), 0);
    assert.equal(pointsOf(s, 'p2'), 0);
  });
  test("doesn't fit does not shift anybody else's points: it only removes its own rating", () => {
    const base = review();
    base.ratings = { cat1: { h: { p1: 5 }, p2: { p1: 1 } } };
    const withNoFit = review();
    withNoFit.ratings = { cat1: { h: { p1: 5 }, p2: { p1: 1 } }, cat2: { h: { p1: RATING_NO_FIT } } };
    near(pointsOf(withNoFit, 'h'), pointsOf(base, 'h'));
    near(pointsOf(withNoFit, 'p2'), pointsOf(base, 'p2'));
  });
  test("doesn't fit counts as rated for ratingProgress and can be switched to stars", () => {
    let s = review();
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'h', stars: RATING_NO_FIT });
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 0, total: 3 });   // p1 still owes p2
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: RATING_NO_FIT });
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 1, total: 3 });
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 4 });
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 1, total: 3 });
  });
  /** 2 players, both captured cat1 and cat2, review at index 0. */
  function review2() {
    let s = play(2);
    for (const [pid, cat] of [['h', 'cat1'], ['p1', 'cat1'], ['h', 'cat2'], ['p1', 'cat2']]) {
      s = ok(s, pid, { type: INTENT.capture, captureId: `${pid}-${cat}`, categoryId: cat, url: GURL }, T0 + 1);
    }
    return tick(s, s.roundEndsAt).state;
  }
  test("doesn't fit is 0 points in a 2-player game too", () => {
    let s = review2();
    s = ok(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p1', stars: RATING_NO_FIT });
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'h', stars: 5 });
    assert.equal(pointsOf(s, 'p1'), 0);
    assert.equal(pointsOf(s, 'h'), 5);
    assert.deepEqual(ratingProgress(s, 'cat1'), { done: 2, total: 2 });
  });
  test('2 players: raw stars, no normalisation (the stars matter)', () => {
    let s = review2();
    assert.equal(normalizes(s), false);
    s = ok(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p1', stars: 5 });
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'h', stars: 2 });
    s = ok(s, 'h', { type: INTENT.reviewNext });
    s = ok(s, 'h', { type: INTENT.rate, categoryId: 'cat2', targetPlayerId: 'p1', stars: 1 });
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat2', targetPlayerId: 'h', stars: 2 });
    assert.equal(pointsOf(s, 'p1'), 6);   // 5 + 1 (normalised it would be 3 + 3)
    assert.equal(pointsOf(s, 'h'), 4);
    assert.deepEqual(categoryScore(s, 'cat1', 'p1'), { points: 5, count: 1, noFit: 0 });
    assert.deepEqual(ranking(s).map((x) => [x.playerId, x.points, x.rank]), [['p1', 6, 1], ['h', 4, 2]]);
  });
  test('3 players: the same kind of ratings are normalised per rater', () => {
    const s = review();
    assert.equal(normalizes(s), true);
    s.ratings = { cat1: { h: { p1: 5, p2: 1 } }, cat2: { h: { p1: 1 }, p2: { p1: 3 } } };   // p1 gave [5,1,3] (mean 3), p2 gave [1] (mean 1)
    near(pointsOf(s, 'h'), 5 + 1 + 3);   // p1's 5 and 1 stay (mean 3); p2's lone 1 counts 3. Raw stars would be 5 + 1 + 1
    near(pointsOf(s, 'p2'), 3);
  });
  test('the player count that switches normalisation includes away players (they stay in the list after the lobby)', () => {
    let s = review();
    s = leave(s, 'p2');
    assert.equal(s.players.length, 3);
    assert.equal(s.players[2].connected, false);
    assert.equal(normalizes(s), true);
  });
  test('formatPoints: one decimal, none when whole', () => {
    assert.equal(formatPoints(12), '12');
    assert.equal(formatPoints(12.5), '12.5');
    assert.equal(formatPoints(41 / 3), '13.7');
    assert.equal(formatPoints(4.04), '4');
    assert.equal(formatPoints(0), '0');
    assert.equal(formatPoints(-0.04), '0');
    assert.equal(formatPoints(-0.2), '-0.2');
  });
  test('points are derived: state has no points field', () => {
    assert.equal(JSON.stringify(scored()).includes('points'), false);
  });
});

describe('url validation', () => {
  const cap = (url, id = 'u1') => ({ type: INTENT.capture, captureId: id, categoryId: 'cat1', url });
  const goodUrls = [
    GURL, APPLE_LA, APPLE_MAP,
    'https://www.google.com/maps/@48.7784234,9.1799782,15z',
    'https://consent.google.com/m?continue=https%3A%2F%2Fwww.google.com%2Fmaps%2F%4048.7%2C9.1%2C15z',
  ];
  test('capture accepts Google Street View, Apple look-around, Apple map, consent urls', () => {
    goodUrls.forEach((url, i) => {
      const s = ok(play(3), 'p1', cap(url, `c${i}`));
      assert.equal(myCapture(s, 'p1', 'cat1').url, url);
    });
  });
  const badUrls = [
    ['http scheme', GURL.replace('https:', 'http:')],
    ['bare host', 'example.com'],
    ['bare allowed host', 'maps.apple.com'],
    ['other host', 'https://example.com/maps/@1,2,3z'],
    ['look-alike host', 'https://www.google.com.evil.example/maps/@1,2,3z'],
    ['not a maps path', 'https://www.google.com/search?q=x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['too long', GURL + 'a'.repeat(URL_MAX)],
    ['just over the cap', 'https://maps.apple.com/frame?z=' + '1'.repeat(URL_MAX - 'https://maps.apple.com/frame?z='.length + 1)],
    ['empty', ''],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['object', { href: GURL }],
    ['array', [GURL]],
  ];
  test('capture rejects everything else with ERR.invalid', () => {
    for (const [, url] of badUrls) bad(play(3), 'p1', cap(url), ERR.invalid);
    bad(play(3), 'p1', { type: INTENT.capture, captureId: 'u1', categoryId: 'cat1' }, ERR.invalid);   // no url at all
  });
  test('a url of exactly URL_MAX chars is accepted', () => {
    const base = 'https://maps.apple.com/frame?z=';
    const url = base + '1'.repeat(URL_MAX - base.length);
    assert.equal(url.length, URL_MAX);
    ok(play(3), 'p1', cap(url));
  });
  test('chatLink uses the same validation', () => {
    for (const [, url] of badUrls) bad(lobby(2), 'p1', { type: INTENT.chatLink, id: 'm', url }, ERR.invalid);
    for (const url of goodUrls) ok(lobby(2), 'p1', { type: INTENT.chatLink, id: 'm', url });
  });
  test('an invalid url on a duplicate captureId is still invalid (validated before the dedupe)', () => {
    const s = ok(play(3), 'p1', cap(GURL, 'dup'));
    bad(s, 'p1', cap('http://x', 'dup'), ERR.invalid);
  });
});

describe('stateFor (redaction)', () => {
  /** play: h, p1, p2 each captured cat1; p1 also cat2; chat link from p2 */
  function played() {
    let s = play(3);
    s = ok(s, 'h', { type: INTENT.capture, captureId: 'c-h', categoryId: 'cat1', url: GURL }, T0 + 1);
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'c-p1', categoryId: 'cat1', url: APPLE_LA }, T0 + 2);
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'c-p1b', categoryId: 'cat2', url: APPLE_MAP }, T0 + 3);
    s = ok(s, 'p2', { type: INTENT.capture, captureId: 'c-p2', categoryId: 'cat1', url: GURL + '1' }, T0 + 4);
    s = ok(s, 'p2', { type: INTENT.chatLink, id: 'lk', url: APPLE_LA, text: 'look' }, T0 + 5);
    return s;
  }
  const urls = (s) => Object.fromEntries(Object.entries(s.captures).map(([cat, per]) => [cat, Object.fromEntries(Object.entries(per).map(([pid, r]) => [pid, r.url]))]));

  test('play: own urls kept, everybody else null; refs and counts stay', () => {
    const s = played();
    const v = stateFor(s, 'p1');
    assert.deepEqual(urls(v), { cat1: { h: null, p1: APPLE_LA, p2: null }, cat2: { p1: APPLE_MAP } });
    assert.deepEqual(urls(stateFor(s, 'h')), { cat1: { h: GURL, p1: null, p2: null }, cat2: { p1: null } });
    assert.deepEqual(urls(stateFor(s, 'p2')), { cat1: { h: null, p1: null, p2: GURL + '1' }, cat2: { p1: null } });
    assert.deepEqual(urls(stateFor(s, 'stranger')), { cat1: { h: null, p1: null, p2: null }, cat2: { p1: null } });
    assert.deepEqual(v.captures.cat1.h, { captureId: 'c-h', playerId: 'h', categoryId: 'cat1', at: T0 + 1, url: null });
    assert.equal(Object.keys(v.captures.cat1).length, 3);
    assert.equal(myCapture(v, 'p1', 'cat2').captureId, 'c-p1b');
  });
  test('play: chat links are NOT redacted; everything else is unchanged', () => {
    const s = played();
    const v = stateFor(s, 'h');
    assert.deepEqual(v.chat, s.chat);
    assert.equal(v.chat[0].url, APPLE_LA);
    const { captures: _a, ...restV } = v; const { captures: _b, ...restS } = s;
    assert.deepEqual(restV, restS);
  });
  test('play: the input is not mutated, and the result shares no capture objects with it', () => {
    const s = played();
    const snapshot = structuredClone(s);
    const v = stateFor(s, 'p1');
    assert.deepEqual(s, snapshot);
    assert.notEqual(v, s);
    assert.notEqual(v.captures, s.captures);
    assert.equal(s.captures.cat1.h.url, GURL);
    assert.equal(s.captures.cat1.p1.url, APPLE_LA);
    v.captures.cat1.p1.url = 'tampered';
    assert.equal(s.captures.cat1.p1.url, APPLE_LA);
  });
  test('play: JSON round-trips (it is what goes on the wire)', () => {
    const v = stateFor(played(), 'p1');
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
  });
  test('play with no captures: still a valid copy', () => {
    assert.deepEqual(stateFor(play(3), 'p1').captures, {});
  });
  test('lobby / review / results: the very same object, urls visible', () => {
    const r = review();
    assert.equal(stateFor(r, 'p1'), r);
    assert.equal(r.captures.cat1.h.url, GURL);
    assert.equal(stateFor(r, 'nobody').captures.cat1.p1.url, GURL);
    const res = ok(r, 'h', { type: INTENT.showResults });
    assert.equal(stateFor(res, 'p2'), res);
    const l = lobby(2);
    assert.equal(stateFor(l, 'p1'), l);
  });
  test('the round ending (tick -> review) makes everything visible', () => {
    const s = played();
    assert.equal(stateFor(s, 'p1').captures.cat1.h.url, null);
    const rev = tick(s, s.roundEndsAt).state;
    assert.equal(rev.phase, PHASE.review);
    assert.equal(stateFor(rev, 'p1').captures.cat1.h.url, GURL);
  });
});

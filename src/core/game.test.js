import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE, ERR, SYSTEM, INTENT, HOST_INTENT, createInitialState, defaultProfile,
  MAX_PLAYERS, MAX_CATEGORIES, MAX_SUGGESTIONS, CATEGORY_LABEL_MAX, CHAT_TEXT_MAX, CHAT_HISTORY_MAX, DONE_COUNTDOWN_MS, NAME_MAX,
} from '../contracts.js';
import { applyIntent, allReady, allDone, canStart, startBlocker, myCapture, reviewCategory, pointsOf, ranking, ratingOf } from './index.js';

const T0 = 1_000_000;
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
  s = ok(s, 'p1', { type: INTENT.capture, captureId: 'img1', categoryId: 'cat1' }, T0 + 1);
  s = ok(s, 'p2', { type: INTENT.capture, captureId: 'img2', categoryId: 'cat1' }, T0 + 2);
  s = ok(s, 'h', { type: INTENT.capture, captureId: 'img3', categoryId: 'cat1' }, T0 + 3);
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
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'cat1' }, T0 + 10);
    assert.deepEqual(myCapture(s, 'p1', 'cat1'), { captureId: 'a', playerId: 'p1', categoryId: 'cat1', at: T0 + 10 });
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'b', categoryId: 'cat1' }, T0 + 20);
    assert.deepEqual(myCapture(s, 'p1', 'cat1'), { captureId: 'b', playerId: 'p1', categoryId: 'cat1', at: T0 + 20 });
    assert.equal(Object.keys(s.captures.cat1).length, 1);
    s = ok(s, 'p2', { type: INTENT.capture, captureId: 'c', categoryId: 'cat1' }, T0 + 30);
    assert.equal(myCapture(s, 'p1', 'cat1').captureId, 'b');
    assert.equal(myCapture(s, 'p2', 'cat1').captureId, 'c');
  });
  test('unknown category -> notFound; bad ids -> invalid; wrong phase', () => {
    const s = play(3);
    bad(s, 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'nope' }, ERR.notFound);
    bad(s, 'p1', { type: INTENT.capture, captureId: '', categoryId: 'cat1' }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.capture, captureId: 'a' }, ERR.invalid);
    bad(lobby(2), 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'cat1' }, ERR.wrongPhase);
    bad(review(), 'p1', { type: INTENT.capture, captureId: 'zz', categoryId: 'cat1' }, ERR.wrongPhase);
  });
  test('duplicate captureId is ignored (retry), even from another player', () => {
    let s = play(3);
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'cat1' });
    for (const [who, cat] of [['p1', 'cat1'], ['p2', 'cat1'], ['p1', 'cat2']]) {
      const r = applyIntent(s, who, { type: INTENT.capture, captureId: 'a', categoryId: cat }, T0 + 5);
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
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'x', categoryId: 'late' });   // and it can be captured
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
  test('text: trimmed, appended with author/time/null image; allowed in every phase', () => {
    for (const s0 of [lobby(2), play(2), review(), ok(review(), 'h', { type: INTENT.showResults })]) {
      const s = ok(s0, 'p1', { type: INTENT.chatText, id: 'm1', text: '  hello  ' }, 4242);
      assert.deepEqual(s.chat.at(-1), { id: 'm1', playerId: 'p1', at: 4242, text: 'hello', imageId: null });
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
  test('image: with and without caption', () => {
    let s = lobby(2);
    s = ok(s, 'p1', { type: INTENT.chatImage, id: 'm1', imageId: 'img' }, 10);
    assert.deepEqual(s.chat.at(-1), { id: 'm1', playerId: 'p1', at: 10, text: null, imageId: 'img' });
    s = ok(s, 'p1', { type: INTENT.chatImage, id: 'm2', imageId: 'img2', text: ' look ' }, 11);
    assert.equal(s.chat.at(-1).text, 'look');
    s = ok(s, 'p1', { type: INTENT.chatImage, id: 'm3', imageId: 'img3', text: '   ' }, 12);
    assert.equal(s.chat.at(-1).text, null);
    bad(s, 'p1', { type: INTENT.chatImage, id: 'm4' }, ERR.invalid);
    bad(s, 'p1', { type: INTENT.chatImage, id: 'm4', imageId: 'i', text: 'x'.repeat(CHAT_TEXT_MAX + 1) }, ERR.invalid);
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
  test('stars must be an integer in 1..5', () => {
    const s = review();
    for (const stars of [0, 6, -1, 2.5, NaN, '3', null, undefined, Infinity]) {
      bad(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars }, ERR.invalid);
    }
    for (const stars of [1, 2, 3, 4, 5]) ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars });
  });
  test('self-rating is forbidden (even for a player without a capture)', () => {
    const s = review();
    bad(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p1', stars: 5 }, ERR.forbidden);
    bad(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'h', stars: 5 }, ERR.forbidden);
  });
  test('target must have a capture for the category', () => {
    let s = play(3);
    s = ok(s, 'p1', { type: INTENT.capture, captureId: 'a', categoryId: 'cat1' });
    s = tick(s, s.roundEndsAt).state;
    bad(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 3 }, ERR.notFound);   // p2 has none
    bad(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'ghost', stars: 3 }, ERR.notFound);
    bad(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'constructor', stars: 3 }, ERR.notFound);
    ok(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p1', stars: 3 });
  });
});

describe('scoring', () => {
  /** 3 players, 2 categories, all captured; ratings given via real intents. */
  function scored() {
    let s = play(3);
    for (const [pid, cat] of [['h', 'cat1'], ['p1', 'cat1'], ['p2', 'cat1'], ['h', 'cat2'], ['p1', 'cat2']]) {
      s = ok(s, pid, { type: INTENT.capture, captureId: `${pid}-${cat}`, categoryId: cat });   // p2 skips cat2
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
  test('pointsOf sums every star received; missing capture scores 0', () => {
    const s = scored();
    assert.equal(pointsOf(s, 'h'), 11);
    assert.equal(pointsOf(s, 'p1'), 9);
    assert.equal(pointsOf(s, 'p2'), 4);   // nothing in cat2: no capture, no ratings
    assert.equal(pointsOf(s, 'nobody'), 0);
    assert.equal(pointsOf(play(3), 'h'), 0);
  });
  test('re-rating changes the sum (overwrite, not add)', () => {
    let s = scored();
    s = ok(s, 'h', { type: INTENT.reviewPrev });
    s = ok(s, 'p1', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'h', stars: 1 });
    assert.equal(pointsOf(s, 'h'), 11 - 5 + 1);
  });
  test('ranking: points descending with rank numbers', () => {
    const r = ranking(scored());
    assert.deepEqual(r.map((x) => [x.playerId, x.points, x.rank]), [['h', 11, 1], ['p1', 9, 2], ['p2', 4, 3]]);
  });
  test('ranking: ties keep join order and share a rank (1,1,3)', () => {
    let s = review();   // 3 players, nobody rated
    assert.deepEqual(ranking(s).map((x) => [x.playerId, x.rank]), [['h', 1], ['p1', 1], ['p2', 1]]);
    s = ok(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p2', stars: 5 });
    assert.deepEqual(ranking(s).map((x) => [x.playerId, x.points, x.rank]), [['p2', 5, 1], ['h', 0, 2], ['p1', 0, 2]]);
    s = ok(s, 'h', { type: INTENT.rate, categoryId: 'cat1', targetPlayerId: 'p1', stars: 5 });
    assert.deepEqual(ranking(s).map((x) => [x.playerId, x.rank]), [['p1', 1], ['p2', 1], ['h', 3]]);   // p1 and p2 tie, join order p1 < p2
  });
  test('points are derived: state has no points field', () => {
    assert.equal(JSON.stringify(scored()).includes('points'), false);
  });
});

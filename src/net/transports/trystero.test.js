import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, makeId, CHAT_HISTORY_MAX, CHAT_TEXT_MAX, MAX_CATEGORIES, MAX_PLAYERS, MAX_SUGGESTIONS, CATEGORY_LABEL_MAX, STARS_MAX } from '../../contracts.js';
import { JSON_MAX_BYTES } from './trystero.js';

const uuid = () => crypto.randomUUID();

/** worst legal snapshot: full room, all categories captured and rated by everybody, a full chat of maximum-width (3-byte) characters */
function worstCase(ch = '字') {
  const ids = Array.from({ length: MAX_PLAYERS }, uuid);
  const s = createInitialState({ playerId: ids[0], profile: { name: 'x' } }, 'GEO-7Q4K');
  s.players = ids.map((playerId, i) => ({ playerId, profile: { name: 'N'.repeat(14), color: 'coral', head: 'round', face: 'happy' }, isHost: i === 0, connected: true, ready: true, done: true }));
  s.categories = Array.from({ length: MAX_CATEGORIES }, () => ({ id: makeId(), label: ch.repeat(CATEGORY_LABEL_MAX) }));
  s.suggestions = Array.from({ length: MAX_SUGGESTIONS }, () => ({ id: makeId(), playerId: ids[1], label: ch.repeat(CATEGORY_LABEL_MAX), at: Date.now() }));
  for (const c of s.categories) {
    s.captures[c.id] = {}; s.ratings[c.id] = {};
    for (const p of ids) {
      s.captures[c.id][p] = { captureId: makeId(), playerId: p, categoryId: c.id, at: Date.now() };
      s.ratings[c.id][p] = Object.fromEntries(ids.filter((r) => r !== p).map((r) => [r, STARS_MAX]));
    }
  }
  s.chat = Array.from({ length: CHAT_HISTORY_MAX }, () => ({ id: makeId(), playerId: ids[1], at: Date.now(), text: ch.repeat(CHAT_TEXT_MAX), imageId: makeId() }));
  return { rev: 99999, now: Date.now(), state: s };
}

test('a worst-case full state snapshot fits the JSON action cap with room to spare', () => {
  const size = (o) => new TextEncoder().encode(JSON.stringify(o)).length;
  const cjk = size(worstCase()), ascii = size(worstCase('a'));
  console.log(`# worst-case snapshot: ${cjk} bytes (3-byte chars), ${ascii} bytes (ASCII); cap ${JSON_MAX_BYTES}`);
  assert.ok(cjk < JSON_MAX_BYTES / 3, `${cjk} bytes leaves less than 3x headroom under the ${JSON_MAX_BYTES} cap`);
});

/**
 * Geofinder core: the pure game-rules reducer. Only the HOST runs this; clients render the snapshots it produces.
 *
 *   applyIntent(state, actor, intent, now) -> { state, error }
 *
 *  - actor: a playerId, or SYSTEM (contracts.js) for HOST_INTENT.* (join / leave / tick), which ONLY SYSTEM may send.
 *  - error: one of ERR.* or null. On error `state` is the ORIGINAL object, untouched.
 *  - Success with a change: a NEW state object with rev + 1 (input never mutated). Success WITHOUT a change (idempotent
 *    setReady/setDone, a duplicate id, a tick with nothing due, reviewNext on the last category, ...): `error` null and
 *    the SAME input object, rev not bumped, so the host knows there is nothing to rebroadcast (`result.state !== state`).
 *  - Pure: no Date.now(), no Math.random(); time arrives as `now` (host clock, ms).
 *
 * Check order for a player intent: unknown type -> invalid; unknown actor -> forbidden; role (host-only) -> forbidden;
 * phase -> wrongPhase; payload -> invalid / notFound / limit; then the rule itself.
 *
 * Duplicate ids (suggestion, category, capture, chat): per contracts.js section 6 an id that already exists is IGNORED
 * (no-op, error null), so a retried intent on a lossy mesh is harmless. A same-id intent never overwrites anything.
 */
import {
  PHASE, INTENT, HOST_INTENT, ERR, SYSTEM,
  MAX_PLAYERS, MAX_CATEGORIES, MAX_SUGGESTIONS, CATEGORY_LABEL_MAX, CHAT_TEXT_MAX, CHAT_HISTORY_MAX, URL_MAX,
  ROUND_TIMES_MIN, DONE_COUNTDOWN_MS, STARS_MIN, STARS_MAX, RATING_NO_FIT, sanitizeProfile,
} from '../contracts.js';
import { isAllowedMapUrl } from '../../electron/allowlist.js';
import { allDone, allReviewReady, startBlocker } from './selectors.js';

const NOOP = Symbol('noop');   // handler result: valid, but nothing to change
const has = (o, k) => o != null && Object.hasOwn(o, k);
const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= 64 && x !== '__proto__';
/** a submitted map URL: string, <= URL_MAX, allowed map host (electron/allowlist.js) */
const isMapUrl = (x) => typeof x === 'string' && x.length > 0 && x.length <= URL_MAX && isAllowedMapUrl(x);
/** trimmed non-empty label <= CATEGORY_LABEL_MAX, else null */
const cleanLabel = (x) => {
  if (typeof x !== 'string') return null;
  const t = x.trim();
  return t.length >= 1 && t.length <= CATEGORY_LABEL_MAX ? t : null;
};

/** Start / cancel the all-done countdown to match the done flags (play phase only). Never resumes an old deadline. */
function syncCountdown(s, now) {
  if (s.phase !== PHASE.play) return;
  if (allDone(s)) { if (s.doneCountdownEndsAt == null) s.doneCountdownEndsAt = now + DONE_COUNTDOWN_MS; }
  else s.doneCountdownEndsAt = null;
}

/** Review: once every connected player is ready, move on at once (next category, or results after the last). Flags reset either way. */
function syncReviewReady(s) {
  if (s.phase !== PHASE.review || !allReviewReady(s)) return;
  if (s.reviewIndex >= s.categories.length - 1) s.phase = PHASE.results;
  else s.reviewIndex += 1;
  s.reviewReady = [];
}

/** Is the round over at `now`? (play phase, round timer or done countdown expired) */
export function roundDue(state, now) {
  return state.phase === PHASE.play
    && ((state.roundEndsAt != null && now >= state.roundEndsAt)
      || (state.doneCountdownEndsAt != null && now >= state.doneCountdownEndsAt));
}

// ---------- handlers: (s = mutable clone, c = { actor, intent, now }) -> ERR.* | NOOP | undefined ----------
// Each entry: { host?: true (host-only), phases?: [PHASE...] (allowed phases), run }.

const player = (s, id) => s.players.find((p) => p.playerId === id);
const categoryIdOf = (i) => i.categoryId ?? i.id;
const suggestionIdOf = (i) => i.suggestionId ?? i.id;

function addCategoryTo(s, id, label) {
  if (!isId(id)) return ERR.invalid;
  const l = cleanLabel(label);
  if (l === null) return ERR.invalid;
  if (s.categories.some((c) => c.id === id) || s.suggestions.some((x) => x.id === id)) return NOOP;
  if (s.categories.length >= MAX_CATEGORIES) return ERR.limit;
  s.categories.push({ id, label: l });
}

function chatPush(s, c, text, url) {
  if (!isId(c.intent.id)) return ERR.invalid;
  if (s.chat.some((m) => m.id === c.intent.id)) return NOOP;
  s.chat.push({ id: c.intent.id, playerId: c.actor, at: c.now, text, url });
  if (s.chat.length > CHAT_HISTORY_MAX) s.chat.splice(0, s.chat.length - CHAT_HISTORY_MAX);
}

const L = [PHASE.lobby];
const PLAYER_HANDLERS = {
  [INTENT.setProfile]: { phases: L, run: (s, { actor, intent }) => { player(s, actor).profile = sanitizeProfile(intent.profile); } },

  [INTENT.setReady]: {
    phases: L,
    run: (s, { actor, intent }) => {
      if (typeof intent.ready !== 'boolean') return ERR.invalid;
      player(s, actor).ready = intent.ready;
    },
  },

  [INTENT.suggestCategory]: {
    phases: L,
    run: (s, { actor, intent, now }) => {
      if (player(s, actor).isHost) return ERR.forbidden;
      if (!isId(intent.id)) return ERR.invalid;
      const label = cleanLabel(intent.label);
      if (label === null) return ERR.invalid;
      if (s.suggestions.some((x) => x.id === intent.id) || s.categories.some((c) => c.id === intent.id)) return NOOP;
      if (s.suggestions.length >= MAX_SUGGESTIONS) return ERR.limit;
      s.suggestions.push({ id: intent.id, playerId: actor, label, at: now });
    },
  },

  [INTENT.acceptSuggestion]: {
    host: true, phases: L,
    run: (s, { intent }) => {
      const i = s.suggestions.findIndex((x) => x.id === suggestionIdOf(intent));
      if (i < 0) return ERR.notFound;
      if (s.categories.length >= MAX_CATEGORIES) return ERR.limit;
      const [sug] = s.suggestions.splice(i, 1);
      if (s.categories.some((c) => c.id === sug.id)) return ERR.invalid;   // cannot happen (ids are unique across both lists)
      s.categories.push({ id: sug.id, label: sug.label });
    },
  },

  [INTENT.rejectSuggestion]: {
    host: true, phases: L,
    run: (s, { intent }) => {
      const i = s.suggestions.findIndex((x) => x.id === suggestionIdOf(intent));
      if (i < 0) return ERR.notFound;
      s.suggestions.splice(i, 1);
    },
  },

  [INTENT.addCategory]: {
    host: true, phases: [PHASE.lobby, PHASE.play],
    run: (s, { intent }) => {
      const r = addCategoryTo(s, intent.id, intent.label);
      if (r) return r;
      if (s.phase === PHASE.play) {   // new unfinished work: nobody is done any more
        for (const p of s.players) p.done = false;
        s.doneCountdownEndsAt = null;
      }
    },
  },

  [INTENT.removeCategory]: {
    host: true, phases: L,
    run: (s, { intent }) => {
      const i = s.categories.findIndex((c) => c.id === categoryIdOf(intent));
      if (i < 0) return ERR.notFound;
      s.categories.splice(i, 1);
    },
  },

  [INTENT.renameCategory]: {
    host: true, phases: L,
    run: (s, { intent }) => {
      const cat = s.categories.find((c) => c.id === categoryIdOf(intent));
      if (!cat) return ERR.notFound;
      const label = cleanLabel(intent.label);
      if (label === null) return ERR.invalid;
      cat.label = label;
    },
  },

  [INTENT.setRoundTime]: {
    host: true, phases: L,
    run: (s, { intent }) => {
      if (!ROUND_TIMES_MIN.includes(intent.minutes)) return ERR.invalid;
      s.settings.roundMinutes = intent.minutes;
    },
  },

  [INTENT.startGame]: {
    host: true, phases: L,
    run: (s, { now }) => {
      const blocked = startBlocker(s);
      if (blocked) return blocked;
      s.phase = PHASE.play;
      s.roundEndsAt = now + s.settings.roundMinutes * 60_000;
      s.doneCountdownEndsAt = null;
      s.suggestions = [];
      s.captures = {};
      s.ratings = {};
      s.reviewIndex = 0;
      s.reviewReady = [];
      for (const p of s.players) p.done = false;
    },
  },

  [INTENT.capture]: {
    phases: [PHASE.play],
    run: (s, { actor, intent, now }) => {
      if (!isId(intent.captureId) || !isId(intent.categoryId) || !isMapUrl(intent.url)) return ERR.invalid;
      if (!s.categories.some((c) => c.id === intent.categoryId)) return ERR.notFound;
      const dup = Object.values(s.captures).some((per) => Object.values(per).some((r) => r.captureId === intent.captureId));
      if (dup) return NOOP;
      if (!has(s.captures, intent.categoryId)) s.captures[intent.categoryId] = {};
      // The LAST capture replaces the earlier one (D10).
      s.captures[intent.categoryId][actor] = { captureId: intent.captureId, playerId: actor, categoryId: intent.categoryId, at: now, url: intent.url };
    },
  },

  [INTENT.setDone]: {
    phases: [PHASE.play],
    run: (s, { actor, intent, now }) => {
      if (typeof intent.done !== 'boolean') return ERR.invalid;
      player(s, actor).done = intent.done;
      syncCountdown(s, now);
    },
  },

  [INTENT.chatText]: {
    run: (s, c) => {
      if (typeof c.intent.text !== 'string') return ERR.invalid;
      const text = c.intent.text.trim();
      if (text.length < 1 || text.length > CHAT_TEXT_MAX) return ERR.invalid;
      return chatPush(s, c, text, null);
    },
  },

  [INTENT.chatLink]: {
    run: (s, c) => {
      if (!isMapUrl(c.intent.url)) return ERR.invalid;
      let text = null;
      if (c.intent.text != null) {
        if (typeof c.intent.text !== 'string') return ERR.invalid;
        text = c.intent.text.trim() || null;
        if (text !== null && text.length > CHAT_TEXT_MAX) return ERR.invalid;
      }
      return chatPush(s, c, text, c.intent.url);
    },
  },

  [INTENT.rate]: {
    phases: [PHASE.review],
    run: (s, { actor, intent }) => {
      const { categoryId, targetPlayerId: target, stars } = intent;
      if (categoryId !== s.categories[s.reviewIndex]?.id) return ERR.invalid;
      if (stars !== RATING_NO_FIT && (!Number.isInteger(stars) || stars < STARS_MIN || stars > STARS_MAX)) return ERR.invalid;
      if (target === actor) return ERR.forbidden;
      if (!has(s.captures[categoryId], target)) return ERR.notFound;
      if (!has(s.ratings, categoryId)) s.ratings[categoryId] = {};
      if (!has(s.ratings[categoryId], target)) s.ratings[categoryId][target] = {};
      s.ratings[categoryId][target][actor] = stars;   // re-rating overwrites
    },
  },

  // Everyone pressing Ready moves the review on (syncReviewReady); next / prev / showResults are the host's override.
  [INTENT.reviewReady]: {
    phases: [PHASE.review],
    run: (s, { actor, intent }) => {
      if (typeof intent.ready !== 'boolean') return ERR.invalid;
      s.reviewReady = s.reviewReady.filter((id) => id !== actor);
      if (intent.ready) s.reviewReady.push(actor);
      syncReviewReady(s);
    },
  },
  [INTENT.reviewNext]: {
    host: true, phases: [PHASE.review],
    run: (s) => { if (s.reviewIndex >= s.categories.length - 1) return NOOP; s.reviewIndex += 1; s.reviewReady = []; },
  },
  [INTENT.reviewPrev]: {
    host: true, phases: [PHASE.review],
    run: (s) => { if (s.reviewIndex <= 0) return NOOP; s.reviewIndex -= 1; s.reviewReady = []; },
  },
  [INTENT.showResults]: { host: true, phases: [PHASE.review], run: (s) => { s.phase = PHASE.results; s.reviewReady = []; } },
  [INTENT.reviewAgain]: { host: true, phases: [PHASE.results], run: (s) => { s.phase = PHASE.review; s.reviewIndex = 0; s.reviewReady = []; } },

  [INTENT.playAgain]: {
    host: true, phases: [PHASE.results],
    run: (s) => {
      s.phase = PHASE.lobby;
      // The lobby holds no away players (contract: frees seats); the host always stays.
      s.players = s.players.filter((p) => p.connected || p.isHost);
      for (const p of s.players) { p.ready = false; p.done = false; }
      s.captures = {}; s.chat = []; s.ratings = {}; s.suggestions = [];
      s.roundEndsAt = null; s.doneCountdownEndsAt = null; s.reviewIndex = 0; s.reviewReady = [];
    },
  },
};

const SYSTEM_HANDLERS = {
  [HOST_INTENT.join]: (s, { intent, now }) => {
    if (!isId(intent.playerId)) return ERR.invalid;
    const known = player(s, intent.playerId);
    if (known) {   // rejoin: same seat, keep ready/done
      known.connected = true;
      known.profile = sanitizeProfile(intent.profile);
      syncCountdown(s, now);
      return;
    }
    if (s.phase !== PHASE.lobby) return ERR.started;
    if (s.players.length >= MAX_PLAYERS) return ERR.full;
    s.players.push({ playerId: intent.playerId, profile: sanitizeProfile(intent.profile), isHost: false, connected: true, ready: false, done: false });
  },

  // The host leaving ends the game (session layer); core just marks it away and never removes the host seat.
  [HOST_INTENT.leave]: (s, { intent, now }) => {
    const p = player(s, intent.playerId);
    if (!p) return ERR.notFound;
    if (s.phase === PHASE.lobby && !p.isHost) {
      s.players = s.players.filter((x) => x !== p);
      s.suggestions = s.suggestions.filter((x) => x.playerId !== p.playerId);
    } else {
      p.connected = false;
      syncCountdown(s, now);   // a leave can complete "all done" (start) or, never, cancel it
      syncReviewReady(s);      // ... and can complete "all ready" in review
    }
  },

  [HOST_INTENT.tick]: (s, { now }) => {
    if (!roundDue(s, now)) return NOOP;
    s.phase = PHASE.review;
    s.reviewIndex = 0;
    s.reviewReady = [];
    s.roundEndsAt = null;
    s.doneCountdownEndsAt = null;
  },
};

/**
 * @param {import('../contracts.js').GameState} state
 * @param {string} actor  playerId, or SYSTEM
 * @param {import('../contracts.js').Intent} intent
 * @param {number} now  host clock, ms
 * @returns {{ state: import('../contracts.js').GameState, error: (string|null) }}
 */
export function applyIntent(state, actor, intent, now) {
  const fail = (error) => ({ state, error });
  const type = intent && typeof intent === 'object' ? intent.type : undefined;
  const sysHandler = typeof type === 'string' && has(SYSTEM_HANDLERS, type) ? SYSTEM_HANDLERS[type] : null;
  const plHandler = typeof type === 'string' && has(PLAYER_HANDLERS, type) ? PLAYER_HANDLERS[type] : null;
  if (!sysHandler && !plHandler) return fail(ERR.invalid);
  if (typeof now !== 'number' || !Number.isFinite(now)) return fail(ERR.invalid);

  if (sysHandler) {
    if (actor !== SYSTEM) return fail(ERR.forbidden);
    if (type === HOST_INTENT.tick && !roundDue(state, now)) return { state, error: null };   // cheap path, no clone
  } else {
    const me = state.players.find((p) => p.playerId === actor);
    if (!me) return fail(ERR.forbidden);
    if (plHandler.host && !me.isHost) return fail(ERR.forbidden);
    if (plHandler.phases && !plHandler.phases.includes(state.phase)) return fail(ERR.wrongPhase);
  }

  const s = structuredClone(state);
  const r = (sysHandler ?? plHandler.run)(s, { actor, intent, now });
  if (r === NOOP) return { state, error: null };
  if (r) return fail(r);
  if (JSON.stringify(s) === JSON.stringify(state)) return { state, error: null };   // idempotent no-op: no rev bump
  s.rev = state.rev + 1;
  return { state: s, error: null };
}

/**
 * Geofinder core selectors: pure, read-only views over a GameState. Safe to call from the UI on every render.
 * Points are DERIVED here (D10), never stored in state; ratings are normalised per rater in games of NORMALIZE_MIN_PLAYERS+ players
 * (see pointsOf); RATING_NO_FIT ("Doesn't fit") is always 0 points and ignored by the normalisation.
 */
import { MIN_PLAYERS, PHASE, ERR, SCORE_MEAN, RATING_NO_FIT, NORMALIZE_MIN_PLAYERS } from '../contracts.js';

const has = (o, k) => o != null && Object.hasOwn(o, k);

/** @param {import('../contracts.js').GameState} state @param {string} playerId */
export const getPlayer = (state, playerId) => state.players.find((p) => p.playerId === playerId) ?? null;
export const hostPlayer = (state) => state.players.find((p) => p.isHost) ?? null;
export const connectedPlayers = (state) => state.players.filter((p) => p.connected);

/** All CONNECTED players ready, and at least one connected player. */
export function allReady(state) {
  const c = connectedPlayers(state);
  return c.length > 0 && c.every((p) => p.ready);
}
/** All CONNECTED players done, and at least one connected player. */
export function allDone(state) {
  const c = connectedPlayers(state);
  return c.length > 0 && c.every((p) => p.done);
}

/** Review: has the player pressed Ready for the current category? */
export const isReviewReady = (state, playerId) => state.reviewReady.includes(playerId);
/** Review: how many CONNECTED players are ready for the current category. @returns {{ ready:number, total:number }} */
export function reviewReadyProgress(state) {
  const c = connectedPlayers(state);
  return { ready: c.filter((p) => isReviewReady(state, p.playerId)).length, total: c.length };
}
/** All CONNECTED players ready in review, and at least one connected player (what makes the reducer move on). */
export function allReviewReady(state) {
  const { ready, total } = reviewReadyProgress(state);
  return total > 0 && ready === total;
}

/** Why Start is currently impossible: ERR.tooFewPlayers | ERR.noCategories | ERR.notReady, or null when startable.
 *  Phase/host checks are NOT part of it (those are the caller's business); same order applyIntent(startGame) uses. */
export function startBlocker(state) {
  if (connectedPlayers(state).length < MIN_PLAYERS) return ERR.tooFewPlayers;
  if (state.categories.length < 1) return ERR.noCategories;
  if (!allReady(state)) return ERR.notReady;
  return null;
}
/** True when the lobby may start (use to enable the host's Start button). */
export const canStart = (state) => state.phase === PHASE.lobby && startBlocker(state) === null;

/** The player's CaptureRef for a category, or null. */
export function myCapture(state, playerId, categoryId) {
  return has(state.captures, categoryId) && has(state.captures[categoryId], playerId) ? state.captures[categoryId][playerId] : null;
}
/** All capture refs of a category as an array in player (join) order. */
export function capturesOf(state, categoryId) {
  return state.players.map((p) => myCapture(state, p.playerId, categoryId)).filter(Boolean);
}
/** Number of categories the player has a capture for. */
export const captureCount = (state, playerId) => state.categories.filter((c) => myCapture(state, playerId, c.id)).length;

/** The category being reviewed (review phase), or null outside review or when out of range. */
export function reviewCategory(state) {
  return state.phase === PHASE.review ? (state.categories[state.reviewIndex] ?? null) : null;
}

/** Stars `raterId` gave `targetId` for a category (RATING_NO_FIT = 0 for "Doesn't fit": test `!== null`, never truthiness), or null. */
export function ratingOf(state, categoryId, targetId, raterId) {
  const r = has(state.ratings, categoryId) && has(state.ratings[categoryId], targetId) ? state.ratings[categoryId][targetId] : null;
  return r && has(r, raterId) ? r[raterId] : null;
}
/** True when per-rater normalisation applies: the game has NORMALIZE_MIN_PLAYERS or more players. state.players is the right count: from
 *  'play' on a player who leaves stays (connected:false), so it cannot change mid-review. With 2 players each rater only rates the other one,
 *  so normalising would reduce every total to 3 x ratings; there points are the raw stars. */
export const normalizes = (state) => state.players.length >= NORMALIZE_MIN_PLAYERS;
/** Mean of ALL stars each rater gave in this game (every category), as { [raterId]: mean }. "Doesn't fit" ratings are not stars and are
 *  left out; raters without a star rating are absent. */
export function raterMeans(state) {
  const sum = {};
  const n = {};
  for (const perCat of Object.values(state.ratings))
    for (const perTarget of Object.values(perCat))
      for (const [rater, stars] of Object.entries(perTarget)) {
        if (stars === RATING_NO_FIT) continue;
        sum[rater] = (sum[rater] ?? 0) + stars; n[rater] = (n[rater] ?? 0) + 1;
      }
  return Object.fromEntries(Object.keys(sum).map((r) => [r, sum[r] / n[r]]));
}
const round6 = (x) => Math.round(x * 1e6) / 1e6;   // swallows float noise so equal scores really tie
/** What one rating is worth for scoring: 0 for "Doesn't fit"; else stars - the rater's mean + SCORE_MEAN (no clamping, so every rater
 *  averages SCORE_MEAN) when normalising, or the raw stars when not. */
const counted = (stars, mean, norm) => (stars === RATING_NO_FIT ? 0 : norm ? stars - mean + SCORE_MEAN : stars);
/** Points, count (all ratings, "Doesn't fit" included) and noFit (how many of them were "Doesn't fit") of the ratings a target received in
 *  one category, normalised per rater when the game is big enough (see pointsOf). `means` is optional (pass raterMeans(state) in a loop). */
export function categoryScore(state, categoryId, targetId, means = raterMeans(state)) {
  const r = has(state.ratings, categoryId) && has(state.ratings[categoryId], targetId) ? Object.entries(state.ratings[categoryId][targetId]) : [];
  const norm = normalizes(state);
  return {
    points: round6(r.reduce((a, [rater, stars]) => a + counted(stars, means[rater], norm), 0)),
    count: r.length,
    noFit: r.filter(([, stars]) => stars === RATING_NO_FIT).length,
  };
}

/** Total points of the player over all categories: every rating they RECEIVED (ratings[*][playerId][*]) counts as
 *  stars - raterMean + SCORE_MEAN, where raterMean is the mean of all stars that rater gave in the whole game (games with
 *  NORMALIZE_MIN_PLAYERS+ players; smaller games count the raw stars). "Doesn't fit" always counts 0. Fractional.
 *  A missing capture has no ratings => 0. */
export function pointsOf(state, playerId, means = raterMeans(state)) {
  const norm = normalizes(state);
  let sum = 0;
  for (const perCat of Object.values(state.ratings)) {
    if (!has(perCat, playerId)) continue;
    for (const [rater, stars] of Object.entries(perCat[playerId])) sum += counted(stars, means[rater], norm);
  }
  return round6(sum);
}

/** Points for display: rounded to one decimal, no ".0" when whole (12, 12.5). */
export const formatPoints = (points) => String(Number(points.toFixed(1)) + 0);   // + 0 turns -0 into 0

/** How many captures of a category `playerId` still has to rate (others' captures without a rating from them). */
export function unratedCount(state, categoryId, playerId) {
  return state.players.filter((p) => p.playerId !== playerId && myCapture(state, p.playerId, categoryId)
    && ratingOf(state, categoryId, p.playerId, playerId) === null).length;
}

/** Review progress of one category: how many players have finished rating it.
 *  A player NEEDS to rate when they are connected and at least one OTHER player has a capture in the category (self-rating is
 *  forbidden, a missing capture has nothing to rate). They are DONE when they rated every one of those captures ("Doesn't fit" is a rating).
 *  @returns {{ done:number, total:number }} e.g. { done:2, total:3 } for "2 / 3 rated" */
export function ratingProgress(state, categoryId) {
  const owners = state.players.filter((p) => myCapture(state, p.playerId, categoryId)).map((p) => p.playerId);
  let done = 0;
  let total = 0;
  for (const p of connectedPlayers(state)) {
    const targets = owners.filter((id) => id !== p.playerId);
    if (!targets.length) continue;
    total++;
    if (targets.every((t) => ratingOf(state, categoryId, t, p.playerId) !== null)) done++;
  }
  return { done, total };
}

/** Players sorted by points descending. Ties keep join order (stable) and SHARE a rank (competition ranking 1,1,3).
 *  @returns {{ player:object, playerId:string, points:number, rank:number }[]} */
export function ranking(state) {
  const means = raterMeans(state);
  const rows = state.players.map((player) => ({ player, playerId: player.playerId, points: pointsOf(state, player.playerId, means), rank: 0 }));
  rows.sort((a, b) => b.points - a.points);   // Array.prototype.sort is stable
  rows.forEach((r, i) => { r.rank = i > 0 && r.points === rows[i - 1].points ? rows[i - 1].rank : i + 1; });
  return rows;
}

/** What `viewerId` may see. During PHASE.play every capture the viewer does not own gets `url: null` (no peeking while the game
 *  runs; the refs stay, so "who found it" counts still work). Every other phase returns `state` itself (same object).
 *  Chat links are never redacted. Pure: returns a copy, never mutates the input. The host sends each player stateFor(state, thatPlayerId). */
export function stateFor(state, viewerId) {
  if (state.phase !== PHASE.play) return state;
  const captures = {};
  for (const [catId, perPlayer] of Object.entries(state.captures)) {
    captures[catId] = {};
    for (const [pid, ref] of Object.entries(perPlayer)) captures[catId][pid] = pid === viewerId ? { ...ref } : { ...ref, url: null };
  }
  return { ...state, captures };
}

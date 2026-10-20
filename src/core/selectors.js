/**
 * Geofinder core selectors: pure, read-only views over a GameState. Safe to call from the UI on every render.
 * Points are DERIVED here (D10), never stored in state.
 */
import { MIN_PLAYERS, PHASE, ERR } from '../contracts.js';

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

/** Stars `raterId` gave `targetId` for a category, or null. */
export function ratingOf(state, categoryId, targetId, raterId) {
  const r = has(state.ratings, categoryId) && has(state.ratings[categoryId], targetId) ? state.ratings[categoryId][targetId] : null;
  return r && has(r, raterId) ? r[raterId] : null;
}
/** Sum and count of the stars a target received in one category. */
export function categoryScore(state, categoryId, targetId) {
  const r = has(state.ratings, categoryId) && has(state.ratings[categoryId], targetId) ? Object.values(state.ratings[categoryId][targetId]) : [];
  return { points: r.reduce((a, b) => a + b, 0), count: r.length };
}

/** Total stars the player RECEIVED over all categories (ratings[*][playerId][*]). A missing capture has no ratings => 0. */
export function pointsOf(state, playerId) {
  let sum = 0;
  for (const perCat of Object.values(state.ratings)) {
    if (!has(perCat, playerId)) continue;
    for (const s of Object.values(perCat[playerId])) sum += s;
  }
  return sum;
}

/** Players sorted by points descending. Ties keep join order (stable) and SHARE a rank (competition ranking 1,1,3).
 *  @returns {{ player:object, playerId:string, points:number, rank:number }[]} */
export function ranking(state) {
  const rows = state.players.map((player) => ({ player, playerId: player.playerId, points: pointsOf(state, player.playerId), rank: 0 }));
  rows.sort((a, b) => b.points - a.points);   // Array.prototype.sort is stable
  rows.forEach((r, i) => { r.rank = i > 0 && r.points === rows[i - 1].points ? rows[i - 1].rank : i + 1; });
  return rows;
}

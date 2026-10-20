// LOCAL replica of the host's start check (D9). I4's core `canStart(state)` is the authority; I8 may swap this for it.
// Keep it in ONE function. Only affects whether the Start button is enabled; the host re-checks on startGame.
import { MIN_PLAYERS } from '../../contracts.js';

/**
 * @param {import('../../contracts.js').GameState} state
 * @returns {{ ok:boolean, reason:(string|null), ready:number, total:number }}  total = connected players, ready = connected AND ready
 */
export function canStart(state) {
  const connected = state.players.filter((p) => p.connected);
  const ready = connected.filter((p) => p.ready).length;
  const total = connected.length;
  let reason = null;
  if (total < MIN_PLAYERS) reason = `Need at least ${MIN_PLAYERS} players to start`;
  else if (state.categories.length < 1) reason = 'Add at least one category to start';
  else if (ready < total) reason = `Waiting for everyone to be ready (${ready}/${total})`;
  return { ok: reason === null, reason, ready, total };
}

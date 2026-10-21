/**
 * Geofinder UI kit. Re-exports every shared widget; importing this module also pulls in kit.css.
 * The global theme (src/styles/theme.css) must be imported once by the app entry.
 *
 * SCREEN MODULE CONVENTION (profile/lobby by I6, play/review/results by I7, wiring by I8)
 * -------------------------------------------------------------------------------------------------
 *   // each in-game screen: createXScreen(ctx) -> { el, render(view), destroy() }
 *   // ctx  = { send(intent), ...screen-specific callbacks }   // send() returns nothing; errors come back via view
 *   // view = { state: GameState, meId: string, clockOffset: number }
 *   // render() is called on every new snapshot and must be cheap and idempotent (patches in place; never loses input focus/text)
 *   // destroy() removes timers/listeners; the caller removes `el` from the DOM.
 *
 *   // The Profile screen is local and exists before any state does:
 *   createProfileScreen({ initial: Profile, onCreate(profile), onJoin(profile, roomCode) }) -> { el, destroy() }
 *   //   profile = sanitized Profile (name non-empty); roomCode = canonical 'GEO-XXXX' (normalizeRoomCode).
 *   createLobbyScreen({ send, onLeave? }) -> { el, render(view), destroy() }
 *
 * Intents are plain objects { type: INTENT.x, ...payload } exactly as typed in src/contracts.js
 * (e.g. { type:'acceptSuggestion', suggestionId } and { type:'removeCategory', categoryId }).
 * A screen `el` is a <section class="screen"> (16 px padding, full width; profile/lobby/results are capped to 1280 px and centred
 * via [data-screen], any other screen can opt in with class `narrow`).
 * -------------------------------------------------------------------------------------------------
 */
import './kit.css';

export { makeId } from '../../contracts.js';
export { h, append } from './dom.js';
export { avatar, avatarSvg, colorHex } from './avatar.js';
export {
  button, iconButton, card, tag, playerChip, playerList, statusPill,
  segmented, starRating, formatClock, timerReadout, timerBox, showToast,
} from './components.js';

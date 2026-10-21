// Preview harness for the UI screens (no app, no network). Intents are only logged (console + #pv-log); state never changes by itself.
import '../../styles/theme.css';
import { createInitialState } from '../../contracts.js';
import { createProfileScreen } from '../profile/profileScreen.js';
import { createLobbyScreen } from '../lobby/lobbyScreen.js';
import { button, h, timerBox, starRating, segmented, showToast } from './index.js';

const logEl = document.getElementById('pv-log');
const log = (what, data) => {
  const line = `${what} ${data === undefined ? '' : JSON.stringify(data)}`;
  console.log('[preview]', line);
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
};
const send = (intent) => log('intent', intent);

const LOOKS = [
  ['Mo', 'coral', 'round', 'happy'], ['Lena', 'sky', 'square', 'cool'], ['Jonas', 'mint', 'hex', 'wink'],
  ['Sofia', 'violet', 'wide', 'oh'], ['Tim', 'orange', 'dome', 'sleepy'],
];
const pid = (i) => `p${i}`;

/** Lobby GameState with `n` players (index 0 = host), `ready` = indices that are ready, optional extras. */
function lobbyState({ n = 5, ready = [], away = [], suggestions = 0, minutes = 15, categories } = {}) {
  const s = createInitialState({ playerId: pid(0), profile: { name: LOOKS[0][0], color: LOOKS[0][1], head: LOOKS[0][2], face: LOOKS[0][3] } }, 'GEO-7Q4K');
  for (let i = 1; i < n; i++) {
    const [name, color, head, face] = LOOKS[i];
    s.players.push({ playerId: pid(i), profile: { name, color, head, face }, isHost: false, connected: true, ready: false, done: false });
  }
  s.players.forEach((p, i) => { p.ready = ready.includes(i); p.connected = !away.includes(i); });
  s.settings.roundMinutes = minutes;
  if (categories) s.categories = categories;
  const sug = ['a swimming pool with a slide', 'a tennis court', 'a barn with a red roof'];
  for (let i = 0; i < suggestions; i++) s.suggestions.push({ id: `s${i}`, playerId: pid(1 + (i % (n - 1))), label: sug[i % 3], at: 0 });
  return s;
}

const SCENARIOS = {
  'lobby-host-waiting': { label: 'Host: some ready', meId: pid(0), state: () => lobbyState({ ready: [1, 2, 3], suggestions: 3 }) },
  'lobby-host-ready': { label: 'Host: all ready (Start enabled)', meId: pid(0), state: () => lobbyState({ ready: [0, 1, 2, 3, 4] }) },
  'lobby-host-away': { label: 'Host: disconnected player', meId: pid(0), state: () => lobbyState({ ready: [0, 1, 3], away: [2], suggestions: 2 }) },
  'lobby-host-alone': { label: 'Host: alone, no categories', meId: pid(0), state: () => lobbyState({ n: 1, ready: [0], categories: [] }) },
  'lobby-player-waiting': { label: 'Player: suggestions pending', meId: pid(3), state: () => lobbyState({ ready: [1, 2], suggestions: 3 }) },
  'lobby-player-ready': { label: 'Player: everyone ready', meId: pid(1), state: () => lobbyState({ ready: [0, 1, 2, 3, 4], minutes: 20 }) },
};

const nav = document.getElementById('pv-nav');
const stage = document.getElementById('pv-stage');
let current = null;

function show(key) {
  current?.destroy();
  stage.replaceChildren();
  logEl.textContent = '';
  history.replaceState(null, '', `#${key}`);
  [...nav.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === key)));
  if (key === 'profile') {
    current = createProfileScreen({
      initial: { name: '', color: 'sky', head: 'hex', face: 'cool' },
      onCreate: (p) => log('onCreate', p),
      onJoin: (p, code) => log('onJoin', { profile: p, code }),
    });
  } else if (key === 'widgets') {
    const t = timerBox(Date.now() + 872_000, 0);
    const stars = starRating({ value: 3, onRate: (n) => { log('rate', n); stars.set({ value: n }); } });
    const off = starRating({ value: 2, disabled: true });
    const seg = segmented({ label: 'Map provider', options: [{ value: 'g', label: 'Google Maps' }, { value: 'a', label: 'Apple Maps' }], value: 'g', onChange: (v) => log('provider', v) });
    const wrap = h('div', { class: 'screen narrow', style: 'display:flex;flex-direction:column;gap:18px;align-items:flex-start' },
      t.el, stars.el, off.el, seg.el, button({ label: 'Toast', onClick: () => showToast('Hello from the kit') }));
    current = { el: wrap, destroy: () => t.destroy() };
  } else {
    const sc = SCENARIOS[key];
    const lobby = createLobbyScreen({ send, onLeave: () => log('onLeave') });
    lobby.render({ state: sc.state(), meId: sc.meId, clockOffset: 0 });
    current = lobby;
  }
  stage.append(current.el);
}

const entries = [['profile', 'Profile'], ...Object.entries(SCENARIOS).map(([k, v]) => [k, v.label]), ['widgets', 'Widgets']];
for (const [key, label] of entries) {
  nav.append(button({ label, size: 'sm', onClick: () => show(key) }));
  nav.lastChild.dataset.key = key;
}
const start = location.hash.slice(1);
show(entries.some(([k]) => k === start) ? start : 'profile');

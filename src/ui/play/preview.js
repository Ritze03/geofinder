// Preview harness for the Play screen (no app, no network, no webview). send/onCapture/onShare are only logged (console + #pv-log);
// state never changes by itself. For scripted tests: window.__pv = { calls, map, screen, scenario, state, render(state) }.
import '../../styles/theme.css';
import '../../map/mapPanel.css';   // the real map panel CSS, so the hidden .map-bar rule is exercised
import { createInitialState } from '../../contracts.js';
import { button } from '../kit/index.js';
import { createPlayScreen } from './playScreen.js';

const logEl = document.getElementById('pv-log');
const calls = [];
const log = (what, data) => {
  const line = `${what} ${data === undefined ? '' : JSON.stringify(data)}`;
  console.log('[preview]', line);
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
};
const rec = (kind) => (a) => { calls.push({ kind, arg: a }); log(kind, a); };

// ---- stub map: same markup shape as createMapPanel() (panel > .map-bar + view), a fake street scene instead of a webview ----
function createStubMap() {
  const element = document.createElement('div');
  element.className = 'map-panel';
  const bar = document.createElement('div');
  bar.className = 'map-bar';
  bar.textContent = 'STUB map-bar (must be hidden on the Play screen)';
  const viewEl = document.createElement('div');
  viewEl.className = 'map-view';
  viewEl.style.cssText = 'position:relative;overflow:hidden;background:linear-gradient(#8cc3ee 0 38%,#6f7d6a 38% 55%,#3b3f46 55%);display:grid;place-items:center;color:#fff;font:700 18px system-ui;text-shadow:0 1px 6px #000a';
  const label = document.createElement('div');
  viewEl.append(label);
  element.append(bar, viewEl);
  const api = {
    element,
    show(p) { label.textContent = `STUB ${p === 'apple' ? 'Apple Maps' : 'Google Maps'} (street view placeholder)`; calls.push({ kind: 'map.show', arg: p }); log('map.show', p); },
  };
  api.show('google');
  return api;
}

// ---- fake images: small JPEG data URLs drawn on a canvas, deterministic per id ----
const cache = new Map();
function fakeImage(seed) {
  if (cache.has(seed)) return cache.get(seed);
  let n = 0;
  for (const ch of seed) n = Math.imul(n ^ ch.charCodeAt(0), 2654435761) >>> 0;
  n = (n ^ (n >>> 15)) >>> 0;
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const g = c.getContext('2d');
  const hue = (n >>> 3) % 360;
  g.fillStyle = `hsl(${hue} 45% 62%)`; g.fillRect(0, 0, 320, 110);
  g.fillStyle = `hsl(${(hue + 40) % 360} 35% 36%)`; g.fillRect(0, 110, 320, 90);
  g.fillStyle = '#3b3f46'; g.fillRect(0, 140, 320, 60);
  for (let i = 0; i < 5; i++) { g.fillStyle = `hsl(${(hue + 20 * i) % 360} 30% ${40 + i * 6}%)`; g.fillRect(((n >> i) % 200) + i * 20, 60 + (i % 3) * 14, 40 + (i * 7) % 30, 60); }
  g.fillStyle = '#fff'; g.font = '700 16px system-ui'; g.fillText(seed.slice(0, 24), 10, 190);
  const url = c.toDataURL('image/jpeg', 0.6);
  cache.set(seed, url);
  return url;
}

// ---- fake game state ----
const LOOKS = [
  ['Mo', 'coral', 'round', 'happy'], ['Lena', 'sky', 'square', 'cool'], ['Jonas', 'mint', 'hex', 'wink'],
  ['Sofia', 'violet', 'wide', 'oh'], ['Tim', 'orange', 'dome', 'sleepy'],
];
const pid = (i) => `p${i}`;
const T0 = Date.now();

/** caps: { [playerIdx]: [categoryIdx,...] }; chat: [[playerIdx, text|null, imageId?], ...]. */
function playState({ n = 5, done = [], away = [], caps = {}, chat = [], roundLeftS = 14 * 60 + 32, countdownS = null, extraCats = 0 } = {}) {
  const s = createInitialState({ playerId: pid(0), profile: { name: LOOKS[0][0], color: LOOKS[0][1], head: LOOKS[0][2], face: LOOKS[0][3] } }, 'GEO-7Q4K');
  for (let i = 1; i < n; i++) {
    const [name, color, head, face] = LOOKS[i];
    s.players.push({ playerId: pid(i), profile: { name, color, head, face }, isHost: false, connected: true, ready: false, done: false });
  }
  s.players.forEach((p, i) => { p.done = done.includes(i); p.connected = !away.includes(i); });
  for (let i = 0; i < extraCats; i++) s.categories.push({ id: `x${i}`, label: ['a lighthouse by the sea', 'a stadium with a red running track'][i % 2] });
  s.phase = 'play';
  s.rev = 7;
  s.roundEndsAt = Date.now() + roundLeftS * 1000;
  s.doneCountdownEndsAt = countdownS == null ? null : Date.now() + countdownS * 1000;
  for (const [pi, cats] of Object.entries(caps)) {
    for (const ci of cats) {
      const cat = s.categories[ci];
      (s.captures[cat.id] ||= {})[pid(pi)] = { captureId: `cap-${cat.id}-${pid(pi)}`, playerId: pid(pi), categoryId: cat.id, at: T0 };
    }
  }
  s.chat = chat.map((c, i) => ({ id: `m${i}`, playerId: pid(c[0]), at: T0 + i, text: c[1] ?? null, imageId: c[2] ?? null }));
  return s;
}

const CHAT_MIX = [
  [1, 'Anyone found the heart pool yet?'], [2, 'Not yet, checking the Riviera'], [0, 'Look at this one'],
  [0, 'is this a football pitch?', 'chat-pitch'], [3, null, 'chat-sofia'], [4, 'nice! that roof is huge'],
  [1, 'This is a really long message to check that it wraps nicely in the narrow chat column and does not overflow or break the layout in any way whatsoever.'],
];
const LONG_CHAT = Array.from({ length: 24 }, (_, i) => (i % 5 === 3 ? [i % 5, `look #${i}`, `chat-${i}`] : [i % 5, `message number ${i}`]));

const SCENARIOS = {
  host: { label: 'Host', meId: pid(0), state: () => playState({ done: [1], caps: { 0: [0, 2], 1: [0, 1], 2: [0], 3: [3] }, chat: CHAT_MIX.slice(0, 5) }) },
  player: { label: 'Player', meId: pid(2), state: () => playState({ done: [0, 1], caps: { 0: [0], 2: [1], 1: [1, 4] }, chat: CHAT_MIX.slice(0, 2) }) },
  captures: { label: 'Captures (own + others)', meId: pid(1), state: () => playState({ done: [2], caps: { 0: [0, 1, 2, 3, 4, 5], 1: [0, 1, 2, 3, 4, 5], 2: [0, 1, 3], 3: [0, 5], 4: [0, 1] }, chat: CHAT_MIX.slice(0, 4) }) },
  missing: { label: 'Missing images', meId: pid(0), state: () => playState({ caps: { 0: [0, 1], 1: [0, 1], 2: [0] }, chat: [[1, 'sending my screenshot', 'chat-pending'], [2, null, 'chat-missing']] }), missing: ['cap-cat2-p0', 'cap-cat1-p1', 'chat-missing', 'chat-pending'], late: ['chat-pending'] },
  countdown: { label: 'Done countdown', meId: pid(0), state: () => playState({ n: 4, done: [0, 1, 2, 3], caps: { 0: [0, 1, 2], 1: [0, 1], 2: [0, 2, 3], 3: [1] }, countdownS: 42 }) },
  low: { label: 'Round time low', meId: pid(3), state: () => playState({ done: [1], caps: { 0: [0], 3: [0, 1, 2] }, roundLeftS: 37 }) },
  chat: { label: 'Chat (long)', meId: pid(0), state: () => playState({ caps: { 0: [0] }, chat: LONG_CHAT }) },
  away: { label: 'Disconnected player', meId: pid(0), state: () => playState({ done: [1], away: [2, 4], caps: { 0: [0], 1: [0, 1], 2: [2], 4: [1] }, chat: CHAT_MIX.slice(0, 2), extraCats: 2 }) },
};

const nav = document.getElementById('pv-nav');
const stage = document.getElementById('pv-stage');
let screen = null;

function show(key) {
  if (!SCENARIOS[key]) key = 'host';
  const sc = SCENARIOS[key];
  screen?.destroy();
  stage.replaceChildren();
  logEl.textContent = '';
  calls.length = 0;
  history.replaceState(null, '', `#${key}`);
  [...nav.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === key)));

  const born = Date.now();
  const imageUrl = (id) => {
    if (!id) return null;
    if (sc.missing?.includes(id)) {
      // 'late' ones arrive after 4 s (tests the placeholder re-check); the others never arrive
      if (!(sc.late?.includes(id) && Date.now() - born > 4000)) return null;
    }
    return fakeImage(id);
  };
  const map = createStubMap();
  screen = createPlayScreen({ send: rec('send'), map, onCapture: rec('onCapture'), onShare: rec('onShare') });
  stage.append(screen.el);
  const view = (state) => ({ state, meId: sc.meId, clockOffset: 0, imageUrl });
  const state = sc.state();
  screen.render(view(state));
  window.__pv = { calls, map, screen, scenario: key, state, render(s) { window.__pv.state = s; screen.render(view(s)); } };
}

for (const [key, sc] of Object.entries(SCENARIOS)) {
  nav.append(button({ label: sc.label, size: 'sm', onClick: () => show(key) }));
  nav.lastChild.dataset.key = key;
}
show(location.hash.slice(1));

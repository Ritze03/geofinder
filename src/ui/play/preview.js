// Preview harness for the Play screen (no app, no network, no webview). send/onCapture/onShare are only logged (console + #pv-log);
// state never changes by itself. The map and the chat-link viewer are stubs that display the url they were given.
// For scripted tests: window.__pv = { calls, map, createViewer, screen, scenario, meId, state, urls, render(state) }.
// Fake states are redacted like the host does (stateFor): other players' capture urls are null, except in the 'leak' scenario,
// which deliberately hands the screen an UNREDACTED state to prove the screen would not show other players' urls anyway.
import '../../styles/theme.css';
import '../../map/mapPanel.css';   // the real map panel CSS, so the hidden .map-bar rule is exercised
import { createInitialState } from '../../contracts.js';
import { button } from '../kit/index.js';
import { createStubMap, stubViewerFactory } from '../kit/previewStubs.js';
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

// ---- fake game state ----
const LOOKS = [
  ['Mo', 'coral', 'round', 'happy'], ['Lena', 'sky', 'square', 'cool'], ['Jonas', 'mint', 'hex', 'wink'],
  ['Sofia', 'violet', 'wide', 'oh'], ['Tim', 'orange', 'dome', 'sleepy'],
];
const pid = (i) => `p${i}`;
const T0 = Date.now();

/** A fake Street View url, unique per seed (shape like a real one: @lat,lng,3a,..h,..t/data=..). */
const spotUrl = (seed) => {
  let n = 0;
  for (const ch of seed) n = Math.imul(n ^ ch.charCodeAt(0), 2654435761) >>> 0;
  return `https://www.google.com/maps/@${(48 + (n % 1000) / 1000).toFixed(7)},${(9 + ((n >>> 10) % 1000) / 1000).toFixed(7)},3a,53.6y,${n % 360}.43h,100.86t/data=!3m7!1e1!3m5!1sPANO-${seed}`;
};

/** caps: { [playerIdx]: [categoryIdx,...] }; chat: [[playerIdx, text|null, linkSeed?], ...]. The state is FULL (unredacted); see redact(). */
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
      (s.captures[cat.id] ||= {})[pid(pi)] = { captureId: `cap-${cat.id}-${pid(pi)}`, playerId: pid(pi), categoryId: cat.id, at: T0, url: spotUrl(`${cat.id}-${pid(pi)}`) };
    }
  }
  s.chat = chat.map((c, i) => ({ id: `m${i}`, playerId: pid(c[0]), at: T0 + i, text: c[1] ?? null, url: c[2] ? spotUrl(c[2]) : null }));
  return s;
}

/** Same as core's stateFor() in the play phase: every capture not owned by the viewer gets url: null. */
function redact(state, viewerId) {
  const caps = {};
  for (const [cid, byPlayer] of Object.entries(state.captures)) {
    caps[cid] = Object.fromEntries(Object.entries(byPlayer).map(([p, c]) => [p, p === viewerId ? c : { ...c, url: null }]));
  }
  return { ...state, captures: caps };
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
  captures: { label: 'Submissions (own + others)', meId: pid(1), state: () => playState({ done: [2], caps: { 0: [0, 1, 2, 3, 4, 5], 1: [0, 1, 2, 3, 4, 5], 2: [0, 1, 3], 3: [0, 5], 4: [0, 1] }, chat: CHAT_MIX.slice(0, 4) }) },
  leak: { label: 'Leak guard (unredacted state)', meId: pid(1), unredacted: true, state: () => playState({ done: [2], caps: { 0: [0, 1, 2], 1: [0, 1], 2: [0, 1, 3], 3: [0] }, chat: CHAT_MIX.slice(0, 4) }) },
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

  const map = createStubMap(calls, log);
  const createViewer = stubViewerFactory(calls, log);
  screen = createPlayScreen({ send: rec('send'), map, onCapture: rec('onCapture'), onShare: rec('onShare'), createViewer });
  stage.append(screen.el);
  const full = sc.state();
  const prep = (s) => (sc.unredacted ? s : redact(s, sc.meId));
  const view = (state) => ({ state: prep(state), meId: sc.meId, clockOffset: 0 });
  screen.render(view(full));
  // urls = every real (unredacted) capture url by "playerId:categoryId", so a test can look for them in the DOM
  const urls = {};
  for (const [cid, byPlayer] of Object.entries(full.captures)) for (const [p, c] of Object.entries(byPlayer)) urls[`${p}:${cid}`] = c.url;
  window.__pv = { calls, map, createViewer, screen, scenario: key, meId: sc.meId, state: full, urls, render(s) { window.__pv.state = s; screen.render(view(s)); } };
}

for (const [key, sc] of Object.entries(SCENARIOS)) {
  nav.append(button({ label: sc.label, size: 'sm', onClick: () => show(key) }));
  nav.lastChild.dataset.key = key;
}
show(location.hash.slice(1));

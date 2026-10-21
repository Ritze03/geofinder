// Preview harness for the Review and Results screens (no app, no network, no webview): the live viewer is a stub that shows the url it
// was given (window.__pv.calls records viewer.create / viewer.load(url) / viewer.destroy and every send()).
// Each scenario is a fake GameState + the viewer's id. Intents are logged (console + #pv-log) AND applied to the fake state with core's
// applyIntent as the viewer, so the harness behaves like a tiny host: stars stick, next/prev/show results/play again really navigate.
import '../../styles/theme.css';
import { PHASE, createInitialState } from '../../contracts.js';
import { applyIntent } from '../../core/index.js';
import { button, h } from '../kit/index.js';
import { stubViewerFactory } from '../kit/previewStubs.js';
import { createReviewScreen } from './reviewScreen.js';
import { createResultsScreen } from '../results/resultsScreen.js';

const logEl = document.getElementById('pv-log');
const log = (what, data) => {
  const line = `${what} ${data === undefined ? '' : JSON.stringify(data)}`;
  console.log('[preview]', line);
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
};

// ---- fake data ----
const LOOKS = [
  ['Mo', 'coral', 'round', 'happy'], ['Lena', 'sky', 'square', 'cool'], ['Jonas', 'mint', 'hex', 'wink'], ['Sofia', 'violet', 'wide', 'oh'],
];
const pid = (i) => `p${i}`;
const cid = (ci, i) => `cap-${ci}-${i}`;
/** A fake Street View url, unique per capture (shape like a real one). */
const spotUrl = (ci, i) => `https://www.google.com/maps/@${(48.1 + ci * 0.07 + i * 0.013).toFixed(7)},${(9.1 + i * 0.05).toFixed(7)},3a,53.6y,${(ci * 90 + i * 25) % 360}.43h,100.86t/data=!3m7!1e1!3m5!1sPANO-${ci}-${i}`;

/**
 * Review/results GameState: 4 players (p0 host; p3 Sofia disconnected), 3 categories.
 * @param {{index?:number, phase?:string, missing?:string[], ratings?:Object}} o
 *   missing: 'ci:i' captures to leave out; ratings: ratings[target][ci] = stars given by the OTHER players in join order (array)
 */
function gameState({ index = 0, phase = PHASE.review, missing = [], ratings = {} } = {}) {
  const s = createInitialState({ playerId: pid(0), profile: { name: LOOKS[0][0], color: LOOKS[0][1], head: LOOKS[0][2], face: LOOKS[0][3] } }, 'GEO-7Q4K');
  for (let i = 1; i < 4; i++) {
    const [name, color, head, face] = LOOKS[i];
    s.players.push({ playerId: pid(i), profile: { name, color, head, face }, isHost: false, connected: i !== 3, ready: false, done: true });
  }
  s.categories = s.categories.slice(0, 3);
  s.phase = phase;
  s.reviewIndex = phase === PHASE.review ? index : 0;
  s.categories.forEach((c, ci) => {
    s.captures[c.id] = {};
    s.ratings[c.id] = {};
    for (let i = 0; i < 4; i++) {
      if (missing.includes(`${ci}:${i}`)) continue;
      s.captures[c.id][pid(i)] = { captureId: cid(ci, i), playerId: pid(i), categoryId: c.id, at: 1000 + ci * 10 + i, url: spotUrl(ci, i) };
    }
  });
  for (const [i, perCat] of Object.entries(ratings)) {
    perCat.forEach((stars, ci) => {
      if (!stars) return;
      const raters = s.players.map((p) => p.playerId).filter((id) => id !== pid(+i));
      s.ratings[s.categories[ci].id][pid(+i)] = Object.fromEntries(stars.map((n, k) => [raters[k], n]).filter(([, n]) => n));
    });
  }
  return s;
}

// final ratings: totals p0 20, p1 20 (tie for 1st), p2 16, p3 8 (no capture in category 3)
const FINAL = { 0: [[3, 2, 2], [3, 2, 2], [2, 2, 2]], 1: [[3, 3, 1], [2, 3, 2], [3, 2, 1]], 2: [[2, 1, 2], [3, 2, 1], [2, 2, 1]], 3: [[1, 2, 1], [2, 1, 1], null] };
// partly rated category 2 (index 1): Lena (p1) rated Mo 4 and Jonas 2, Sofia still open
const PARTIAL = { 0: [null, [4, 3, 0]], 2: [null, [0, 2, 4]], 3: [null, [3, 0, 0]] };

const SCENARIOS = {
  'review-host': { label: 'Review: host', meId: pid(0), state: () => gameState({ index: 1, ratings: { 1: [null, [0, 0, 3]] } }) },
  'review-player': { label: 'Review: player', meId: pid(1), state: () => gameState({ index: 0 }) },
  'review-partial': { label: 'Review: partly rated (Lena)', meId: pid(1), state: () => gameState({ index: 1, ratings: PARTIAL }) },
  'review-nocapture': { label: 'Review: no capture (Jonas)', meId: pid(0), state: () => gameState({ index: 1, missing: ['1:2'] }) },
  'review-ownmissing': { label: 'Review: I have no capture', meId: pid(1), state: () => gameState({ index: 1, missing: ['1:1'] }) },
  'review-last': { label: 'Review: last category (host)', meId: pid(0), state: () => gameState({ index: 2, ratings: FINAL_LAST() }) },
  'review-last-player': { label: 'Review: last category (player)', meId: pid(2), state: () => gameState({ index: 2, ratings: FINAL_LAST() }) },
  'results-tie': { label: 'Results: tie (host)', meId: pid(0), state: () => gameState({ phase: PHASE.results, missing: ['2:3'], ratings: FINAL }) },
  'results-player': { label: 'Results: tie (player)', meId: pid(2), state: () => gameState({ phase: PHASE.results, missing: ['2:3'], ratings: FINAL }) },
};
function FINAL_LAST() { // everything rated except category 3
  return Object.fromEntries(Object.entries(FINAL).map(([i, v]) => [i, [v[0], v[1], null]]));
}

// ---- stage ----
const nav = document.getElementById('pv-nav');
const stage = document.getElementById('pv-stage');
let screen = null;     // current screen object
let screenKind = '';   // 'review' | 'results' | 'other'
let state = null;
let sc = null;
const calls = [];
const createViewer = stubViewerFactory(calls, log);
window.__pv = { calls, createViewer, spotUrl, get state() { return state; }, get screen() { return screen; } };

function view() {
  return { state, meId: sc.meId, clockOffset: 0 };
}

function send(intent) {
  calls.push({ kind: 'send', arg: intent });
  log('intent', intent);
  const r = applyIntent(state, sc.meId, intent, Date.now());
  if (r.error) { log('refused', r.error); return; }
  state = r.state;
  mount();
}

function mount() {
  const kind = state.phase === PHASE.review ? 'review' : state.phase === PHASE.results ? 'results' : 'other';
  if (kind !== screenKind) {
    screen?.destroy();
    stage.replaceChildren();
    screenKind = kind;
    screen = kind === 'review' ? createReviewScreen({ send, createViewer })
      : kind === 'results' ? createResultsScreen({ send })
        : { el: h('section', { class: 'screen', id: 'pv-other' }, h('h2', null, `Phase: ${state.phase}`), h('p', { class: 'muted' }, '(the app would show this screen)')), render() {}, destroy() {} };
    stage.append(screen.el);
  }
  screen.render(view());
}

function show(key) {
  sc = SCENARIOS[key];
  state = sc.state();
  screen?.destroy();
  screen = null;
  screenKind = '';
  stage.replaceChildren();
  logEl.textContent = '';
  history.replaceState(null, '', `#${key}`);
  [...nav.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === key)));
  calls.length = 0;
  mount();
}

for (const [key, s] of Object.entries(SCENARIOS)) {
  nav.append(button({ label: s.label, size: 'sm', onClick: () => show(key) }));
  nav.lastChild.dataset.key = key;
}
const start = location.hash.slice(1);
show(start in SCENARIOS ? start : 'review-host');

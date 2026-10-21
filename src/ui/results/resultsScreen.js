// Results screen. Renders a GameState snapshot (phase 'results'), never changes state itself.
//   createResultsScreen({ send }) -> { el, render(view), destroy() }
//   view = { state, meId, clockOffset }
// Final points per player come from core's ranking(state) (ties share a rank: 1,1,3). Podium for the top ranks (<= 3), a per-category
// breakdown table for everybody. Host: "Review again" (reviewAgain) and "Play again" (playAgain); everybody else waits for the host.
import { INTENT, STARS_MAX } from '../../contracts.js';
import { categoryScore, myCapture, ranking } from '../../core/index.js';
import { h, avatar, button, colorHex } from '../kit/index.js';
import './results.css';

const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
const nameOf = (p) => p.profile.name || 'Player';

export function createResultsScreen({ send } = {}) {
  let lastKey = '';

  const podium = h('div', { class: 'podium' });
  const tableBox = h('div', { class: 'tw' });
  const reviewBtn = button({ label: 'Review the captures again', onClick: () => send({ type: INTENT.reviewAgain }) });
  const playBtn = button({ label: 'Play again', variant: 'pop', size: 'lg', onClick: () => send({ type: INTENT.playAgain }) });
  const waiting = h('p', { class: 'wait muted', role: 'status' }, 'Waiting for the host to continue.');
  const acts = h('div', { class: 'acts' }, reviewBtn, playBtn, waiting);

  const el = h('section', { class: 'screen', dataset: { screen: 'results' } },
    h('div', { class: 'res' },
      h('div', { class: 'res-head' }, h('span', { class: 'eyebrow' }, 'Round complete'), h('h2', null, 'Final standings')),
      podium, tableBox, acts));

  function podiumNode(r) {
    const rank = r.rank;
    const cls = rank >= 3 ? 'p3' : `p${rank}`;
    return h('div', { class: `pod ${cls}`, style: `--c:${colorHex(r.player.profile.color)}`, dataset: { pid: r.playerId, rank: String(rank) } },
      h('span', { class: 'crown', 'aria-hidden': 'true' }, rank === 1 ? '👑' : ''),
      avatar(r.player.profile, { size: rank === 1 ? 96 : 76 }),
      h('span', { class: 'nm' }, nameOf(r.player)),
      h('div', { class: 'blk' }, h('b', { class: 'num' }, String(r.points)), h('span', null, `${ordinal(rank)} place`)));
  }

  function buildPodium(rows) {
    const top = rows.filter((r) => r.rank <= 3);
    // visual order: 2nd place left, 1st in the middle, 3rd right (a tie just fills its rank's slot)
    const order = [2, 1, 3].flatMap((rk) => top.filter((r) => r.rank === rk));
    podium.style.setProperty('--n', String(Math.max(1, order.length)));
    podium.replaceChildren(...order.map((r) => podiumNode(r)));
  }

  function buildTable(state, rows) {
    const cats = state.categories;
    const maxPer = Math.max(1, (state.players.length - 1) * STARS_MAX);
    const cell = new Map(); // playerId -> per-category info
    const best = cats.map(() => 0);
    for (const r of rows) {
      cell.set(r.playerId, cats.map((c, ci) => {
        const has = !!myCapture(state, r.playerId, c.id);
        const { points, count } = categoryScore(state, c.id, r.playerId);
        if (points > best[ci]) best[ci] = points;
        return { has, points, count };
      }));
    }
    const thead = h('thead', null, h('tr', null,
      h('th', null, 'Player'),
      cats.map((c) => h('th', { title: c.label }, c.label)),
      h('th', { class: 'tot' }, 'Total')));
    const tbody = h('tbody', null, rows.map((r) => h('tr', {
      style: `--c:${colorHex(r.player.profile.color)}`, dataset: { pid: r.playerId, rank: String(r.rank) },
    },
    h('td', { class: 'pl' }, h('div', null, h('em', null, String(r.rank)), avatar(r.player.profile, { size: 36 }), h('b', null, nameOf(r.player)))),
    cell.get(r.playerId).map((c, ci) => {
      const cls = ['cell', c.points > 0 && c.points === best[ci] ? 'best' : '', c.points ? '' : 'zero'].filter(Boolean).join(' ');
      const sub = !c.has ? 'no capture' : c.count ? `${(c.points / c.count).toFixed(1)} ★ avg` : 'not rated';
      return h('td', null, h('div', { class: cls, style: `--a:${Math.min(1, c.points / maxPer)}` }, h('b', null, c.points ? String(c.points) : '–'), h('small', null, sub)));
    }),
    h('td', { class: 'tot' }, String(r.points), h('small', null, 'pts')))));
    tableBox.replaceChildren(h('table', null, thead, tbody));
  }

  function render(view) {
    const { state, meId } = view;
    const rows = ranking(state);
    const me = state.players.find((p) => p.playerId === meId) || null;
    const isHost = !!(me && me.isHost);

    // the podium/table only depend on these; skip the rebuild when a snapshot (e.g. a chat message) changed nothing here
    const key = JSON.stringify([
      rows.map((r) => [r.playerId, r.points, r.rank, r.player.profile, r.player.connected]),
      state.categories,
      state.categories.map((c) => state.players.map((p) => [!!myCapture(state, p.playerId, c.id), categoryScore(state, c.id, p.playerId)])),
    ]);
    if (key !== lastKey) {
      lastKey = key;
      buildPodium(rows);
      buildTable(state, rows);
    }
    podium.hidden = rows.length === 0;

    reviewBtn.hidden = !isHost;
    playBtn.hidden = !isHost;
    waiting.hidden = isHost;
  }

  return { el, render, destroy() { lastKey = ''; } };
}

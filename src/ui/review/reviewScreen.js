// Review screen. Renders a GameState snapshot (phase 'review'), never changes state itself: every action is send({ type: INTENT.x, ... }).
//   createReviewScreen({ send, createViewer }) -> { el, render(view), destroy() }
//     createViewer(container) -> { element, load(url), destroy() }   a live map viewer (mode 'view'), mounted into `container`
//                                (the screen appends viewer.element itself if the factory did not)
//   view = { state, meId, clockOffset }
// D10: the HOST steps through the categories (reviewNext / reviewPrev / showResults); everybody else follows along.
// Layout (full window width): a list of the current category's submissions on the left (avatar, name, stars; "Your capture" has no stars;
// players without a capture show "No capture" / 0 points and cannot be selected), a big LIVE viewer on the right that shows the selected
// submission. Clicking a card selects it and loads its url; "Back to submitted spot" loads it again (after the viewer has been panned away).
// On a category change the first submission is selected automatically.
// Everyone rates every OTHER capture 1..5 stars (rate { categoryId, targetPlayerId, stars }); re-rating overwrites.
// The side panel also shows how many players have rated everything in this category (ratingProgress); purely informative, Next is never blocked.
// The viewer is created ONCE per screen (lazily, on the first url) and re-used via load(); cards are built once and patched on every render,
// so hover/focus survive snapshots and the <webview> is never recreated.
import { INTENT, STARS_MAX } from '../../contracts.js';
import { capturesOf, ratingOf, ratingProgress, reviewCategory } from '../../core/index.js';
import { h, avatar, button, colorHex, starRating, tag } from '../kit/index.js';
import './review.css';

const sameProfile = (a, b) => a.color === b.color && a.head === b.head && a.face === b.face;

export function createReviewScreen({ send, createViewer } = {}) {
  let lastCatId = null;
  let selected = null;       // playerId whose submission the viewer shows
  let loadedUrl = null;      // the url last passed to viewer.load (null: nothing loaded)
  let viewer = null;         // created lazily, once
  let current = null;        // { cat, refs: Map<playerId, CaptureRef>, players } of the last render (click handlers read it)

  // ---- header ----
  const eyebrow = h('span', { class: 'eyebrow' });
  const title = h('h2');
  const seg = h('div', { class: 'rv-seg', 'aria-hidden': 'true' });
  const hint = tag('');
  const head = h('div', { class: 'rv-head' }, h('div', null, eyebrow, title, seg), hint);

  // ---- left: submissions list + progress / host controls ----
  const bigNum = h('div', { class: 'big' });
  const allNum = h('div', { class: 'big' });
  const allRow = h('div', { class: 'row all' }, h('span', { class: 'eyebrow' }, 'All players'), allNum);
  const sideNote = h('p');
  const prevBtn = button({ label: '← Previous', onClick: () => send({ type: INTENT.reviewPrev }) });
  const nextBtn = button({ label: 'Next category →', variant: 'pop', size: 'lg', onClick: () => send({ type: INTENT.reviewNext }) });
  const resultsBtn = button({ label: 'Show results', onClick: () => send({ type: INTENT.showResults }) });
  const acts = h('div', { class: 'acts' });
  const hostTag = tag('Host control', { host: true });
  const side = h('div', { class: 'rv-side' }, h('div', { class: 'row' }, h('span', { class: 'eyebrow' }, 'Your ratings'), bigNum), allRow, sideNote, acts, hostTag);
  let actsHost = null; // which role the acts container is currently built for

  const list = h('div', { class: 'rv-list', role: 'list', 'aria-label': 'Submissions for this category' });

  // ---- right: the viewer ----
  const vWho = h('span', { class: 'vwho' });
  const backBtn = h('button', { type: 'button', class: 'btn pop lg rv-back', onClick: () => loadSelected(true) }, '⟲ Back to submitted spot');
  const vbar = h('div', { class: 'rv-vbar' }, vWho, h('span', { class: 'sp' }), backBtn);
  const vbody = h('div', { class: 'rv-vbody' });
  const emptyMsg = h('p');
  const empty = h('div', { class: 'rv-empty' }, emptyMsg);
  vbody.append(empty);
  const main = h('div', { class: 'rv-main' }, vbar, vbody);

  const el = h('section', { class: 'screen rv', dataset: { screen: 'review' } }, head, h('div', { class: 'rv-body' }, h('div', { class: 'rv-left' }, list, side), main));

  // ---- viewer control ----
  const selectedRef = () => (current && selected ? current.refs.get(selected) || null : null);

  function ensureViewer() {
    if (viewer || !createViewer) return viewer;
    viewer = createViewer(vbody);
    if (viewer.element && !viewer.element.isConnected) vbody.insertBefore(viewer.element, empty);
    return viewer;
  }
  /** Loads the selected submission's url into the viewer. force: also when it is already the loaded one (card click, Back button). */
  function loadSelected(force) {
    const ref = selectedRef();
    const url = ref && ref.url ? ref.url : null;
    if (!url) return;
    if (!force && url === loadedUrl) return;
    const v = ensureViewer();
    if (!v) return;
    loadedUrl = url;
    v.load(url);
  }
  function select(playerId) {
    selected = playerId;
    loadSelected(true);
    paintSelection();
  }

  // ---- one card per player ----
  const cards = new Map(); // playerId -> { el, update(p), setSelected(bool) }

  function makeCard(playerId) {
    let cur = null;          // last update() params (click handlers read it)
    let avProfile = null;

    const avSlot = h('span', { class: 'avslot' });
    const nameEl = h('b');
    const awayTag = tag('Away');
    const missTag = tag('No capture · 0 pts');
    const meTag = h('span', { class: 'tagme' }, 'Your capture');
    const sub = h('small', { class: 'sub' });
    const pick = h('button', { type: 'button', class: 'pick', onClick: () => { if (cur && cur.ref) select(playerId); } },
      avSlot, h('span', { class: 'nm' }, h('span', { class: 'line' }, nameEl, awayTag, meTag, missTag), sub));
    const stars = starRating({
      onRate: (n) => { if (cur && cur.canRate) send({ type: INTENT.rate, categoryId: cur.categoryId, targetPlayerId: playerId, stars: n }); },
    });
    const note = h('small');
    const rate = h('div', { class: 'rate' }, stars.el, note);
    const root = h('div', { class: 'rcard', role: 'listitem', dataset: { pid: playerId } }, pick, rate);

    function update(p) {
      cur = p;
      const { player, ref, mine, label } = p;
      const name = player.profile.name || 'Player';
      if (!avProfile || !sameProfile(avProfile, player.profile)) {
        avProfile = player.profile;
        avSlot.replaceChildren(avatar(player.profile, { size: 36 }));
      }
      nameEl.textContent = name;
      root.style.setProperty('--c', colorHex(player.profile.color));
      awayTag.hidden = player.connected !== false;
      root.classList.toggle('off', player.connected === false);
      root.classList.toggle('mine', mine);
      root.classList.toggle('miss', !ref);
      missTag.hidden = !!ref;
      meTag.hidden = !(mine && ref);
      p.canRate = !!ref && !mine && p.meIsPlayer;

      pick.disabled = !ref;
      pick.setAttribute('aria-label', ref ? `Show ${mine ? 'your' : `${name}'s`} submission for ${label}` : `${name} has no capture for ${label}`);
      sub.textContent = !ref ? (mine ? 'You did not submit this one' : `${name} did not submit this one`) : mine ? 'Tap to look at your own spot' : 'Tap to look at their spot';

      // own card and "No capture": no stars at all (the widget is detached, not just disabled)
      const showStars = !!ref && !mine;
      rate.hidden = !showStars;
      if (showStars) {
        if (!stars.el.isConnected) rate.prepend(stars.el);
        const r = p.rating;
        stars.set({ value: r || 0, disabled: !p.canRate });
        stars.el.setAttribute('aria-label', `Rating for ${name}`);
        note.textContent = !p.meIsPlayer ? 'Only players can rate' : (r ? `${r} of ${STARS_MAX} stars` : 'Not rated yet');
      } else {
        stars.el.remove();
        note.textContent = '';
      }
    }
    return { el: root, update, setSelected(on) { root.classList.toggle('sel', on); pick.setAttribute('aria-pressed', String(on)); } };
  }

  function paintSelection() {
    for (const [id, c] of cards) c.setSelected(id === selected);
    const ref = selectedRef();
    const p = current && selected ? current.players.find((x) => x.playerId === selected) : null;
    vWho.replaceChildren(...(p ? [avatar(p.profile, { size: 28 }), h('b', null, p.profile.name || 'Player'), h('span', { class: 'muted' }, ` · ${current.cat.label}`)] : [h('span', { class: 'muted' }, 'No submission selected')]));
    backBtn.disabled = !ref || !ref.url;
    const nothing = !ref || !ref.url;
    empty.hidden = !nothing;
    emptyMsg.textContent = !current || !current.refs.size ? 'Nobody submitted a spot for this one.' : 'Pick a submission to look around at its spot.';
  }

  function sameChildren(parent, items) {
    return parent.children.length === items.length && items.every((n, i) => parent.children[i] === n);
  }

  function setActs(isHost) {
    if (actsHost === isHost) return;
    actsHost = isHost;
    acts.replaceChildren(...(isHost ? [prevBtn, nextBtn, resultsBtn] : []));
    acts.hidden = !isHost;
    hostTag.hidden = !isHost;
  }

  // ---- render ----
  function render(view) {
    const { state, meId } = view;
    const me = state.players.find((p) => p.playerId === meId) || null;
    const isHost = !!(me && me.isHost);
    const cat = reviewCategory(state);
    const n = state.categories.length;
    const idx = state.reviewIndex;

    setActs(isHost);

    if (!cat) { // not (or no longer) in review: nothing to show
      eyebrow.textContent = 'Review';
      title.textContent = 'Waiting for the review to start';
      seg.replaceChildren();
      hint.hidden = true;
      list.replaceChildren();
      current = null;
      selected = null;
      paintSelection();
      return;
    }

    eyebrow.textContent = `Category ${idx + 1} of ${n}`;
    title.textContent = cat.label;
    seg.replaceChildren(...state.categories.map((_, i) => h('i', { class: i < idx ? 'd' : i === idx ? 'a' : '' })));
    hint.hidden = false;
    hint.textContent = me ? 'Rate every other capture from 1 to 5 stars' : 'Rate every capture from 1 to 5 stars';

    // cards, in join order
    const refs = new Map(capturesOf(state, cat.id).map((r) => [r.playerId, r]));
    current = { cat, refs, players: state.players };
    const seen = new Set();
    let need = 0;
    let done = 0;
    const nodes = state.players.map((player) => {
      seen.add(player.playerId);
      let card = cards.get(player.playerId);
      if (!card) { card = makeCard(player.playerId); cards.set(player.playerId, card); }
      const ref = refs.get(player.playerId) || null;
      const mine = player.playerId === meId;
      const rating = ref && !mine ? ratingOf(state, cat.id, player.playerId, meId) : null;
      if (ref && !mine) { need++; if (rating) done++; }
      card.update({ player, ref, mine, rating, categoryId: cat.id, label: cat.label, meIsPlayer: !!me });
      return card.el;
    });
    for (const id of [...cards.keys()]) if (!seen.has(id)) cards.delete(id);
    if (!sameChildren(list, nodes)) list.replaceChildren(...nodes);

    // selection: a new category (or a vanished / capture-less selection) auto-selects the first submission
    const catChanged = lastCatId !== cat.id;
    lastCatId = cat.id;
    if (catChanged || !selectedRef()) {
      const first = state.players.find((p) => refs.has(p.playerId));
      selected = first ? first.playerId : null;
      if (catChanged) loadedUrl = null;   // the first submission of a new category is always loaded, even if the url is the same
    }
    loadSelected(false);
    paintSelection();

    // side panel
    bigNum.replaceChildren(String(done), h('small', null, ` / ${need} rated`));
    const all = ratingProgress(state, cat.id);
    allNum.replaceChildren(String(all.done), h('small', null, ` / ${all.total} rated`));
    const last = idx >= n - 1;
    sideNote.textContent = isHost ? 'Move on once everyone has rated (the count above is only a hint).' : 'Host picks the next category.';
    prevBtn.disabled = idx <= 0;
    nextBtn.hidden = last;
    resultsBtn.textContent = 'Show results';
    resultsBtn.classList.toggle('pop', last);
    resultsBtn.classList.toggle('lg', last);
    resultsBtn.classList.toggle('sm', !last);
  }

  return {
    el,
    render,
    destroy() {
      if (viewer) { try { viewer.destroy(); } catch (_) { /* already gone */ } viewer = null; }
      cards.clear();
      current = null;
    },
  };
}

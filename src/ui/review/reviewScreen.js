// Review screen. Renders a GameState snapshot (phase 'review'), never changes state itself: every action is send({ type: INTENT.x, ... }).
//   createReviewScreen({ send }) -> { el, render(view), destroy() }
//   view = { state, meId, clockOffset, imageUrl(imageId) -> string|null }   (imageUrl null => bytes still arriving: placeholder)
// D10: the HOST steps through the categories (reviewNext / reviewPrev / showResults); everybody else follows along.
// Every player's submission of the current category is shown (avatar + name + image), also players without a capture.
// Everyone rates every OTHER capture 1..5 stars; the own card has a tag and a disabled star widget. Re-rating overwrites.
// The card per player is built once and patched on every render, so images do not reload and hover/focus survive snapshots.
import { INTENT, STARS_MAX } from '../../contracts.js';
import { capturesOf, ratingOf, reviewCategory } from '../../core/index.js';
import { h, avatar, button, colorHex, starRating, tag } from '../kit/index.js';
import { closeLightbox, openLightbox } from './lightbox.js';
import './review.css';

const sameProfile = (a, b) => a.color === b.color && a.head === b.head && a.face === b.face;

export function createReviewScreen({ send } = {}) {
  let lastCatId = null;

  // ---- header ----
  const eyebrow = h('span', { class: 'eyebrow' });
  const title = h('h2');
  const seg = h('div', { class: 'rv-seg', 'aria-hidden': 'true' });
  const hint = tag('');
  const head = h('div', { class: 'rv-head' }, h('div', null, eyebrow, title, seg), hint);

  // ---- side panel: progress + host controls ----
  const bigNum = h('div', { class: 'big' });
  const sideNote = h('p');
  const prevBtn = button({ label: '← Previous', onClick: () => send({ type: INTENT.reviewPrev }) });
  const nextBtn = button({ label: 'Next category →', variant: 'pop', size: 'lg', onClick: () => send({ type: INTENT.reviewNext }) });
  const resultsBtn = button({ label: 'Show results', onClick: () => send({ type: INTENT.showResults }) });
  const acts = h('div', { class: 'acts' });
  const hostTag = tag('Host control', { host: true });
  const side = h('div', { class: 'rv-side' }, h('span', { class: 'eyebrow' }, 'Your ratings'), bigNum, sideNote, acts, hostTag);
  let actsHost = null; // which role the acts container is currently built for

  const grid = h('div', { class: 'rv-grid' });
  const el = h('section', { class: 'screen', dataset: { screen: 'review' } }, head, grid);

  // ---- one card per player ----
  const cards = new Map(); // playerId -> { el, update(p) }

  function makeCard(playerId) {
    let cur = null;          // last update() params (click handlers read it)
    let avProfile = null;
    let mode = '';           // what the image area currently shows: 'miss' | 'load' | 'img'
    let imgEl = null;

    const avSlot = h('span', { class: 'avslot' });
    const ghostAv = h('span');
    const ghostMsg = h('span');
    const ghost = h('div', { class: 'ghost' }, ghostAv, h('b', null, 'No capture'), ghostMsg);
    const nameEl = h('b');
    const awayTag = tag('Away');
    const missTag = tag('0 points');
    const who = h('div', { class: 'who' }, avSlot, nameEl, awayTag, missTag);
    const imgw = h('div', { class: 'imgw' });
    const meTag = h('span', { class: 'tagme' }, 'Your capture');
    const stars = starRating({
      onRate: (n) => { if (cur && cur.canRate) send({ type: INTENT.rate, categoryId: cur.categoryId, targetPlayerId: playerId, stars: n }); },
    });
    const note = h('small');
    const rate = h('div', { class: 'rate' }, stars.el, note);
    const root = h('div', { class: 'rcard', dataset: { pid: playerId } }, who, imgw, rate);

    function showImage(url, alt) {
      if (mode !== 'img') {
        imgEl = h('img', { src: url, alt, draggable: 'false' });
        const zoom = h('button', {
          type: 'button', class: 'zoom', 'aria-label': 'View larger',
          onClick: () => { if (cur && cur.url) openLightbox({ src: cur.url, caption: cur.caption, alt: cur.alt }); },
        }, imgEl);
        imgw.replaceChildren(zoom);
        mode = 'img';
      } else {
        if (imgEl.getAttribute('src') !== url) imgEl.src = url;
        if (imgEl.alt !== alt) imgEl.alt = alt;
      }
    }

    function update(p) {
      cur = p;
      const { player, ref, url, mine, label, categoryId } = p;
      const name = player.profile.name || 'Player';
      if (!avProfile || !sameProfile(avProfile, player.profile)) {
        avProfile = player.profile;
        avSlot.replaceChildren(avatar(player.profile, { size: 36 }));
        ghostAv.replaceChildren(avatar(player.profile, { size: 64 }));
      }
      nameEl.textContent = name;
      root.style.setProperty('--c', colorHex(player.profile.color));
      awayTag.hidden = player.connected !== false;
      root.classList.toggle('off', player.connected === false);
      root.classList.toggle('mine', mine);
      root.classList.toggle('miss', !ref);
      missTag.hidden = !!ref;
      p.alt = `${name}'s capture: ${label}`;
      p.caption = `${name} · ${label}`;
      p.canRate = !!ref && !mine && p.meIsPlayer;

      if (!ref) {
        if (mode !== 'miss') { imgw.replaceChildren(ghost); mode = 'miss'; }
        ghostMsg.textContent = mine ? 'You did not capture this one' : `${name} did not capture this one`;
        rate.hidden = true;
        return;
      }
      rate.hidden = false;
      if (url) showImage(url, p.alt);
      else if (mode !== 'load') { imgw.replaceChildren(h('div', { class: 'load', role: 'status' }, 'Loading image…')); mode = 'load'; }
      if (mine) imgw.append(meTag); else meTag.remove();
      const r = p.rating;
      stars.set({ value: mine ? 0 : (r || 0), disabled: !p.canRate });
      stars.el.setAttribute('aria-label', `Rating for ${name}`);
      note.textContent = mine ? 'You cannot rate yourself' : !p.meIsPlayer ? 'Only players can rate' : (r ? `${r} of ${STARS_MAX} stars` : 'Not rated yet');
    }
    return { el: root, update };
  }

  function sameChildren(parent, list) {
    return parent.children.length === list.length && list.every((n, i) => parent.children[i] === n);
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
    const { state, meId, imageUrl } = view;
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
      grid.replaceChildren();
      return;
    }

    if (lastCatId !== null && lastCatId !== cat.id) { try { window.scrollTo(0, 0); } catch (_) { /* no window in tests */ } }
    lastCatId = cat.id;

    eyebrow.textContent = `Category ${idx + 1} of ${n}`;
    title.textContent = cat.label;
    seg.replaceChildren(...state.categories.map((_, i) => h('i', { class: i < idx ? 'd' : i === idx ? 'a' : '' })));
    hint.hidden = false;
    hint.textContent = me ? 'Rate every other capture from 1 to 5 stars' : 'Rate every capture from 1 to 5 stars';

    // cards, in join order
    const refs = new Map(capturesOf(state, cat.id).map((r) => [r.playerId, r]));
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
      card.update({
        player, ref, mine, rating, categoryId: cat.id, label: cat.label, meIsPlayer: !!me,
        url: ref ? imageUrl(ref.captureId) : null,
      });
      return card.el;
    });
    for (const id of [...cards.keys()]) if (!seen.has(id)) cards.delete(id);
    if (!sameChildren(grid, [...nodes, side])) grid.replaceChildren(...nodes, side);

    // side panel
    bigNum.replaceChildren(String(done), h('small', null, ` / ${need} rated`));
    const last = idx >= n - 1;
    sideNote.textContent = isHost ? 'Move on once everyone has rated.' : 'Host picks the next category.';
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
    destroy() { closeLightbox(); cards.clear(); },
  };
}

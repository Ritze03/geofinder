// Play screen: the map, the "Find these" list with per-category capture, the done toggle + all-done countdown banner,
// the round timer, the host's mid-game "add a category" and the chat. Renders a GameState snapshot and never changes state:
// every action is send({ type: INTENT.x, ... }) or one of the callbacks below. Ported from design/mockup.html (data-screen="play").
//
//   createPlayScreen({
//     send,                   // (intent) -> void
//     map,                    // { element: HTMLElement, show(provider:'google'|'apple') }   (src/map/mapPanel.js createMapPanel())
//                             //   map.element is mounted ONCE into the map slot and never recreated, so the <webview> never reloads.
//     onCapture(categoryId),  // app captures the map, ships the bytes, sends INTENT.capture. May return a Promise: a rejection
//                             //   clears the busy state and shows a toast. The category's button stays "Capturing..." until a
//                             //   snapshot carries a new CaptureRef for me, or a rejection, or BUSY_MS.
//     onShare(caption|null),  // app captures the map into chat (bytes, then INTENT.chatImage). caption = the chat box text
//                             //   (trimmed, <= CHAT_TEXT_MAX) or null. Same Promise/busy rules; busy ends when a new chat image of mine shows up.
//   }) -> { el, render(view), destroy() }
//   view = { state, meId, clockOffset, imageUrl(imageId) -> string|null }
//
// Layout: the screen is a flex column of `height: var(--play-h, 100vh)` (min 560 px). The map slot (.map) fills the left grid
// cell; `.map-panel` is stretched over it (position:absolute; inset:0) and its own .map-bar is hidden by CSS because the
// provider switch lives in this screen's top bar (kit `segmented`, calls map.show(p)).
// Overlays (done-countdown banner, capture flash, lightbox) are position:absolute with z-index above the map; the slot and the
// screen are `isolation:isolate`. The lightbox covers the whole screen.
// imageUrl() may return null while bytes are still arriving: placeholders are shown and re-checked every second by themselves,
// so I8 does not have to re-render for image arrival (it still may).
import { CATEGORY_LABEL_MAX, CHAT_TEXT_MAX, DONE_COUNTDOWN_MS, INTENT, MAX_CATEGORIES, makeId, msLeft, sanitizeProfile } from '../../contracts.js';
import { captureCount, capturesOf, connectedPlayers, getPlayer, myCapture } from '../../core/index.js';
import { avatar, button, colorHex, h, segmented, showToast, timerBox, timerReadout } from '../kit/index.js';
import './play.css';

/** A pending capture/share gives up waiting for its snapshot after this long (the button becomes usable again). */
const BUSY_MS = 10_000;
const PROVIDERS = [{ value: 'google', label: 'Google Maps' }, { value: 'apple', label: 'Apple Maps' }];
const pName = (p) => (p && p.profile && p.profile.name) || 'Player';

export function createPlayScreen({ send, map, onCapture, onShare } = {}) {
  let view = null;
  let firstRender = true;
  let knownCats = null;            // Set of category ids seen so far (toast on growth)
  const pics = new Set();          // live picture() objects, re-checked while their bytes are missing
  const busy = new Map();          // categoryId -> { from: captureId|null, timer }
  let shareBusy = null;            // { fromId: id of my newest chat image at click time, timer }

  // ---- picture: <img> from view.imageUrl(id) with a loading placeholder ------------------------------------------------
  function picture(cls, alt = '') {
    const el = h('span', { class: `pic loading ${cls || ''}` }, h('span', { class: 'ph' }, 'Loading'));
    const p = {
      el, id: null, url: null,
      set(id) {
        p.id = id || null;
        const url = p.id && view ? view.imageUrl(p.id) : null;
        if (url === p.url) return;
        p.url = url;
        el.classList.toggle('loading', !url);
        el.replaceChildren(url ? h('img', { src: url, alt, draggable: false }) : h('span', { class: 'ph' }, 'Loading'));
      },
    };
    pics.add(p);
    return p;
  }
  const dropPic = (p) => pics.delete(p);

  // ---- top bar -----------------------------------------------------------------------------------------------------------
  const prov = segmented({
    label: 'Map provider', options: PROVIDERS, value: 'google',
    onChange: (v) => { map.show(v); showToast(`${PROVIDERS.find((p) => p.value === v).label} start page`); },
  });
  const doneBtn = h('button', { type: 'button', class: 'btn dbtn pop', title: "I'm fine if the round ends now", onClick: () => {
    const me = meOf();
    if (me) send({ type: INTENT.setDone, done: !me.done });
  } }, "I'm done");
  const doneCount = h('span', { class: 'dcount muted' });
  const minis = h('div', { class: 'minis', 'aria-label': 'Players: captures and done state' });
  let minisKey = '';
  const roundTimer = timerBox(null, 0, { label: 'Time left' });
  const pbar = h('div', { class: 'pbar' }, prov.el, doneBtn, doneCount, h('span', { class: 'sp' }), minis, roundTimer.el);

  // ---- map slot + overlays -------------------------------------------------------------------------------------------------
  const bannerReadout = timerReadout(null, 0, { lowMs: 0, class: 'dnt' });
  const bannerBar = h('i');
  const banner = h('div', { class: 'ov dbanner', role: 'status', hidden: true },
    h('span', null, "Everyone's done. Round ends in ", bannerReadout.el),
    h('div', { class: 'bar' }, bannerBar),
    h('small', null, 'Anyone can step back to cancel.'));
  const mapSlot = h('div', { class: 'map' }, banner);
  mapSlot.append(map.element);   // once. Never moved or recreated afterwards.
  function flash() {
    mapSlot.classList.remove('flash');
    void mapSlot.offsetWidth;
    mapSlot.classList.add('flash');
  }

  // ---- "Find these" ---------------------------------------------------------------------------------------------------------
  const prog = h('span', { class: 'tag' });
  const catList = h('ul', { class: 'sc pc' });
  const addIn = h('input', { type: 'text', maxlength: CATEGORY_LABEL_MAX, autocomplete: 'off', placeholder: 'Host: add a category', 'aria-label': 'New category' });
  const addBtn = h('button', { class: 'btn', type: 'submit' }, '+ Add');
  const addForm = h('form', { class: 'addcat', hidden: true, onSubmit: (e) => {
    e.preventDefault();
    const label = addIn.value.trim().slice(0, CATEGORY_LABEL_MAX);
    if (!label || addBtn.disabled) return;
    send({ type: INTENT.addCategory, id: makeId(), label });
    addIn.value = '';
  } }, addIn, addBtn);
  const catsCard = h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', null, 'Find these'), prog), catList, addForm);
  const catRows = new Map();   // categoryId -> row

  function catRow(cat) {
    const pic = picture('', 'Your capture');
    const tick = h('span', { class: 'tick' }, '✓');
    const num = h('span', { class: 'n' });
    const th = h('button', { type: 'button', class: 'th empty', onClick: () => openCategory(cat.id, view.meId) }, num, pic.el, tick);
    const label = h('span', { class: 't' });
    const others = h('span', { class: 'oth' });
    const cap = h('button', { type: 'button', class: 'cap', onClick: () => doCapture(cat.id) });
    const li = h('li', { dataset: { id: cat.id } }, th, h('span', { class: 'lb' }, label, others), cap);
    return { li, th, pic, num, label, others, cap, othersKey: '' };
  }

  function updateCatRow(row, cat, i, state, meId) {
    const mine = myCapture(state, meId, cat.id);
    row.li.classList.toggle('done', !!mine);
    row.th.classList.toggle('empty', !mine);
    row.th.disabled = !mine;
    row.th.setAttribute('aria-label', mine ? `Open captures for ${cat.label}` : `No capture yet for ${cat.label}`);
    row.num.textContent = String(i + 1);
    row.pic.set(mine ? mine.captureId : null);
    row.label.textContent = cat.label;
    // who else captured it (click an avatar to compare)
    const oth = capturesOf(state, cat.id).filter((c) => c.playerId !== meId);
    const key = oth.map((c) => `${c.playerId}:${getPlayer(state, c.playerId)?.profile.color}`).join('|');
    if (key !== row.othersKey) {
      row.othersKey = key;
      row.others.replaceChildren(...oth.map((c) => {
        const p = getPlayer(state, c.playerId);
        return h('button', { type: 'button', class: 'o', title: `${pName(p)}'s capture`, 'aria-label': `Open ${pName(p)}'s capture of ${cat.label}`,
          onClick: () => openCategory(cat.id, c.playerId) }, avatar(p ? p.profile : sanitizeProfile({}), { size: 16 }));
      }));
    }
    const b = busy.get(cat.id);
    row.cap.disabled = !!b;
    row.cap.replaceChildren(`📸 ${b ? 'Capturing…' : mine ? 'Re-capture' : 'Capture'}`);
    row.cap.setAttribute('aria-label', `${mine ? 'Re-capture' : 'Capture'} ${cat.label}`);
  }

  function doCapture(categoryId) {
    if (busy.has(categoryId) || !view) return;
    const mine = myCapture(view.state, view.meId, categoryId);
    const timer = setTimeout(() => clearBusy(categoryId), BUSY_MS);
    busy.set(categoryId, { from: mine ? mine.captureId : null, timer });
    if (view) render(view);
    let res;
    try { res = onCapture && onCapture(categoryId); } catch (e) { res = Promise.reject(e); }
    Promise.resolve(res).catch((e) => {
      clearBusy(categoryId);
      showToast(`Capture failed${e && e.message ? `: ${e.message}` : ''}`);
      if (view) render(view);
    });
  }
  function clearBusy(categoryId) {
    const b = busy.get(categoryId);
    if (!b) return;
    clearTimeout(b.timer);
    busy.delete(categoryId);
    if (view) render(view);
  }

  // ---- chat -------------------------------------------------------------------------------------------------------------------
  const shareBtn = h('button', { type: 'button', class: 'btn sm', title: 'Post a screenshot of your current map view (the text box becomes its caption)', onClick: doShare }, 'Share screen');
  const msgs = h('div', { class: 'sc msgs', role: 'log', 'aria-live': 'polite', 'aria-label': 'Chat messages' });
  const newBtn = h('button', { type: 'button', class: 'newmsg', hidden: true, onClick: () => { stick = true; msgs.scrollTop = msgs.scrollHeight; newBtn.hidden = true; } }, 'New messages ↓');
  const chatIn = h('input', { type: 'text', maxlength: CHAT_TEXT_MAX, autocomplete: 'off', placeholder: 'Say something', 'aria-label': 'Chat message' });
  const chatForm = h('form', { class: 'cin', onSubmit: (e) => {
    e.preventDefault();
    const text = chatIn.value.trim().slice(0, CHAT_TEXT_MAX);
    if (!text) return;
    send({ type: INTENT.chatText, id: makeId(), text });
    chatIn.value = '';
    stick = true;
  } }, chatIn, h('button', { class: 'btn pop', type: 'submit' }, 'Send'));
  const chatCard = h('div', { class: 'card chat' }, h('div', { class: 'hd' }, h('h3', null, 'Chat'), shareBtn),
    h('div', { class: 'msgwrap' }, msgs, newBtn), chatForm);
  const msgRows = new Map();   // message id -> { el, pic }
  let stick = true;            // the user is at (or near) the bottom: follow new messages
  msgs.addEventListener('scroll', () => {
    stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 48;
    if (stick) newBtn.hidden = true;
  });
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (stick) msgs.scrollTop = msgs.scrollHeight; })
    : null;
  if (ro) { ro.observe(msgs); }

  function msgRow(m, state, meId) {
    const p = getPlayer(state, m.playerId);
    const profile = p ? p.profile : sanitizeProfile({});
    const body = h('div', { class: 'b' }, h('div', { class: 'who' }, pName(p)));
    let pic = null;
    if (m.imageId) {
      pic = picture('', 'Shared screen');
      body.append(h('button', { type: 'button', class: 'img', 'aria-label': `Open screen shared by ${pName(p)}`,
        onClick: () => openImage(m.imageId, `Shared by ${pName(p)}`, p, m.text) }, pic.el, h('span', { class: 'chip' }, 'shared screen')));
      if (m.text) body.append(h('div', { class: 'cp' }, m.text));
    } else {
      body.append(h('div', { class: 'tx' }, m.text || ''));
    }
    const el = h('div', { class: `msg${m.playerId === meId ? ' me' : ''}`, style: `--c:${colorHex(profile.color)}`, dataset: { id: m.id } },
      avatar(profile, { size: 28 }), body);
    return { el, pic };
  }

  function renderChat(state, meId) {
    let added = 0;
    const ids = new Set(state.chat.map((m) => m.id));
    for (const [id, r] of msgRows) {
      if (!ids.has(id)) { r.el.remove(); if (r.pic) dropPic(r.pic); msgRows.delete(id); }
    }
    for (const m of state.chat) {
      let r = msgRows.get(m.id);
      if (!r) { r = msgRow(m, state, meId); msgRows.set(m.id, r); added++; }
      if (r.pic) r.pic.set(m.imageId);
    }
    // keep DOM order == state order (new ones are normally appended; this also covers the first render)
    let prev = null;
    for (const m of state.chat) {
      const el = msgRows.get(m.id).el;
      if (el.previousElementSibling !== prev || el.parentNode !== msgs) msgs.insertBefore(el, prev ? prev.nextSibling : msgs.firstChild);
      prev = el;
    }
    if (added) {
      if (stick) msgs.scrollTop = msgs.scrollHeight;
      else if (!firstRender) newBtn.hidden = false;
    }
    // Share busy ends when a newer chat image of mine appears
    if (shareBusy) {
      const last = myLastChatImage(state, meId);
      if ((last ? last.id : null) !== shareBusy.fromId) clearShareBusy();
    }
  }
  const myLastChatImage = (state, meId) => [...state.chat].reverse().find((m) => m.playerId === meId && m.imageId) || null;
  function doShare() {
    if (shareBusy || !view) return;
    const last = myLastChatImage(view.state, view.meId);
    const caption = chatIn.value.trim().slice(0, CHAT_TEXT_MAX) || null;
    shareBusy = { fromId: last ? last.id : null, timer: setTimeout(clearShareBusy, BUSY_MS) };
    chatIn.value = '';
    stick = true;
    shareBtn.disabled = true;
    shareBtn.textContent = 'Sharing…';
    let res;
    try { res = onShare && onShare(caption); } catch (e) { res = Promise.reject(e); }
    Promise.resolve(res).catch((e) => {
      clearShareBusy();
      showToast(`Share failed${e && e.message ? `: ${e.message}` : ''}`);
    });
  }
  function clearShareBusy() {
    if (!shareBusy) return;
    clearTimeout(shareBusy.timer);
    shareBusy = null;
    shareBtn.disabled = false;
    shareBtn.textContent = 'Share screen';
  }

  // ---- lightbox ---------------------------------------------------------------------------------------------------------------
  // lb = { kind:'cat', catId, a:playerId, b:playerId|null, compare:boolean } | { kind:'img', imageId, title, player, text }
  let lb = null;
  let lbKey = '';
  let lbPics = [];
  let lastFocus = null;
  const modal = h('div', { class: 'modal', hidden: true, onClick: (e) => { if (e.target === modal) closeLightbox(); } });
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeLightbox(); } };

  function openCategory(catId, playerId) {
    if (!view) return;
    const caps = capturesOf(view.state, catId);
    if (!caps.length) return;
    const a = caps.some((c) => c.playerId === playerId) ? playerId : caps[0].playerId;
    openLightbox({ kind: 'cat', catId, a, b: null, compare: false });
  }
  function openImage(imageId, title, player, text) {
    openLightbox({ kind: 'img', imageId, title, player, text });
  }
  function openLightbox(next) {
    if (!lb) {
      lastFocus = document.activeElement;
      document.addEventListener('keydown', onKey, true);
    }
    lb = next;
    modal.hidden = false;
    lbKey = '';
    paintLightbox();
    const x = modal.querySelector('[data-close]');
    if (x) x.focus();
  }
  function closeLightbox() {
    if (!lb) return;
    lb = null;
    lbKey = '';
    modal.hidden = true;
    for (const p of lbPics) dropPic(p);
    lbPics = [];
    modal.replaceChildren();
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (_) { /* element gone */ }
  }

  function figure(imageId, player, extra) {
    const pic = picture('big', 'Capture');
    pic.set(imageId);
    lbPics.push(pic);
    return h('figure', null, h('div', { class: 'frm' }, pic.el),
      h('figcaption', null, player ? avatar(player.profile, { size: 22 }) : null, h('b', null, pName(player)), extra));
  }

  function paintLightbox() {
    if (!lb) return;
    const state = view.state;
    if (lb.kind === 'cat') {
      const cat = state.categories.find((c) => c.id === lb.catId);
      const caps = capturesOf(state, lb.catId);
      const a = caps.find((c) => c.playerId === lb.a) || caps[0];
      if (!a) { closeLightbox(); return; }
      lb.a = a.playerId;
      const b = lb.compare ? caps.find((c) => c.playerId === lb.b && c.playerId !== a.playerId) || caps.find((c) => c.playerId !== a.playerId) : null;
      lb.b = b ? b.playerId : null;
      const mine = (pid) => pid === view.meId;
      const others = state.categories.filter((c) => c.id !== lb.catId && myCapture(state, view.meId, c.id));
      const key = JSON.stringify([lb.catId, cat && cat.label, lb.compare, caps.map((c) => [c.playerId, c.captureId]), lb.a, lb.b,
        others.map((c) => c.id), state.players.map((p) => [p.profile.name, p.profile.color])]);
      if (key === lbKey) { for (const p of lbPics) p.set(p.id); return; }
      lbKey = key;
      for (const p of lbPics) dropPic(p);
      lbPics = [];

      const recap = (pid) => (mine(pid)
        ? h('button', { type: 'button', class: 'btn pop sm', onClick: () => { const id = lb.catId; closeLightbox(); doCapture(id); } }, 'Re-capture from the map')
        : null);
      const shown = [a, b].filter(Boolean);
      const cmp = h('div', { class: `cmp${shown.length > 1 ? ' two' : ''}` }, shown.map((c) => {
        const p = getPlayer(state, c.playerId);
        return figure(c.captureId, p, [mine(c.playerId) ? h('span', { class: 'tag' }, 'You') : null, recap(c.playerId)]);
      }));
      const strip = h('div', { class: 'strip', role: 'group', 'aria-label': 'Captures for this category' }, caps.map((c) => {
        const p = getPlayer(state, c.playerId);
        const pic = picture('', pName(p));
        pic.set(c.captureId);
        lbPics.push(pic);
        const sel = c.playerId === lb.a || c.playerId === lb.b;
        return h('button', { type: 'button', 'aria-pressed': String(sel), title: pName(p), onClick: () => {
          if (lb.compare && c.playerId !== lb.a) lb.b = c.playerId; else lb.a = c.playerId;
          paintLightbox();
        } }, pic.el, h('span', { class: 'l' }, mine(c.playerId) ? `${pName(p)} (you)` : pName(p)));
      }));
      const cmpBtn = h('button', { type: 'button', class: `btn sm${lb.compare ? ' on' : ''}`, disabled: caps.length < 2, 'aria-pressed': String(lb.compare),
        title: caps.length < 2 ? 'Needs two or more captures' : 'Show two captures side by side',
        onClick: () => { lb.compare = !lb.compare; if (!lb.compare) lb.b = null; paintLightbox(); } }, lb.compare ? 'Compare: on' : 'Compare');
      const more = others.length ? [
        h('div', { class: 'eyebrow sub' }, 'Your other captures'),
        h('div', { class: 'strip', role: 'group', 'aria-label': 'Your other captures' }, others.map((c) => {
          const m = myCapture(state, view.meId, c.id);
          const pic = picture('', c.label);
          pic.set(m.captureId);
          lbPics.push(pic);
          return h('button', { type: 'button', title: c.label, onClick: () => openCategory(c.id, view.meId) }, pic.el, h('span', { class: 'l' }, c.label));
        })),
      ] : [];
      modal.replaceChildren(h('div', { class: 'mbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Captures: ${cat ? cat.label : ''}` },
        h('div', { class: 'hd' }, h('div', null, h('span', { class: 'eyebrow' }, 'Captures'), h('h2', null, cat ? cat.label : '')),
          h('div', { class: 'acts' }, cmpBtn, h('button', { type: 'button', class: 'btn', 'data-close': '', onClick: closeLightbox }, 'Close'))),
        cmp,
        h('div', { class: 'eyebrow sub' }, caps.length > 1 ? 'Everyone’s captures for this one' : 'Only one capture so far'),
        strip, ...more));
    } else {
      const key = JSON.stringify([lb.imageId, lb.title, lb.text]);
      if (key === lbKey) { for (const p of lbPics) p.set(p.id); return; }
      lbKey = key;
      for (const p of lbPics) dropPic(p);
      lbPics = [];
      modal.replaceChildren(h('div', { class: 'mbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': lb.title },
        h('div', { class: 'hd' }, h('div', null, h('span', { class: 'eyebrow' }, 'Shared screen'), h('h2', null, lb.title)),
          h('button', { type: 'button', class: 'btn', 'data-close': '', onClick: closeLightbox }, 'Close')),
        h('div', { class: 'cmp' }, figure(lb.imageId, lb.player, lb.text ? h('span', { class: 'cp' }, lb.text) : null))));
    }
  }

  // ---- assemble -------------------------------------------------------------------------------------------------------------
  const el = h('section', { class: 'screen play-s', dataset: { screen: 'play' } },
    pbar,
    h('div', { class: 'pbody' }, mapSlot, h('aside', { class: 'side' }, catsCard, chatCard)),
    modal);

  const meOf = () => (view ? getPlayer(view.state, view.meId) : null);

  // ---- render -------------------------------------------------------------------------------------------------------------------
  function renderMinis(state, meId) {
    const key = JSON.stringify(state.players.map((p) => [p.playerId, p.profile, p.done, p.connected, captureCount(state, p.playerId)]));
    if (key === minisKey) return;
    minisKey = key;
    minis.replaceChildren(...state.players.map((p) => {
      const n = captureCount(state, p.playerId);
      const bits = [p.playerId === meId ? 'You' : pName(p), `${n} captured`, p.done ? 'done' : 'not done'];
      if (!p.connected) bits.push('away');
      return h('span', { class: `mini${p.done ? ' dn' : ''}${p.connected ? '' : ' off'}`, title: `${pName(p)}${p.playerId === meId ? ' (you)' : ''}: ${bits.slice(1).join(', ')}`, dataset: { pid: p.playerId } },
        avatar(p.profile, { size: 34 }), h('b', null, n), p.done ? h('i', null, '✓') : null);
    }));
  }

  function render(v) {
    view = v;
    const { state, meId } = v;
    const me = getPlayer(state, meId);
    const isHost = !!(me && me.isHost);

    // timers
    roundTimer.set(state.roundEndsAt, v.clockOffset);
    bannerReadout.set(state.doneCountdownEndsAt, v.clockOffset);
    banner.hidden = state.doneCountdownEndsAt == null;
    tickBar();

    // done toggle + who is done
    const myDone = !!(me && me.done);
    doneBtn.textContent = myDone ? '✓ Done (undo)' : "I'm done";
    doneBtn.classList.toggle('on', myDone);
    doneBtn.classList.toggle('pop', !myDone);
    doneBtn.setAttribute('aria-pressed', String(myDone));
    doneBtn.disabled = !me;
    const conn = connectedPlayers(state);
    doneCount.textContent = `${conn.filter((p) => p.done).length} / ${conn.length} done`;
    renderMinis(state, meId);

    // categories
    const nCats = state.categories.length;
    const seen = new Set(state.categories.map((c) => c.id));
    for (const [id, r] of catRows) if (!seen.has(id)) { r.li.remove(); dropPic(r.pic); catRows.delete(id); }
    state.categories.forEach((cat, i) => {
      let r = catRows.get(cat.id);
      if (!r) { r = catRow(cat); catRows.set(cat.id, r); }
      // a finished capture clears its busy state, flashes the map and confirms
      const b = busy.get(cat.id);
      if (b) {
        const mine = myCapture(state, meId, cat.id);
        if ((mine ? mine.captureId : null) !== b.from) {
          clearTimeout(b.timer);
          busy.delete(cat.id);
          flash();
          showToast(`Captured for "${cat.label}"`);
        }
      }
      updateCatRow(r, cat, i, state, meId);
      if (catList.children[i] !== r.li) catList.insertBefore(r.li, catList.children[i] || null);
    });
    prog.textContent = `${captureCount(state, meId)} / ${nCats} captured`;
    addForm.hidden = !isHost;
    addBtn.disabled = nCats >= MAX_CATEGORIES;
    addIn.disabled = nCats >= MAX_CATEGORIES;
    addIn.placeholder = nCats >= MAX_CATEGORIES ? `Limit of ${MAX_CATEGORIES} reached` : 'Host: add a category';
    if (knownCats) {
      const fresh = state.categories.filter((c) => !knownCats.has(c.id));
      if (fresh.length) showToast(`New category: ${fresh[fresh.length - 1].label}`);
    }
    knownCats = seen;

    renderChat(state, meId);
    if (lb) paintLightbox();
    firstRender = false;
  }

  // ---- timers owned by the screen ----------------------------------------------------------------------------------------------------
  function tickBar() {
    if (!view || view.state.doneCountdownEndsAt == null) return;
    const left = msLeft(view.state.doneCountdownEndsAt, view.clockOffset);
    bannerBar.style.width = `${Math.max(0, Math.min(100, (1 - left / DONE_COUNTDOWN_MS) * 100)).toFixed(1)}%`;
  }
  const barIv = setInterval(tickBar, 250);
  const picIv = setInterval(() => { for (const p of pics) if (p.id && !p.url) p.set(p.id); }, 1000);

  return {
    el, render,
    destroy() {
      clearInterval(barIv);
      clearInterval(picIv);
      roundTimer.destroy();
      bannerReadout.destroy();
      if (ro) ro.disconnect();
      for (const b of busy.values()) clearTimeout(b.timer);
      busy.clear();
      clearShareBusy();
      if (lb) closeLightbox();
      pics.clear();
      view = null;
    },
  };
}

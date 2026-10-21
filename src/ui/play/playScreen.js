// Play screen: the map, the "Find these" list with per-category submit, the done toggle + all-done countdown banner,
// the round timer, the host's mid-game "add a category" and the chat. Renders a GameState snapshot and never changes state:
// every action is send({ type: INTENT.x, ... }) or one of the callbacks below.
//
//   createPlayScreen({
//     send,                   // (intent) -> void
//     map,                    // { element: HTMLElement, show(provider:'google'|'apple'), load(url) }   (src/map/mapPanel.js createMapPanel())
//                             //   map.element is mounted ONCE into the map slot and never recreated, so the <webview> never reloads.
//     onCapture(categoryId),  // "Submit this spot": the app reads map.getUrl() and sends INTENT.capture { captureId, categoryId, url }.
//                             //   May return a Promise: a rejection clears the busy state and shows a toast. The category's button stays
//                             //   "Submitting..." until a snapshot carries a new captureId for me, or a rejection, or BUSY_MS.
//     onShare(caption|null),  // "Share this spot": the app sends INTENT.chatLink { id, url, text? }. caption = the chat box text
//                             //   (trimmed, <= CHAT_TEXT_MAX) or null. Same Promise/busy rules; busy ends when a new link message of mine shows up.
//     createViewer(container) // -> { element, load(url), destroy() }: a live map viewer (mode 'view') mounted into `container`
//                             //   (the screen appends viewer.element itself if the factory did not). Used for the chat-link overlay.
//   }) -> { el, render(view), destroy() }
//   view = { state, meId, clockOffset }       (state is already redacted by core's stateFor: other players' capture urls are null)
//
// NO PEEKING: this screen never reads another player's CaptureRef.url and shows no submission of anyone else, in any form. The only
// per-category information about others is a plain count ("2 of 4 found it"). Chat links are deliberate shares and are shown (as a chip).
//
// Layout: the screen is a flex column of `height: var(--play-h, 100vh)` (min 560 px), full window width (no max-width). The map slot
// (.map) fills the left grid cell; `.map-panel` is stretched over it (position:absolute; inset:0) and its own .map-bar is hidden by CSS
// because the provider switch lives in this screen's top bar (kit `segmented`, calls map.show(p)).
// Overlays (done-countdown banner, capture flash, chat-link viewer) are position:absolute inside the map slot with z-index above the
// map; the slot and the screen are `isolation:isolate`.
import { CATEGORY_LABEL_MAX, CHAT_TEXT_MAX, DONE_COUNTDOWN_MS, INTENT, MAX_CATEGORIES, makeId, msLeft, sanitizeProfile } from '../../contracts.js';
import { captureCount, capturesOf, connectedPlayers, getPlayer, myCapture } from '../../core/index.js';
import { avatar, colorHex, h, segmented, showToast, timerBox, timerReadout } from '../kit/index.js';
import './play.css';

/** A pending submit/share gives up waiting for its snapshot after this long (the button becomes usable again). */
const BUSY_MS = 10_000;
const PROVIDERS = [{ value: 'google', label: 'Google Maps' }, { value: 'apple', label: 'Apple Maps' }];
const APPLE_TIP = 'Apple: expand Look Around to full size before submitting, so others see your exact view.';
const pName = (p) => (p && p.profile && p.profile.name) || 'Player';

export function createPlayScreen({ send, map, onCapture, onShare, createViewer } = {}) {
  let view = null;
  let firstRender = true;
  let provider = 'google';
  let knownCats = null;            // Set of category ids seen so far (toast on growth)
  const busy = new Map();          // categoryId -> { from: captureId|null, timer }
  let shareBusy = null;            // { fromId: id of my newest chat link at click time, timer }

  // ---- top bar -----------------------------------------------------------------------------------------------------------
  const prov = segmented({
    label: 'Map provider', options: PROVIDERS, value: provider,
    onChange: (v) => {
      provider = v;
      map.show(v);
      closeViewer();
      tip.hidden = v !== 'apple';
      showToast(`${PROVIDERS.find((p) => p.value === v).label} start page`);
    },
  });
  const doneBtn = h('button', { type: 'button', class: 'btn dbtn pop', title: "I'm fine if the round ends now", onClick: () => {
    const me = meOf();
    if (me) send({ type: INTENT.setDone, done: !me.done });
  } }, "I'm done");
  const doneCount = h('span', { class: 'dcount muted' });
  const minis = h('div', { class: 'minis', 'aria-label': 'Players: submissions and done state' });
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
  const tip = h('p', { class: 'tip', hidden: true, role: 'note' }, '💡 ', APPLE_TIP);
  const addIn = h('input', { type: 'text', maxlength: CATEGORY_LABEL_MAX, autocomplete: 'off', placeholder: 'Host: add a category', 'aria-label': 'New category' });
  const addBtn = h('button', { class: 'btn', type: 'submit' }, '+ Add');
  const addForm = h('form', { class: 'addcat', hidden: true, onSubmit: (e) => {
    e.preventDefault();
    const label = addIn.value.trim().slice(0, CATEGORY_LABEL_MAX);
    if (!label || addBtn.disabled) return;
    send({ type: INTENT.addCategory, id: makeId(), label });
    addIn.value = '';
  } }, addIn, addBtn);
  const catsCard = h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h3', null, 'Find these'), prog), catList, tip, addForm);
  const catRows = new Map();   // categoryId -> row

  function catRow(cat) {
    const badge = h('span', { class: 'bdg' });
    const label = h('span', { class: 't' });
    const status = h('span', { class: 'stat' });
    const go = h('button', { type: 'button', class: 'go', onClick: () => goToMySpot(cat.id) }, 'Go to my spot');
    const cap = h('button', { type: 'button', class: 'cap', onClick: () => doCapture(cat.id) });
    const li = h('li', { dataset: { id: cat.id } }, badge, h('span', { class: 'lb' }, label, status), h('span', { class: 'acts' }, go, cap));
    return { li, badge, label, status, go, cap };
  }

  function updateCatRow(row, cat, i, state, meId) {
    const mine = myCapture(state, meId, cat.id);
    row.li.classList.toggle('done', !!mine);
    row.badge.textContent = mine ? '✓' : String(i + 1);
    row.label.textContent = cat.label;
    // a plain count only: never who, never what
    const found = capturesOf(state, cat.id).length;
    const total = state.players.length;
    row.status.replaceChildren(...(mine ? [h('b', { class: 'sub' }, '✓ Submitted'), ' · '] : []), `${found} of ${total} found it`);
    row.go.hidden = !mine;
    row.go.disabled = !mine || !mine.url;
    row.go.setAttribute('aria-label', `Go to my submitted spot for ${cat.label}`);
    const b = busy.get(cat.id);
    row.cap.disabled = !!b;
    row.cap.textContent = b ? 'Submitting…' : mine ? 'Re-submit' : 'Submit this spot';
    row.cap.setAttribute('aria-label', `${mine ? 'Re-submit' : 'Submit this spot for'} ${cat.label}`);
  }

  function goToMySpot(categoryId) {
    if (!view) return;
    const mine = myCapture(view.state, view.meId, categoryId);
    if (!mine || !mine.url) return;
    closeViewer();   // the viewer overlay covers the map: show the map again
    map.load(mine.url);
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
      showToast(`Submit failed${e && e.message ? `: ${e.message}` : ''}`);
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
  const shareBtn = h('button', { type: 'button', class: 'btn sm', title: 'Post your current map spot as a link (the text box becomes its caption)', onClick: doShare }, 'Share this spot');
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
  const msgRows = new Map();   // message id -> { el }
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
    if (m.url) {
      const url = m.url;   // kept in the closure only, never written into the DOM
      body.append(h('button', { type: 'button', class: 'spot', 'aria-label': `Open the spot shared by ${pName(p)}`,
        onClick: () => openViewer(url, `${pName(p)}’s shared spot`) }, h('span', { class: 'pin', 'aria-hidden': 'true' }, '📍'), 'Shared spot', h('span', { class: 'go-arrow', 'aria-hidden': 'true' }, '→')));
      if (m.text) body.append(h('div', { class: 'cp' }, m.text));
    } else {
      body.append(h('div', { class: 'tx' }, m.text || ''));
    }
    const el = h('div', { class: `msg${m.playerId === meId ? ' me' : ''}`, style: `--c:${colorHex(profile.color)}`, dataset: { id: m.id } },
      avatar(profile, { size: 28 }), body);
    return { el };
  }

  function renderChat(state, meId) {
    let added = 0;
    const ids = new Set(state.chat.map((m) => m.id));
    for (const [id, r] of msgRows) {
      if (!ids.has(id)) { r.el.remove(); msgRows.delete(id); }
    }
    for (const m of state.chat) {
      if (!msgRows.has(m.id)) { msgRows.set(m.id, msgRow(m, state, meId)); added++; }
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
    // Share busy ends when a newer link message of mine appears
    if (shareBusy) {
      const last = myLastChatLink(state, meId);
      if ((last ? last.id : null) !== shareBusy.fromId) clearShareBusy();
    }
  }
  const myLastChatLink = (state, meId) => [...state.chat].reverse().find((m) => m.playerId === meId && m.url) || null;
  function doShare() {
    if (shareBusy || !view) return;
    const last = myLastChatLink(view.state, view.meId);
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
    shareBtn.textContent = 'Share this spot';
  }

  // ---- chat-link viewer overlay (over the map area) --------------------------------------------------------------------------
  // vw = { url, viewer, ov, title, lastFocus }. One at a time; clicking another chip re-uses the open viewer. Close destroys it.
  let vw = null;
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); } };

  function openViewer(url, title) {
    if (!createViewer) return;
    if (vw) {
      vw.url = url;
      vw.titleEl.textContent = title;
      vw.viewer.load(url);
      return;
    }
    const body = h('div', { class: 'vw-body' });
    const titleEl = h('b', { class: 'vw-title' }, title);
    const backBtn = h('button', { type: 'button', class: 'btn pop sm', 'data-back': '', onClick: () => { if (vw) vw.viewer.load(vw.url); } }, 'Back to shared spot');
    const closeBtn = h('button', { type: 'button', class: 'btn sm', 'data-close': '', onClick: closeViewer }, 'Close');
    const ov = h('div', { class: 'ov vw', role: 'dialog', 'aria-label': 'Shared spot viewer' },
      h('div', { class: 'vw-bar' }, h('span', { class: 'pin', 'aria-hidden': 'true' }, '📍'), titleEl, h('span', { class: 'sp' }), backBtn, closeBtn), body);
    mapSlot.append(ov);
    const viewer = createViewer(body);
    if (viewer.element && !viewer.element.isConnected) body.append(viewer.element);
    vw = { url, viewer, ov, titleEl, lastFocus: document.activeElement };
    document.addEventListener('keydown', onKey, true);
    viewer.load(url);
    closeBtn.focus();
  }
  function closeViewer() {
    if (!vw) return;
    const { viewer, ov, lastFocus } = vw;
    vw = null;
    document.removeEventListener('keydown', onKey, true);
    try { viewer.destroy(); } catch (_) { /* already gone */ }
    ov.remove();
    if (lastFocus && lastFocus.isConnected && lastFocus.focus) try { lastFocus.focus(); } catch (_) { /* element gone */ }
  }

  // ---- assemble -------------------------------------------------------------------------------------------------------------
  const el = h('section', { class: 'screen play-s', dataset: { screen: 'play' } },
    pbar,
    h('div', { class: 'pbody' }, mapSlot, h('aside', { class: 'side' }, catsCard, chatCard)));

  const meOf = () => (view ? getPlayer(view.state, view.meId) : null);

  // ---- render -------------------------------------------------------------------------------------------------------------------
  function renderMinis(state, meId) {
    const key = JSON.stringify(state.players.map((p) => [p.playerId, p.profile, p.done, p.connected, captureCount(state, p.playerId)]));
    if (key === minisKey) return;
    minisKey = key;
    minis.replaceChildren(...state.players.map((p) => {
      const n = captureCount(state, p.playerId);
      const bits = [p.playerId === meId ? 'You' : pName(p), `${n} submitted`, p.done ? 'done' : 'not done'];
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
    for (const [id, r] of catRows) if (!seen.has(id)) { r.li.remove(); catRows.delete(id); }
    state.categories.forEach((cat, i) => {
      let r = catRows.get(cat.id);
      if (!r) { r = catRow(cat); catRows.set(cat.id, r); }
      // a finished submit clears its busy state, flashes the map and confirms
      const b = busy.get(cat.id);
      if (b) {
        const mine = myCapture(state, meId, cat.id);
        if ((mine ? mine.captureId : null) !== b.from) {
          clearTimeout(b.timer);
          busy.delete(cat.id);
          flash();
          showToast(`Submitted for "${cat.label}"`);
        }
      }
      updateCatRow(r, cat, i, state, meId);
      if (catList.children[i] !== r.li) catList.insertBefore(r.li, catList.children[i] || null);
    });
    prog.textContent = `${captureCount(state, meId)} / ${nCats} submitted`;
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
    firstRender = false;
  }

  // ---- timers owned by the screen ----------------------------------------------------------------------------------------------------
  function tickBar() {
    if (!view || view.state.doneCountdownEndsAt == null) return;
    const left = msLeft(view.state.doneCountdownEndsAt, view.clockOffset);
    bannerBar.style.width = `${Math.max(0, Math.min(100, (1 - left / DONE_COUNTDOWN_MS) * 100)).toFixed(1)}%`;
  }
  const barIv = setInterval(tickBar, 250);

  return {
    el, render,
    destroy() {
      clearInterval(barIv);
      roundTimer.destroy();
      bannerReadout.destroy();
      if (ro) ro.disconnect();
      for (const b of busy.values()) clearTimeout(b.timer);
      busy.clear();
      clearShareBusy();
      closeViewer();
      view = null;
    },
  };
}

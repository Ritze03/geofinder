// Lobby screen. Renders a GameState snapshot, never changes state itself: every action is send({ type: INTENT.x, ... }).
//   createLobbyScreen({ send, onLeave? }) -> { el, render(view), destroy() }
//   view = { state, meId, clockOffset }
// D9: no countdown. Everyone (host included) toggles Ready; the host's Start enables via canStart(state).
// The skeleton is built once and render() patches it, so typed text / focus / the slider survive every snapshot.
import {
  CATEGORY_LABEL_MAX, ERR, INTENT, MAX_CATEGORIES, MAX_PLAYERS, MAX_SUGGESTIONS, MIN_PLAYERS, ROUND_TIMES_MIN, makeId,
} from '../../contracts.js';
import { connectedPlayers, startBlocker } from '../../core/index.js';
import { h, avatar, button, card, iconButton, playerList, showToast, statusPill, tag } from '../kit/index.js';
import './lobby.css';

/** Adapter over core's startBlocker (THE start rule, also used by the host on startGame) -> what this screen shows. */
function canStart(state) {
  const connected = connectedPlayers(state);
  const total = connected.length;
  const ready = connected.filter((p) => p.ready).length;
  const blocker = startBlocker(state);
  const reason = {
    [ERR.tooFewPlayers]: `Need at least ${MIN_PLAYERS} players to start`,
    [ERR.noCategories]: 'Add at least one category to start',
    [ERR.notReady]: `Waiting for everyone to be ready (${ready}/${total})`,
  }[blocker] ?? (blocker ? 'Cannot start yet' : null);
  return { ok: blocker === null, reason, ready, total };
}

export function createLobbyScreen({ send, onLeave } = {}) {
  let view = null;
  let editing = false; // an inline rename is open: don't rebuild the category list under it

  // ---- things to find ----
  const catCount = h('span', { class: 'eyebrow' });
  const catTag = tag('');
  const catList = h('ul', { class: 'cats' });
  const addIn = h('input', { type: 'text', maxlength: CATEGORY_LABEL_MAX, autocomplete: 'off', placeholder: 'Add a category, e.g. a pink roof', 'aria-label': 'New category' });
  const addBtn = button({ label: 'Add', variant: 'pop', type: 'submit' });
  const addForm = h('form', { class: 'addrow', onSubmit: (e) => {
    e.preventDefault();
    const label = addIn.value.trim();
    if (!label || addBtn.disabled) return;
    send({ type: INTENT.addCategory, id: makeId(), label });
    addIn.value = '';
  } }, addIn, addBtn);
  const sugIn = h('input', { type: 'text', maxlength: CATEGORY_LABEL_MAX, autocomplete: 'off', placeholder: 'Suggest something to find', 'aria-label': 'Suggest a category' });
  const sugBtn = button({ label: 'Suggest', variant: 'pop', type: 'submit' });
  const sugForm = h('form', { class: 'addrow', onSubmit: (e) => {
    e.preventDefault();
    const label = sugIn.value.trim();
    if (!label || sugBtn.disabled) return;
    send({ type: INTENT.suggestCategory, id: makeId(), label });
    sugIn.value = '';
    showToast('Suggestion sent to the host');
  } }, sugIn, sugBtn);
  const catCard = card({ title: 'Things to find', eyebrow: catCount, right: catTag }, catList, addForm, sugForm);

  // ---- suggestions ----
  const sugCount = h('span', { class: 'count' });
  const sugList = h('ul', { class: 'sug' });
  const sugCard = card({ title: 'Suggestions from players', level: 3, right: sugCount }, sugList);

  // ---- room code ----
  const codeEl = h('code', { 'aria-label': 'Room code' });
  const copyBtn = button({ label: 'Copy code', onClick: async () => {
    const code = view ? view.state.roomCode : codeEl.textContent;
    try {
      await navigator.clipboard.writeText(code);
      showToast('Room code copied');
    } catch (_) {
      showToast(`Room code: ${code}`);
    }
  } });
  const roomCard = h('div', { class: 'card invite' },
    h('div', null, h('span', { class: 'eyebrow' }, 'Room code'), h('small', null, 'Friends type this under Join room. The room runs peer to peer.')),
    codeEl, copyBtn);

  // ---- round time ----
  const rtOut = h('output', { class: 'num', for: 'lob-rt' });
  const rt = h('input', {
    type: 'range', id: 'lob-rt', min: 0, max: ROUND_TIMES_MIN.length - 1, step: 1, value: 0, 'aria-label': 'Round time in minutes',
    onInput: () => showMinutes(ROUND_TIMES_MIN[+rt.value]),
    onChange: () => send({ type: INTENT.setRoundTime, minutes: ROUND_TIMES_MIN[+rt.value] }),
  });
  const rtTag = tag('Host', { host: true });
  const timeCard = card({ title: 'Round time', level: 3, right: rtTag },
    h('div', { class: 'time' }, rtOut, rt, h('div', { class: 'ticks' }, ROUND_TIMES_MIN.map((m) => h('span', null, m)))));
  function showMinutes(m) { rtOut.replaceChildren(String(m), ' ', h('small', null, 'min')); }

  // ---- players + ready ----
  const plCount = h('span', { class: 'muted', style: 'font-weight:600' });
  const plHost = h('div');
  const readyTxt = h('div', { class: 'txt' });
  const readyBtn = button({ label: 'Ready', size: 'lg', onClick: () => {
    const me = meOf(); if (me) send({ type: INTENT.setReady, ready: !me.ready });
  } });
  const startBtn = button({ label: 'Start game', variant: 'pop', size: 'lg', disabled: true, onClick: () => {
    if (!startBtn.disabled) send({ type: INTENT.startGame });
  } });
  const readyBox = h('div', { class: 'ready-box' }, readyTxt, h('div', { class: 'acts' }, readyBtn, startBtn));
  const leaveBtn = onLeave ? h('div', { class: 'leave' }, button({ label: 'Leave room', size: 'sm', onClick: () => onLeave() })) : null;
  const plCard = card({ title: ['Players ', plCount], level: 3 }, plHost, readyBox, leaveBtn);

  const el = h('section', { class: 'screen', dataset: { screen: 'lobby' } },
    h('div', { class: 'lobby' },
      h('div', { class: 'col' }, catCard, sugCard),
      h('div', { class: 'col' }, roomCard, timeCard, plCard)));

  const meOf = () => (view ? view.state.players.find((p) => p.playerId === view.meId) || null : null);

  // ---- category rows ----
  function catRow(cat, i, isHost) {
    const li = h('li', { dataset: { id: cat.id } }, h('span', { class: 'n' }, i + 1));
    if (!isHost) { li.append(h('span', { class: 't' }, cat.label)); return li; }
    const label = h('button', { type: 'button', class: 't edit', title: 'Click to rename', onClick: () => startEdit(li, cat, label) }, cat.label);
    li.append(label, iconButton({ kind: 'x', label: `Remove ${cat.label}`, onClick: () => send({ type: INTENT.removeCategory, categoryId: cat.id }) }));
    return li;
  }
  function startEdit(li, cat, label) {
    editing = true;
    let finished = false;
    const input = h('input', { type: 'text', maxlength: CATEGORY_LABEL_MAX, autocomplete: 'off', value: cat.label, 'aria-label': 'Rename category' });
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      editing = false;
      const next = input.value.trim();
      if (commit && next && next !== cat.label) send({ type: INTENT.renameCategory, categoryId: cat.id, label: next });
      if (view) render(view);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  function sugRow(s, players, isHost) {
    const by = players.find((p) => p.playerId === s.playerId);
    const li = h('li', { dataset: { id: s.id } },
      h('span', { class: 'by' }, by ? avatar(by.profile, { size: 28 }) : null, by ? by.profile.name : 'Someone'),
      h('span', { class: 't' }, s.label));
    if (isHost) {
      li.append(
        iconButton({ kind: 'ok', label: `Accept ${s.label}`, disabled: false, onClick: () => send({ type: INTENT.acceptSuggestion, suggestionId: s.id }) }),
        iconButton({ kind: 'no', label: `Reject ${s.label}`, onClick: () => send({ type: INTENT.rejectSuggestion, suggestionId: s.id }) }));
    }
    return li;
  }

  // ---- render ----
  function render(v) {
    view = v;
    const { state, meId } = v;
    const me = state.players.find((p) => p.playerId === meId) || null;
    const isHost = !!(me && me.isHost);
    const cs = canStart(state);
    const nCats = state.categories.length;

    // categories
    catCount.textContent = `${nCats} thing${nCats === 1 ? '' : 's'} to find`;
    catTag.textContent = isHost ? 'You are the host: edit the list' : 'Only the host edits this list';
    catTag.classList.toggle('host', isHost);
    if (!editing) {
      catList.replaceChildren(...(nCats
        ? state.categories.map((c, i) => catRow(c, i, isHost))
        : [h('li', { class: 'empty' }, 'No categories yet.')]));
    }
    addForm.hidden = !isHost;
    addBtn.disabled = nCats >= MAX_CATEGORIES;
    addIn.placeholder = nCats >= MAX_CATEGORIES ? `Limit of ${MAX_CATEGORIES} reached` : 'Add a category, e.g. a pink roof';
    sugForm.hidden = isHost;
    sugBtn.disabled = !me || state.suggestions.length >= MAX_SUGGESTIONS;

    // suggestions
    sugCount.textContent = String(state.suggestions.length);
    sugList.replaceChildren(...(state.suggestions.length
      ? state.suggestions.map((s) => sugRow(s, state.players, isHost))
      : [h('li', { class: 'empty' }, 'No suggestions right now.')]));

    // room + time
    codeEl.textContent = state.roomCode;
    const minutes = state.settings.roundMinutes;
    const idx = Math.max(0, ROUND_TIMES_MIN.indexOf(minutes));
    if (document.activeElement !== rt) { rt.value = String(idx); showMinutes(ROUND_TIMES_MIN[idx]); }
    rt.disabled = !isHost;
    rtTag.classList.toggle('host', isHost);
    rtTag.textContent = isHost ? 'Host' : 'Set by the host';

    // players + ready
    plCount.textContent = `${state.players.length} / ${MAX_PLAYERS}`;
    plHost.replaceChildren(playerList(state.players, {
      meId, size: 44, trailing: (p) => statusPill(p.ready),
    }));
    const myReady = !!(me && me.ready);
    readyBtn.textContent = myReady ? 'Not ready' : 'Ready';
    readyBtn.disabled = !me;
    readyBtn.classList.toggle('pop', !myReady && !cs.ok);
    startBtn.hidden = !isHost;
    startBtn.disabled = !(isHost && cs.ok);
    readyBox.classList.toggle('go', cs.ok);
    readyTxt.textContent = cs.ok
      ? (isHost ? 'Everyone is ready. Start the game when you like.' : 'Everyone is ready. Waiting for the host to start.')
      : cs.reason;
  }

  return { el, render, destroy() { view = null; } };
}

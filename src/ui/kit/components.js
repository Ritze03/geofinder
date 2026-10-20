// Shared widgets: buttons, cards, tags, player chip/list, segmented toggle, star rating, timer readout, toast.
import { STARS_MAX, STARS_MIN, msLeft } from '../../contracts.js';
import { h } from './dom.js';
import { avatar } from './avatar.js';

/** Buttons. variant: 'pop' (yellow primary) | undefined; size: 'lg' | 'sm' | undefined. `children` may be a string or nodes. */
export function button({ label, children, variant, size, onClick, disabled, title, type = 'button', class: cls } = {}) {
  return h('button', {
    type, title, disabled: !!disabled, onClick,
    class: ['btn', variant, size, cls].filter(Boolean).join(' '),
  }, label, children);
}

/** Small square icon button for list rows. kind: 'x' (remove) | 'ok' (accept) | 'no' (reject). */
export function iconButton({ kind, label, onClick, disabled }) {
  const glyph = kind === 'ok' ? '✓' : '✕';
  return h('button', { type: 'button', class: `ibtn ${kind}`, 'aria-label': label, title: label, onClick, disabled: !!disabled }, glyph);
}

/** Card: <div class="card"> with an optional <header> (title h2/h3 + optional eyebrow under it + optional `right` node).
 *  title/eyebrow/right may be strings or Nodes.
 *  card({ title, eyebrow, right, level: 2|3, class }, ...bodyChildren) */
export function card({ title, eyebrow, right, level = 2, class: cls } = {}, ...children) {
  const el = h('div', { class: ['card', cls].filter(Boolean).join(' ') });
  if (title || right) {
    el.append(h('header', null,
      h('div', null, title ? h(level === 3 ? 'h3' : 'h2', null, title) : null, eyebrow ? (eyebrow instanceof Node ? eyebrow : h('span', { class: 'eyebrow' }, eyebrow)) : null),
      right));
  }
  el.append(...children.flat().filter((c) => c != null));
  return el;
}

/** Pill tag. `host` gives the yellow host variant. */
export function tag(text, { host = false } = {}) {
  return h('span', { class: host ? 'tag host' : 'tag' }, text);
}

/**
 * Avatar + name + tags (Host / You / Away). Use directly or through playerList.
 * @param {import('../../contracts.js').Player} player
 * @param {{meId?:string, size?:number}} [opts]
 */
export function playerChip(player, { meId, size = 44 } = {}) {
  return h('span', { class: 'pchip' },
    avatar(player.profile, { size }),
    h('span', { class: 'nm' },
      h('b', null, player.profile.name || 'Player'),
      player.isHost ? tag('Host', { host: true }) : null,
      player.playerId === meId ? tag('You') : null,
      player.connected === false ? tag('Away') : null));
}

/**
 * <ul class="pl"> of playerChips in the given (join) order; disconnected players get li.off (dimmed).
 * `trailing(player)` returns an optional Node placed at the right of each row (ready pill, done tick, score ...).
 */
export function playerList(players, { meId, size = 44, trailing } = {}) {
  return h('ul', { class: 'pl' }, players.map((p) =>
    h('li', { class: p.connected === false ? 'off' : '', dataset: { pid: p.playerId } },
      playerChip(p, { meId, size }), trailing ? trailing(p) : null)));
}

/** Ready/not-ready style pill (lobby). */
export function statusPill(on, onText = '✓ Ready', offText = 'Not ready') {
  return h('span', { class: on ? 'st on' : 'st' }, on ? onText : offText);
}

/**
 * Segmented toggle (the mockup's .seg, e.g. Google Maps / Apple Maps).
 * @param {{options:{value:string,label:string}[], value:string, onChange(value:string):void, label?:string}} o
 * @returns {{el:HTMLElement, set(value:string):void}}
 */
export function segmented({ options, value, onChange, label }) {
  const btns = options.map((o) => h('button', { type: 'button', dataset: { value: o.value }, onClick: () => { set(o.value); onChange && onChange(o.value); } }, o.label));
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label }, btns);
  function set(v) { btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v))); }
  set(value);
  return { el, set };
}

/**
 * Star rating, 1..5 (STARS_MIN..STARS_MAX). Clicking star n calls onRate(n); the widget does NOT keep the value itself:
 * the caller re-renders from state with set({value}) (host-authoritative). `disabled` (e.g. own capture) greys it out.
 * @param {{value?:number, disabled?:boolean, onRate?(stars:number):void}} [o]
 * @returns {{el:HTMLElement, set(p:{value?:number, disabled?:boolean}):void}}
 */
export function starRating({ value = 0, disabled = false, onRate } = {}) {
  const btns = [];
  for (let n = STARS_MIN; n <= STARS_MAX; n++) {
    btns.push(h('button', { type: 'button', class: 'star', 'aria-label': `${n} star${n > 1 ? 's' : ''}`, onClick: () => onRate && onRate(n) }, '★'));
  }
  const el = h('div', { class: 'stars', role: 'group', 'aria-label': 'Rating' }, btns);
  function set(p = {}) {
    if (p.value !== undefined) value = p.value || 0;
    if (p.disabled !== undefined) disabled = !!p.disabled;
    btns.forEach((b, i) => { b.classList.toggle('on', i + 1 <= value); b.disabled = disabled; });
  }
  set();
  return { el, set };
}

/** mm:ss for a millisecond amount (rounded UP to whole seconds so 0:00 only shows at true zero); null => '--:--'. */
export function formatClock(ms) {
  if (ms == null) return '--:--';
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Time-left readout: <b class="timer-readout mono"> (monospace + tabular-nums, D7) that refreshes itself every 250 ms until destroy().
 * `deadline` is a HOST-clock epoch ms (or null => '--:--'), `offset` is view.clockOffset. Gets class `low` under `lowMs` (default 60 s).
 * Call set(deadline, offset) whenever a new snapshot arrives; call destroy() when the screen is torn down.
 * @returns {{el:HTMLElement, set(deadline:(number|null), offset:number):void, destroy():void}}
 */
export function timerReadout(deadline, offset = 0, { lowMs = 60_000, class: cls } = {}) {
  const el = h('b', { class: ['timer-readout', 'mono', cls].filter(Boolean).join(' ') });
  const tick = () => {
    const left = msLeft(deadline, offset);
    el.textContent = formatClock(left);
    el.classList.toggle('low', left != null && left < lowMs);
  };
  tick();
  const iv = setInterval(tick, 250);
  return {
    el,
    set(d, o) { deadline = d; if (o !== undefined) offset = o; tick(); },
    destroy() { clearInterval(iv); },
  };
}

/** The mockup's bordered "Time left 14:32" box around a timerReadout. Same return shape as timerReadout (el = the box). */
export function timerBox(deadline, offset = 0, { label = 'Time left', ...opts } = {}) {
  const r = timerReadout(deadline, offset, opts);
  const el = h('div', { class: 'timer' }, h('span', { class: 'eyebrow' }, label), r.el);
  return { el, set: r.set, destroy: r.destroy };
}

let toastEl = null;
let toastTimer = 0;
/** Show a transient message at the bottom centre (one at a time; a new one replaces the old). */
export function showToast(message, ms = 2600) {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast', role: 'status' });
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  // force a reflow so a replaced toast re-animates
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

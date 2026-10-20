// Profile screen (local, before any room exists). Name + colour + head + face, presets only (contracts.Profile),
// then Create room / Join room (D12: a desktop app has no invite URL, the host's code is typed in by the others).
//   createProfileScreen({ initial, onCreate(profile), onJoin(profile, roomCode) }) -> { el, destroy() }
import { COLORS, FACES, HEADS, NAME_MAX, normalizeRoomCode, sanitizeProfile, defaultProfile } from '../../contracts.js';
import { h, avatarSvg, button, card, colorHex } from '../kit/index.js';
import './profile.css';

const CODE_HINT = 'That does not look like a room code. Codes look like GEO-7Q4K.';

export function createProfileScreen({ initial, onCreate, onJoin } = {}) {
  const look = { ...defaultProfile(), ...(initial || {}) };
  // unknown ids fall back to the first preset; the name stays as typed (may be empty => must be typed)
  const clean = sanitizeProfile(look);
  const p = { name: look.name ? clean.name : '', color: clean.color, head: clean.head, face: clean.face };

  // ---- stage (left) ----
  const bigAv = h('div', { class: 'big' });
  const bigName = h('div', { class: 'pname' });
  const tagAv = h('span');
  const tagName = h('span');
  const tagDot = h('span', { class: 'dot' });
  const stage = card({ class: 'stage' },
    h('span', { class: 'eyebrow' }, 'Your player'), bigAv, bigName,
    h('div', { class: 'nametag' }, tagAv, tagName, tagDot));

  // ---- editor (right) ----
  const nameIn = h('input', {
    type: 'text', id: 'pf-name', maxlength: NAME_MAX, autocomplete: 'off', spellcheck: false, value: p.name,
    placeholder: 'Your name', 'aria-describedby': 'pf-name-err', onInput: () => { p.name = nameIn.value; nameErr.textContent = ''; nameIn.classList.remove('invalid'); renderLive(); },
  });
  nameIn.maxLength = NAME_MAX;
  const nameErr = h('p', { class: 'err', id: 'pf-name-err', role: 'alert' });
  const swEl = h('div', { class: 'sw' });
  const headEl = h('div', { class: 'pick' });
  const faceEl = h('div', { class: 'pick' });

  const joinIn = h('input', {
    type: 'text', id: 'pf-code', maxlength: 12, autocomplete: 'off', spellcheck: false, placeholder: 'Room code, e.g. GEO-7Q4K', 'aria-label': 'Room code',
    onInput: () => { joinErr.textContent = ''; joinIn.classList.remove('invalid'); },
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); join(); } },
  });
  const joinErr = h('p', { class: 'err', role: 'alert' });
  const createBtn = button({ label: 'Create room', variant: 'pop', size: 'lg', onClick: create });
  const joinBtn = button({ label: 'Join room', size: 'lg', onClick: join });

  const editor = card({ class: 'editor' },
    h('div', null, h('h2', null, 'Make your player'),
      h('p', { class: 'muted', style: 'margin-top:4px' }, 'This is how your friends will see you in the lobby, chat and results.')),
    h('div', null, h('label', { for: 'pf-name' }, 'Name'), nameIn, nameErr),
    h('div', { class: 'grp' }, h('h3', null, 'Color'), swEl),
    h('div', { class: 'grp' }, h('h3', null, 'Head'), headEl),
    h('div', { class: 'grp' }, h('h3', null, 'Face'), faceEl),
    h('div', { class: 'room' },
      createBtn,
      h('span', { class: 'or' }, 'or'),
      h('div', { class: 'join' }, h('div', { class: 'joinrow' }, joinIn, joinBtn), joinErr)),
    h('p', { class: 'muted', style: 'font-size:13px;margin-top:-10px' }, 'Create a room and share its code with your friends, or type the code a friend gave you.'),
    h('p', { class: 'saved' }, 'Saved on this computer.'));

  const el = h('section', { class: 'screen', dataset: { screen: 'profile' } }, h('div', { class: 'prof' }, stage, editor));

  // ---- rendering ----
  function renderLive() {
    const hex = colorHex(p.color);
    el.style.setProperty('--me', hex);
    bigAv.replaceChildren(avatarSvg(p, 230));
    const shown = p.name.trim() || 'Player';
    bigName.textContent = shown;
    tagName.textContent = shown;
    tagAv.replaceChildren(avatarSvg(p, 30));
    tagDot.style.background = hex;
  }
  function pk(id, key) { p[key] = id; renderPickers(); renderLive(); bigAv.classList.add('bump'); setTimeout(() => bigAv.classList.remove('bump'), 180); }
  function renderPickers() {
    swEl.replaceChildren(...COLORS.map((c, i) => h('button', {
      type: 'button', style: `--c:${c.hex}`, 'aria-pressed': String(c.id === p.color), 'aria-label': `Color ${i + 1}`, onClick: () => pk(c.id, 'color'),
    })));
    headEl.replaceChildren(...HEADS.map((x) => h('button', {
      type: 'button', 'aria-pressed': String(x.id === p.head), 'aria-label': `${x.label} head`, title: x.label, onClick: () => pk(x.id, 'head'),
    }, avatarSvg({ ...p, head: x.id }, 48))));
    faceEl.replaceChildren(...FACES.map((x) => h('button', {
      type: 'button', 'aria-pressed': String(x.id === p.face), 'aria-label': `${x.label} face`, title: x.label, onClick: () => pk(x.id, 'face'),
    }, avatarSvg({ ...p, face: x.id }, 48))));
  }

  // ---- actions ----
  /** Validated profile or null (shows the error and focuses the name). */
  function validProfile() {
    if (!p.name.trim()) {
      nameErr.textContent = 'Enter a name first.';
      nameIn.classList.add('invalid');
      nameIn.focus();
      return null;
    }
    return sanitizeProfile(p);
  }
  function create() {
    const prof = validProfile();
    if (prof && onCreate) onCreate(prof);
  }
  function join() {
    const prof = validProfile();
    if (!prof) return;
    const code = normalizeRoomCode(joinIn.value);
    if (!code) {
      joinErr.textContent = joinIn.value.trim() ? CODE_HINT : 'Type the room code you got from the host.';
      joinIn.classList.add('invalid');
      joinIn.focus();
      return;
    }
    if (onJoin) onJoin(prof, code);
  }

  renderPickers();
  renderLive();
  return { el, destroy() {} };
}

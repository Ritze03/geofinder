// App controller: Profile -> (Create | Join) -> Connecting -> Lobby -> Play -> Review -> Results -> (Play again) Lobby.
// The screen on show follows state.phase. One game = one session + one image store + (host) one host driver; leaving or being thrown out
// (reject, host gone) tears all of that down and lands on the Profile screen with a notice.
//
//   startApp(root)  URL params: ?local (BroadcastChannel transport instead of Trystero), ?pid=<x> (separate identity per tab, tests)
//
// Client: MSG.state (newer rev only) -> render. UI intents -> session.sendToHost(MSG.intent). Host: src/app/host.js applies and broadcasts;
// its own UI goes through the very same path (sendToHost loops back). Images: bytes travel as MSG.imgData (net/images.js), snapshots carry refs.
import {
  INTENT, MAX_PLAYERS, MSG, SESSION_EVENT, clockOffset, createInitialState, defaultProfile, makeId, makeRoomCode,
} from '../contracts.js';
import { getPlayer } from '../core/index.js';
import { createImageStore, createSession, loadIdentity, saveProfile } from '../net/index.js';
import { createMapPanel } from '../map/mapPanel.js';
import { createLobbyScreen } from '../ui/lobby/lobbyScreen.js';
import { createPlayScreen } from '../ui/play/playScreen.js';
import { createProfileScreen } from '../ui/profile/profileScreen.js';
import { createResultsScreen } from '../ui/results/resultsScreen.js';
import { createReviewScreen } from '../ui/review/reviewScreen.js';
import { button, card, h, showToast } from '../ui/kit/index.js';
import { createHost } from './host.js';
import { createStubMap } from './stubMap.js';
import './app.css';

const REJECT_TEXT = {
  full: 'That room is full.',
  started: 'That game has already started.',
  protocol: 'Version mismatch: you and the host run different versions of Geofinder.',
};

export function startApp(root) {
  const params = new URLSearchParams(location.search);
  const pid = params.get('pid') || null;
  const transport = params.has('local') ? 'local' : 'trystero';
  const identity = loadIdentity(pid);

  // ---- chrome: header (in a game), notice (after being thrown out), stage (the screens) ----
  const roomEl = h('code', { class: 'room', dataset: { testid: 'room-code' } });
  const countEl = h('span', { class: 'hcount muted', dataset: { testid: 'player-count' } });
  const leaveBtn = button({ label: 'Leave', size: 'sm', onClick: () => leaveGame() });
  leaveBtn.dataset.testid = 'leave';
  const header = h('header', { class: 'appbar', hidden: true }, h('b', { class: 'brand' }, 'Geofinder'), roomEl, countEl, h('span', { class: 'sp' }), leaveBtn);
  const notice = h('div', { class: 'notice', role: 'alert', hidden: true, dataset: { testid: 'notice' } });
  const stage = h('main', { class: 'app-main' });
  root.classList.add('app');
  root.append(header, notice, stage);

  const setNotice = (text) => { notice.textContent = text || ''; notice.hidden = !text; };

  // ---- screen switching: exactly one screen mounted; destroy() stops its timers, we remove its el ----
  let current = null; // { kind, screen, dispose? }
  function unmount() {
    if (!current) return;
    current.screen.destroy?.();
    current.screen.el.remove();
    current.dispose?.();
    current = null;
  }
  function mount(kind, make, dispose) {
    if (current && current.kind === kind) return current;
    unmount();
    current = { kind, screen: make(), dispose };
    stage.append(current.screen.el);
    return current;
  }

  // ---- profile ----
  function showProfile(text) {
    unmount();
    header.hidden = true;
    setNotice(text);
    mount('profile', () => createProfileScreen({
      initial: identity.profile ?? defaultProfile(),
      onCreate: (profile) => begin(profile, true, makeRoomCode()),
      onJoin: (profile, roomCode) => begin(profile, false, roomCode),
    }));
  }

  // ---- one game ----
  /** @type {null | { session:any, store:any, isHost:boolean, roomCode:string, state:any, rev:number, offset:number, host:any, map:any, offs:Function[] }} */
  let game = null;

  function begin(profile, isHost, roomCode) {
    saveProfile(profile, pid);
    identity.profile = profile;
    setNotice(null);
    const session = createSession({ roomCode, transport, profile, playerId: identity.playerId, isHost });
    const store = createImageStore(session);
    const g = (game = { session, store, isHost, roomCode, state: null, rev: -1, offset: 0, host: null, map: null, offs: [] });
    const hostId = () => session.hostPlayerId();

    g.offs.push(
      store.onImage(() => renderNow()),
      session.on(SESSION_EVENT.error, ({ message }) => console.error('[net]', message)),
    );
    if (isHost) {
      g.host = createHost({
        session,
        state: createInitialState({ playerId: identity.playerId, profile }, roomCode),
        onState: (msg) => receiveState(g, msg),
        onIntentError: (from, intent, err) => { if (from === identity.playerId) showToast(`Not possible right now (${err})`); },
      });
    } else {
      g.offs.push(
        session.on(MSG.state, (msg, from) => { if (from === hostId()) receiveState(g, msg); }),
        session.on(MSG.reject, (data, from) => {
          if (from === hostId()) endGame(REJECT_TEXT[data?.reason] ?? 'The host did not let you in.');
        }),
        session.on(SESSION_EVENT.hostGone, () => endGame('Host left — game over.')),
      );
      showConnecting(roomCode);
    }
  }

  function showConnecting(roomCode) {
    header.hidden = true;
    let timer = null;
    mount('connecting', () => {
      const hint = h('p', { class: 'muted', hidden: true }, 'Still looking. Check the code, and that the host has the room open.');
      timer = setTimeout(() => { hint.hidden = false; }, 15_000);
      const el = h('section', { class: 'screen', dataset: { screen: 'connecting' } },
        card({ title: `Connecting to ${roomCode}…`, class: 'center-card' },
          h('p', { class: 'muted' }, 'Looking for the host. This can take a few seconds.'), hint,
          button({ label: 'Cancel', onClick: () => leaveGame() })));
      return { el };
    }, () => clearTimeout(timer));
  }

  function receiveState(g, msg) {
    if (g !== game || !msg || typeof msg.rev !== 'number' || !msg.state || msg.rev <= g.rev) return;
    g.rev = msg.rev;
    g.state = msg.state;
    g.offset = clockOffset(msg.now);
    requestImages(g);
    renderNow();
  }

  /** Ask for every image the snapshot references and we do not hold (store dedupes repeats). */
  function requestImages(g) {
    const refs = [];
    for (const byPlayer of Object.values(g.state.captures)) for (const c of Object.values(byPlayer)) refs.push({ imageId: c.captureId, ownerId: c.playerId });
    for (const m of g.state.chat) if (m.imageId) refs.push({ imageId: m.imageId, ownerId: m.playerId });
    if (refs.length) g.store.requestMissing(refs);
  }

  function renderNow() {
    const g = game;
    if (!g || !g.state) return;
    const { state } = g;
    const entry = ensureScreen(g, state.phase);
    if (!entry) return;
    roomEl.textContent = state.roomCode;
    countEl.textContent = `${state.players.filter((p) => p.connected).length}/${MAX_PLAYERS} players`;
    header.hidden = false;
    entry.screen.render({
      state, meId: identity.playerId, clockOffset: g.offset, imageUrl: (id) => g.store.objectUrl(id),
    });
  }

  function ensureScreen(g, phase) {
    const send = (intent) => g.session.sendToHost(MSG.intent, { intent });
    switch (phase) {
      case 'lobby': return mount('lobby', () => createLobbyScreen({ send }));
      case 'play': return mount('play', () => {
        g.map = createMap(g);
        return createPlayScreen({
          send, map: g.map,
          onCapture: async (categoryId) => {
            const captureId = await shipImage(g, { kind: 'capture', categoryId });
            send({ type: INTENT.capture, captureId, categoryId });
          },
          onShare: async (caption) => {
            const imageId = await shipImage(g, { kind: 'chat' });
            send({ type: INTENT.chatImage, id: makeId(), imageId, ...(caption ? { text: caption } : {}) });
          },
        });
      }, () => { g.map = null; });
      case 'review': return mount('review', () => createReviewScreen({ send }));
      case 'results': return mount('results', () => createResultsScreen({ send }));
      default: return null;
    }
  }

  /** Real webview map inside Electron, canvas stub in a plain browser. Both: { element, show, capture }. */
  function createMap(g) {
    if (window.geofinder?.captureMap) return createMapPanel(document.createElement('div')); // the play screen re-parents .element once
    const me = getPlayer(g.state, identity.playerId)?.profile;
    return createStubMap({ name: me?.name, color: me?.color });
  }

  /** Capture the map and broadcast the JPEG (MSG.imgData). Resolves with the new imageId; the caller then sends the small intent. */
  async function shipImage(g, meta) {
    if (!g.map) throw new Error('the map is not ready');
    const blob = await g.map.capture();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (g !== game) throw new Error('you left the room');
    const imageId = makeId();
    g.store.sendImage(bytes, { ...meta, imageId });
    return imageId;
  }

  // ---- leaving ----
  function teardown() {
    const g = game;
    if (!g) return;
    game = null;
    g.host?.stop();
    for (const off of g.offs) off();
    g.store.dispose();
    g.session.leave();
  }
  function endGame(text) { teardown(); showProfile(text); }
  function leaveGame() {
    if (game?.isHost && game.state && game.state.players.length > 1) {
      let ok = true;
      try { ok = window.confirm('You are the host: leaving ends the game for everyone. Leave anyway?'); } catch { /* no dialogs: just leave */ }
      if (!ok) return;
    }
    endGame(null);
  }
  window.addEventListener('pagehide', () => game?.session.leave()); // tell the others at once instead of making them time us out

  // test/debug hook
  window.__gf = { getState: () => game?.state ?? null, getSession: () => game?.session ?? null, getStore: () => game?.store ?? null, identity };

  showProfile(null);
}

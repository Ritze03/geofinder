// Session: playerId layer on top of a Transport (contracts section 5). Knows peers by playerId, stamps `from`, tracks who the host is.
// Ported from walters-knaggertreff; changes: gameId -> roomCode, no isBot, hello profile is sanitized.
//
// Seat limit (MAX_PLAYERS): NOT enforced here. The session is a pure transport layer and cannot know which seats are taken (a disconnected
// player keeps its seat from 'play' on). The host's core/driver answers a 9th join with ERR.full / MSG.reject {reason:'full'}.
//
// Host leaving ends the game in v1 (D12): clients get SESSION_EVENT.hostGone and the app goes back to the start screen. `hostBack` is still
// emitted (also once on the FIRST host hello of a normal join, and when a muted host speaks again); the app ignores it, no host resume in v1.
import { MSG, SESSION_EVENT, PROTOCOL_VERSION, SYSTEM, sanitizeProfile } from '../contracts.js';
import { createTransport as createLocal } from './transports/local.js';
import { createTransport as createTrystero } from './transports/trystero.js';

const HEARTBEAT_MS = 1000;   // every session broadcasts a tiny `hb` this often
export const SILENCE_MS = 5000;     // a peer we have heard NOTHING from (any message incl. hb) for this long is treated as left
const HB = 'hb';                    // session-internal action, not part of MSG
// A hello is unauthenticated, so the claimed playerId must at least be harmless as an identity: never SYSTEM (host-internal actor), and only
// letters/digits/hyphens (real ids are crypto.randomUUID()). No '_' or '$' keeps '__proto__' & co. out of the objects keyed by playerId.
// Not strictly a UUID so that the unit tests can keep readable ids ('alice').
const VALID_ID = /^[A-Za-z0-9-]{1,64}$/;
const validId = (id) => typeof id === 'string' && id !== SYSTEM && VALID_ID.test(id);

/** @param {import('../contracts.js').SessionOptions & { transport: ('trystero'|'local'|object) }} o
 *  `transport` may also be a ready-made Transport object (tests wrap one to simulate a dead peer). */
export function createSession({ roomCode, transport, profile, playerId, isHost }) {
  const types = [...Object.values(MSG), HB];
  const link = typeof transport !== 'string' ? transport : transport === 'local' ? createLocal(roomCode) : createTrystero(roomCode, types);

  const handlers = new Map();   // type -> Set<handler>
  const peers = new Map();      // transport peerId -> { lastSeen, info: PeerInfo|null }  (info stays null until the peer's hello arrives)
  const peerOf = new Map();     // playerId -> transport peerId (latest connection wins)
  let hostPeerId = null;        // clients only: peerId of the peer that announced isHost:true
  let closed = false;

  const emit = (type, data, from) => {
    for (const h of [...(handlers.get(type) ?? [])]) {
      try { h(data, from); } catch (e) { console.error(`[net] handler for "${type}" threw`, e); }
    }
  };

  const sendHello = (peerId, reply = true) => link.send(MSG.hello, {
    protocol: PROTOCOL_VERSION, playerId, profile, isHost: !!isHost, ...(reply ? {} : { reply: false }),
  }, peerId);

  function touch(peerId) {
    let p = peers.get(peerId);
    if (!p) peers.set(peerId, (p = { lastSeen: 0, info: null }));
    p.lastSeen = Date.now();
    return p;
  }

  function dropPeer(peerId) {
    const p = peers.get(peerId);
    if (!p) return;   // unknown, or already replaced by a newer connection of the same player
    peers.delete(peerId);
    if (!p.info) return;
    if (peerOf.get(p.info.playerId) === peerId) {
      peerOf.delete(p.info.playerId);
      emit(SESSION_EVENT.peerLeave, { playerId: p.info.playerId }, p.info.playerId);
    }
    if (hostPeerId === peerId) {
      hostPeerId = null;
      emit(SESSION_EVENT.hostGone, {}, p.info.playerId);
    }
  }

  function onHello(peerId, p, m) {
    // ignore garbage, SYSTEM / malformed ids, and anything claiming OUR playerId (a second tab of the same install identity)
    if (!m || !validId(m.playerId) || m.playerId === playerId) return;
    // Seat hijack: the claimed playerId is still held by ANOTHER connection that we heard from within SILENCE_MS -> refuse the newcomer.
    // Remembered as p.pending and retried on every heartbeat tick, so a real reload/rejoin gets in as soon as the old connection has left
    // or gone silent. (No crypto: if the real owner is really gone, anybody who knows the room code can take the seat.)
    const holder = peerOf.get(m.playerId);
    if (holder && holder !== peerId && Date.now() - (peers.get(holder)?.lastSeen ?? 0) <= SILENCE_MS) { p.pending = m; return; }
    // Host claim: a client that already knows its host ignores a second peer claiming isHost (a joining client takes the first claim;
    // knowing the room code is the v1 trust boundary).
    if (!isHost && m.isHost === true && hostPeerId !== null && hostPeerId !== peerId && peers.has(hostPeerId)) { p.pending = m; return; }
    p.pending = null;
    const first = !p.info;
    const info = {
      playerId: m.playerId,
      profile: sanitizeProfile(m.profile),
      isHost: m.isHost === true,
      protocol: m.protocol,   // extra vs PeerInfo: lets the host driver reject 'protocol' mismatches
      pingMs: p.info?.pingMs ?? null,
    };
    const hostWasKnown = hostPeerId !== null;
    // same player on a new connection (reload before the old one timed out): the old connection is simply replaced, no leave/gone events
    const old = peerOf.get(info.playerId);
    if (old && old !== peerId) {
      peers.delete(old);
      if (hostPeerId === old) hostPeerId = null;
    }
    p.info = info;
    peerOf.set(info.playerId, peerId);
    if (first) emit(SESSION_EVENT.peerJoin, { ...info }, info.playerId);
    let answered = m.reply !== false;   // peers answer a hello once so everybody learns everybody, even after a one-sided drop
    if (!isHost && info.isHost) {
      hostPeerId = peerId;
      if (!hostWasKnown) {
        emit(SESSION_EVENT.hostBack, { playerId: info.playerId }, info.playerId);
        answered = true;   // (re)send our hello so the host can seatJoin us
      }
    }
    if (answered) sendHello(peerId, false);
  }

  function onInbound(type, data, peerId) {
    if (closed) return;
    let p = peers.get(peerId);
    if (!p) { p = touch(peerId); sendHello(peerId); }   // a peer we dropped (or never saw join) is talking: introduce ourselves again
    else p.lastSeen = Date.now();
    if (type === MSG.hello) return onHello(peerId, p, data);
    if (type === HB || !p.info) return;                 // messages before hello have no known sender
    emit(type, data, p.info.playerId);
  }

  for (const type of types) link.onMessage(type, (data, peerId) => onInbound(type, data, peerId));
  link.onPeerJoin((peerId) => { if (!closed) { touch(peerId); sendHello(peerId); } });
  link.onPeerLeave(dropPeer);
  link.onError?.((e) => emit(SESSION_EVENT.error, { message: String(e?.message ?? e) }, playerId));

  const timer = setInterval(() => {
    link.send(HB, 0);
    const now = Date.now();
    for (const [peerId, p] of [...peers]) if (now - p.lastSeen > SILENCE_MS) dropPeer(peerId);
    for (const [peerId, p] of peers) if (p.pending) onHello(peerId, p, p.pending);   // refused earlier: maybe the seat / host slot is free now
  }, HEARTBEAT_MS);

  const sendToHost = (type, data) => {
    if (isHost) queueMicrotask(() => { if (!closed) emit(type, data, playerId); });
    else if (hostPeerId) link.send(type, data, hostPeerId);
  };

  return {
    roomCode,
    transport: typeof transport === 'string' ? transport : 'custom',
    selfPlayerId: playerId,
    isHost: !!isHost,
    hostPlayerId: () => (isHost ? playerId : (peers.get(hostPeerId)?.info.playerId ?? null)),
    peers: () => [...peers.values()].filter((p) => p.info).map((p) => ({ ...p.info })),
    sendIntent: (intent) => sendToHost(MSG.intent, { intent }),
    send(type, data, toPlayerId) {
      const peerId = peerOf.get(toPlayerId);
      if (peerId) link.send(type, data, peerId);
    },
    sendToHost,
    broadcast(type, data, { self = false } = {}) {
      link.send(type, data);
      if (self) queueMicrotask(() => { if (!closed) emit(type, data, playerId); });
    },
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => handlers.get(type)?.delete(handler);
    },
    ping(toPlayerId) {
      const peerId = peerOf.get(toPlayerId);
      if (!peerId) return Promise.reject(new Error(`unknown player ${toPlayerId}`));
      return link.ping(peerId).then((ms) => { const info = peers.get(peerId)?.info; if (info) info.pingMs = ms; return ms; });
    },
    leave() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      link.leave();
      handlers.clear();
    },
  };
}

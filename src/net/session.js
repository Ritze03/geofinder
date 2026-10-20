// Session: playerId layer on top of a Transport (contracts section 5). Knows peers by playerId, stamps `from`, tracks who the host is.
// Ported from walters-knaggertreff; changes: gameId -> roomCode, no isBot, hello profile is sanitized, `metadata` (binary actions) plumbed through.
//
// Seat limit (MAX_PLAYERS): NOT enforced here. The session is a pure transport layer and cannot know which seats are taken (a disconnected
// player keeps its seat from 'play' on). The host's core/driver answers a 9th join with ERR.full / MSG.reject {reason:'full'}.
//
// Host leaving ends the game in v1 (D12): clients get SESSION_EVENT.hostGone and the app goes back to the start screen. `hostBack` is still
// emitted (also once on the FIRST host hello of a normal join, and when a muted host speaks again); the app ignores it, no host resume in v1.
import { MSG, SESSION_EVENT, PROTOCOL_VERSION, IMAGE_MAX_BYTES, sanitizeProfile } from '../contracts.js';
import { createTransport as createLocal } from './transports/local.js';
import { createTransport as createTrystero } from './transports/trystero.js';

export const HEARTBEAT_MS = 1000;   // every session broadcasts a tiny `hb` this often
export const SILENCE_MS = 5000;     // a peer we have heard NOTHING from (any message incl. hb) for this long is treated as left
const HB = 'hb';                    // session-internal action, not part of MSG

/** byte size of a binary payload, or -1 for anything that is not binary (JSON values) */
const binarySize = (d) => (d instanceof ArrayBuffer || ArrayBuffer.isView(d) ? d.byteLength : typeof Blob !== 'undefined' && d instanceof Blob ? d.size : -1);

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

  const emit = (type, data, from, metadata) => {
    for (const h of [...(handlers.get(type) ?? [])]) {
      try { h(data, from, metadata); } catch (e) { console.error(`[net] handler for "${type}" threw`, e); }
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
    // ignore garbage and anything claiming OUR playerId (a second tab of the same install identity)
    if (!m || typeof m.playerId !== 'string' || !m.playerId || m.playerId === playerId) return;
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

  function onInbound(type, data, peerId, metadata) {
    if (closed) return;
    let p = peers.get(peerId);
    if (!p) { p = touch(peerId); sendHello(peerId); }   // a peer we dropped (or never saw join) is talking: introduce ourselves again
    else p.lastSeen = Date.now();
    if (type === MSG.hello) return onHello(peerId, p, data);
    if (type === HB || !p.info) return;                 // messages before hello have no known sender
    if (binarySize(data) > IMAGE_MAX_BYTES) return;     // oversize binary payload (D11): dropped, never reaches a handler
    emit(type, data, p.info.playerId, metadata);
  }

  for (const type of types) link.onMessage(type, (data, peerId, metadata) => onInbound(type, data, peerId, metadata));
  link.onPeerJoin((peerId) => { if (!closed) { touch(peerId); sendHello(peerId); } });
  link.onPeerLeave(dropPeer);
  link.onError?.((e) => emit(SESSION_EVENT.error, { message: String(e?.message ?? e) }, playerId));

  const timer = setInterval(() => {
    link.send(HB, 0);
    const now = Date.now();
    for (const [peerId, p] of peers) if (now - p.lastSeen > SILENCE_MS) dropPeer(peerId);
  }, HEARTBEAT_MS);

  const sendToHost = (type, data, { metadata } = {}) => {
    if (isHost) queueMicrotask(() => { if (!closed) emit(type, data, playerId, metadata); });
    else if (hostPeerId) link.send(type, data, hostPeerId, metadata);
  };

  return {
    roomCode,
    transport: typeof transport === 'string' ? transport : 'custom',
    selfPlayerId: playerId,
    isHost: !!isHost,
    hostPlayerId: () => (isHost ? playerId : (peers.get(hostPeerId)?.info.playerId ?? null)),
    peers: () => [...peers.values()].filter((p) => p.info).map((p) => ({ ...p.info })),
    sendIntent: (intent) => sendToHost(MSG.intent, { intent }),
    send(type, data, toPlayerId, { metadata } = {}) {
      const peerId = peerOf.get(toPlayerId);
      if (peerId) link.send(type, data, peerId, metadata);
    },
    sendToHost,
    broadcast(type, data, { self = false, metadata } = {}) {
      link.send(type, data, undefined, metadata);
      if (self) queueMicrotask(() => { if (!closed) emit(type, data, playerId, metadata); });
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

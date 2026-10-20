// ?local transport: BroadcastChannel between tabs of one browser (contracts section 5). Behaves like the Trystero transport:
// onPeerJoin also fires for peers already present, messages never loop back, a peer that vanishes (bye / silence) fires onPeerLeave.
// Binary: ArrayBuffer / typed arrays / metadata go through structured clone. A typed-array VIEW is copied into a standalone ArrayBuffer on
// send, so the receiver always gets a plain ArrayBuffer (exactly what Trystero delivers) and `new Blob([data])` just works.
import { APP_ID } from '../../contracts.js';

export const LOCAL_HEARTBEAT_MS = 1000;
export const LOCAL_SILENCE_MS = 4000;   // no packet from a peer for this long (tab killed, no `bye`) => peer left
const PING_TIMEOUT_MS = 5000;

const toBuffer = (data) => (ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);

export function createTransport(roomCode) {
  const selfId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const channel = new BroadcastChannel(`${APP_ID}:${roomCode}`);
  const peers = new Map();       // peerId -> time of last packet
  const handlers = new Map();    // type -> handler
  const pings = new Map();       // ping id -> { ok, fail }
  let joinHandler = null, leaveHandler = null, closed = false, pingSeq = 0;

  const post = (packet) => { if (!closed) channel.postMessage({ from: selfId, ...packet }); };
  const seen = (id) => {
    const isNew = !peers.has(id);
    peers.set(id, Date.now());
    if (isNew) joinHandler?.(id);
  };
  const drop = (id) => { if (peers.delete(id)) leaveHandler?.(id); };

  channel.onmessage = ({ data: p }) => {
    if (closed || !p || p.from === selfId || (p.to && p.to !== selfId)) return;
    if (p.k === 'bye') return drop(p.from);
    seen(p.from);
    if (p.k === 'announce') post({ k: 'ack', to: p.from });
    else if (p.k === 'msg') handlers.get(p.type)?.(p.data, p.from, p.metadata);
    else if (p.k === 'ping') post({ k: 'pong', to: p.from, id: p.id });
    else if (p.k === 'pong') pings.get(p.id)?.ok();
  };

  const timer = setInterval(() => {
    post({ k: 'hb' });
    const now = Date.now();
    for (const [id, t] of peers) if (now - t > LOCAL_SILENCE_MS) drop(id);
  }, LOCAL_HEARTBEAT_MS);

  const onHide = () => post({ k: 'bye' });
  globalThis.addEventListener?.('pagehide', onHide);
  post({ k: 'announce' });

  return {
    selfId,
    send: (type, data, target, metadata) => post({
      k: 'msg', type, data: toBuffer(data),
      ...(metadata !== undefined ? { metadata } : {}), ...(target ? { to: target } : {}),
    }),
    onMessage: (type, handler) => handlers.set(type, handler),
    onPeerJoin(handler) { joinHandler = handler; for (const id of peers.keys()) handler(id); },
    onPeerLeave(handler) { leaveHandler = handler; },
    ping(peerId) {
      return new Promise((resolve, reject) => {
        const id = ++pingSeq, t0 = performance.now();
        const finish = (fn) => (arg) => { clearTimeout(timeout); pings.delete(id); fn(arg); };
        const fail = finish(reject);
        const timeout = setTimeout(() => fail(new Error('ping timeout')), PING_TIMEOUT_MS);
        pings.set(id, { ok: finish(() => resolve(performance.now() - t0)), fail });
        post({ k: 'ping', to: peerId, id });
      });
    },
    leave() {
      if (closed) return;
      post({ k: 'bye' });
      closed = true;
      clearInterval(timer);
      for (const p of [...pings.values()]) p.fail(new Error('left'));
      globalThis.removeEventListener?.('pagehide', onHide);
      channel.close();
    },
  };
}

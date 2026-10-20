import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, SESSION_EVENT, KEYS, PROTOCOL_VERSION, IMAGE_MAX_BYTES, defaultProfile } from '../contracts.js';
import { createSession } from './session.js';
import { createTransport as createLocal } from './transports/local.js';
import { loadIdentity, saveProfile } from './identity.js';

const open = [];
const roomOf = () => 'GEO-T' + Math.random().toString(36).slice(2, 8);
const profileOf = (name) => ({ ...defaultProfile(), name });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail('timed out waiting for condition');
    await wait(10);
  }
}
/** every session made here is left in the `after` hook so channels/timers close and `node --test` exits */
function make(roomCode, name, isHost = false, transport = 'local') {
  const s = createSession({ roomCode, transport, profile: profileOf(name), playerId: name, isHost });
  open.push(s);
  return s;
}
const record = (s, type) => { const got = []; s.on(type, (data, from, metadata) => got.push(metadata === undefined ? { data, from } : { data, from, metadata })); return got; };
after(() => { for (const s of open) s.leave(); });

test('host + 2 clients exchange hello, clients learn the host', async () => {
  const g = roomOf();
  const host = make(g, 'host', true);
  const joins = record(host, SESSION_EVENT.peerJoin);
  const a = make(g, 'alice'), b = make(g, 'bob');
  await until(() => joins.length === 2 && a.peers().length === 2 && b.peers().length === 2);

  assert.deepEqual(joins.map((j) => j.data.playerId).sort(), ['alice', 'bob']);
  const alice = joins.find((j) => j.data.playerId === 'alice').data;
  assert.equal(alice.profile.name, 'alice');
  assert.equal(alice.isHost, false);
  assert.equal(alice.protocol, PROTOCOL_VERSION);
  assert.equal(host.hostPlayerId(), 'host');
  assert.equal(a.hostPlayerId(), 'host');
  assert.equal(b.hostPlayerId(), 'host');
  assert.deepEqual(a.peers().map((p) => p.playerId).sort(), ['bob', 'host']);
  assert.equal(a.peers().find((p) => p.playerId === 'host').isHost, true);
});

test('late joiner learns peers that were already present', async () => {
  const g = roomOf();
  const host = make(g, 'host', true), a = make(g, 'alice');
  await until(() => host.peers().length === 1 && a.peers().length === 1);
  const b = make(g, 'bob');
  const seen = record(b, SESSION_EVENT.peerJoin);
  await until(() => seen.length === 2);
  assert.deepEqual(seen.map((j) => j.data.playerId).sort(), ['alice', 'host']);
  assert.equal(b.hostPlayerId(), 'host');
});

test('from is stamped with the sender playerId; sendIntent reaches only the host', async () => {
  const g = roomOf();
  const host = make(g, 'host', true), a = make(g, 'alice'), b = make(g, 'bob');
  await until(() => a.hostPlayerId() && b.hostPlayerId() && host.peers().length === 2);
  const atHost = record(host, MSG.intent), atBob = record(b, MSG.intent), atAlice = record(a, MSG.intent);

  a.sendIntent({ type: 'roll' });
  await until(() => atHost.length === 1);
  await wait(100);
  assert.deepEqual(atHost[0], { data: { intent: { type: 'roll' } }, from: 'alice' });
  assert.equal(atBob.length, 0);
  assert.equal(atAlice.length, 0);

  // a spoofed playerId inside the payload is just payload
  b.sendIntent({ type: 'ready', playerId: 'alice' });
  await until(() => atHost.length === 2);
  assert.equal(atHost[1].from, 'bob');
});

test('host sendIntent loops back to its own handlers', async () => {
  const host = make(roomOf(), 'host', true);
  const got = record(host, MSG.intent);
  host.sendIntent({ type: 'startGame' });
  await until(() => got.length === 1);
  assert.deepEqual(got[0], { data: { intent: { type: 'startGame' } }, from: 'host' });
});

test('client sendIntent is a no-op while the host is absent', async () => {
  const g = roomOf();
  const a = make(g, 'alice'), b = make(g, 'bob');
  await until(() => a.peers().length === 1);
  const got = record(b, MSG.intent);
  a.sendIntent({ type: 'roll' });
  await wait(150);
  assert.equal(got.length, 0);
  assert.equal(a.hostPlayerId(), null);
});

test('broadcast reaches all peers, and self only with {self:true}', async () => {
  const g = roomOf();
  const host = make(g, 'host', true), a = make(g, 'alice'), b = make(g, 'bob');
  await until(() => a.hostPlayerId() && b.hostPlayerId() && host.peers().length === 2);
  const atHost = record(host, MSG.state), atA = record(a, MSG.state), atB = record(b, MSG.state);

  host.broadcast(MSG.state, { rev: 1 });
  await until(() => atA.length === 1 && atB.length === 1);
  await wait(100);
  assert.equal(atHost.length, 0);
  assert.deepEqual(atA[0], { data: { rev: 1 }, from: 'host' });

  host.broadcast(MSG.state, { rev: 2 }, { self: true });
  await until(() => atHost.length === 1 && atA.length === 2 && atB.length === 2);
  assert.deepEqual(atHost[0], { data: { rev: 2 }, from: 'host' });
});

test('send targets one player; unsubscribe stops delivery', async () => {
  const g = roomOf();
  const host = make(g, 'host', true), a = make(g, 'alice'), b = make(g, 'bob');
  await until(() => host.peers().length === 2);
  const atA = record(a, MSG.reject), atB = record(b, MSG.reject);
  host.send(MSG.reject, { reason: 'full' }, 'alice');
  await until(() => atA.length === 1);
  await wait(100);
  assert.equal(atB.length, 0);

  const got = [];
  const off = b.on(MSG.state, (d) => got.push(d));
  host.broadcast(MSG.state, { rev: 1 });
  await until(() => got.length === 1);
  off();
  host.broadcast(MSG.state, { rev: 2 });
  await wait(100);
  assert.equal(got.length, 1);
});

test('ping returns a round trip', async () => {
  const g = roomOf();
  const host = make(g, 'host', true), a = make(g, 'alice');
  await until(() => a.peers().length === 1 && host.peers().length === 1);
  const ms = await a.ping('host');
  assert.ok(ms >= 0 && ms < 1000);
  assert.equal(a.peers()[0].pingMs, ms);
  await assert.rejects(a.ping('nobody'));
});

test('a client leaving fires peerLeave with its playerId on the host', async () => {
  const g = roomOf();
  const host = make(g, 'host', true), a = make(g, 'alice');
  const left = record(host, SESSION_EVENT.peerLeave);
  await until(() => host.peers().length === 1);
  a.leave();
  await until(() => left.length === 1);
  assert.deepEqual(left[0].data, { playerId: 'alice' });
  assert.equal(host.peers().length, 0);
});

test('a rejoining client (same playerId, new transport) is reported as that playerId again', async () => {
  const g = roomOf();
  const host = make(g, 'host', true);
  const joins = record(host, SESSION_EVENT.peerJoin), left = record(host, SESSION_EVENT.peerLeave);
  const a1 = make(g, 'alice');
  await until(() => joins.length === 1);
  a1.leave();
  await until(() => left.length === 1);

  const a2 = make(g, 'alice');
  await until(() => joins.length === 2);
  assert.equal(joins[1].data.playerId, 'alice');
  assert.deepEqual(host.peers().map((p) => p.playerId), ['alice']);
  const got = record(host, MSG.intent);
  a2.sendIntent({ type: 'roll' });
  await until(() => got.length === 1);
  assert.equal(got[0].from, 'alice');
});

test('a reload that beats the old connection timing out replaces it without leave events', async () => {
  const g = roomOf();
  const host = make(g, 'host', true);
  const joins = record(host, SESSION_EVENT.peerJoin), left = record(host, SESSION_EVENT.peerLeave);
  make(g, 'alice');   // old connection stays open
  await until(() => joins.length === 1);
  make(g, 'alice');   // same playerId, new peer id
  await until(() => joins.length === 2);
  await wait(100);
  assert.equal(left.length, 0);
  assert.equal(host.peers().length, 1);
});

test('host leaving fires hostGone on clients; a new host session with the same playerId fires hostBack', async () => {
  const g = roomOf();
  const host1 = make(g, 'host', true), a = make(g, 'alice'), b = make(g, 'bob');
  const gone = record(a, SESSION_EVENT.hostGone), back = record(a, SESSION_EVENT.hostBack);
  const goneB = record(b, SESSION_EVENT.hostGone);
  await until(() => a.hostPlayerId() === 'host' && b.hostPlayerId() === 'host');
  back.length = 0;

  host1.leave();
  await until(() => gone.length === 1 && goneB.length === 1);
  assert.equal(a.hostPlayerId(), null);
  assert.equal(back.length, 0);

  const host2 = make(g, 'host', true);
  const joins = record(host2, SESSION_EVENT.peerJoin);
  await until(() => back.length === 1 && joins.length === 2);   // the host also learns both clients again
  assert.deepEqual(back[0].data, { playerId: 'host' });
  assert.equal(a.hostPlayerId(), 'host');
  assert.equal(gone.length, 1);
});

test('a silent host (tab killed, no clean leave) is detected as gone, and back when it speaks again', { timeout: 15000 }, async () => {
  const g = roomOf();
  const real = createLocal(g);
  let muted = false;
  const flaky = { ...real, send: (...args) => { if (!muted) real.send(...args); } };
  const host = createSession({ roomCode: g, transport: flaky, profile: profileOf('host'), playerId: 'host', isHost: true });
  open.push(host);
  const a = make(g, 'alice');
  const gone = record(a, SESSION_EVENT.hostGone), back = record(a, SESSION_EVENT.hostBack), left = record(a, SESSION_EVENT.peerLeave);
  await until(() => a.hostPlayerId() === 'host');
  back.length = 0;

  muted = true;
  await until(() => gone.length === 1, 8000);
  assert.deepEqual(left[0].data, { playerId: 'host' });
  assert.equal(a.hostPlayerId(), null);

  muted = false;
  await until(() => back.length === 1, 4000);
  assert.equal(a.hostPlayerId(), 'host');
});


// ---------------------------------------------------------------------------------------------------------------------------------------
// binary + metadata
const jpeg = (n, fill = 7) => new Uint8Array(n).fill(fill);
const META = { kind: 'capture', imageId: 'img1', ownerId: 'alice', categoryId: 'cat1', at: 123, mime: 'image/jpeg', w: 1280, h: 720 };

test('hello carries protocol/playerId/profile/isHost (no isBot) and sanitizes the profile', async () => {
  const g = roomOf();
  const host = make(g, 'host', true);
  const joins = record(host, SESSION_EVENT.peerJoin);
  const evil = createSession({ roomCode: g, transport: 'local', playerId: 'eve', isHost: false, profile: { name: '  A very long name that is too long ', color: 'nope', hat: 'x', extra: 1 } });
  open.push(evil);
  await until(() => joins.length === 1);
  const info = joins[0].data;
  assert.deepEqual(Object.keys(info).sort(), ['isHost', 'pingMs', 'playerId', 'profile', 'protocol']);
  assert.equal(info.protocol, PROTOCOL_VERSION);
  assert.deepEqual(info.profile, { name: 'A very long na', color: 'coral', head: 'round', face: 'happy' });
});

test('binary send/broadcast carries bytes + metadata intact; a Uint8Array arrives as an ArrayBuffer usable for a Blob', async () => {
  const g = roomOf();
  const host = make(g, 'host', true), a = make(g, 'alice'), b = make(g, 'bob');
  await until(() => a.hostPlayerId() && b.hostPlayerId() && host.peers().length === 2 && a.peers().length === 2);
  const atHost = record(host, MSG.imgData), atB = record(b, MSG.imgData);

  // a VIEW into a bigger buffer: only its own bytes may travel
  const big = new Uint8Array(64).fill(1);
  const view = new Uint8Array(big.buffer, 8, 16).fill(9);
  a.broadcast(MSG.imgData, view, { metadata: META });
  await until(() => atHost.length === 1 && atB.length === 1);
  for (const got of [atHost[0], atB[0]]) {
    assert.equal(got.from, 'alice');
    assert.deepEqual(got.metadata, META);
    assert.ok(got.data instanceof ArrayBuffer, 'receivers get a plain ArrayBuffer');
    assert.deepEqual([...new Uint8Array(got.data)], new Array(16).fill(9));
    assert.equal(new Blob([got.data], { type: 'image/jpeg' }).size, 16);
  }

  // targeted send + ArrayBuffer payload + sendToHost
  const atB2 = record(b, MSG.imgData), atHost2 = record(host, MSG.imgData);
  atHost2.length = 0;
  host.send(MSG.imgData, jpeg(10, 5).buffer, 'bob', { metadata: { ...META, imageId: 'img2' } });
  await until(() => atB2.length === 1);
  assert.equal(atB2[0].metadata.imageId, 'img2');
  assert.equal(atB2[0].data.byteLength, 10);
  b.sendToHost(MSG.imgData, jpeg(3), { metadata: { n: 1 } });
  await until(() => atHost2.length === 1);
  assert.deepEqual(atHost2[0].metadata, { n: 1 });
  assert.equal(atHost2[0].from, 'bob');
});

test('metadata is also looped back with broadcast {self:true} and a host sendToHost', async () => {
  const host = make(roomOf(), 'host', true);
  const got = record(host, MSG.imgData);
  host.broadcast(MSG.imgData, jpeg(4), { self: true, metadata: META });
  host.sendToHost(MSG.imgData, jpeg(2), { metadata: { x: 1 } });
  await until(() => got.length === 2);
  assert.deepEqual(got.map((x) => x.metadata).sort((p, q) => (p.x ? -1 : 1)), [{ x: 1 }, META]);
});

test('json messages without metadata arrive with metadata undefined', async () => {
  const g = roomOf();
  const host = make(g, 'host', true), a = make(g, 'alice');
  await until(() => a.hostPlayerId());
  let seen = 'unset';
  a.on(MSG.state, (d, from, metadata) => { seen = metadata; });
  host.broadcast(MSG.state, { rev: 1 });
  await until(() => seen !== 'unset');
  assert.equal(seen, undefined);
});

test('oversize binary payloads are dropped by the receiving session, a valid one right after still arrives', async () => {
  const g = roomOf();
  const host = make(g, 'host', true), a = make(g, 'alice');
  await until(() => a.hostPlayerId() && host.peers().length === 1);
  const got = record(host, MSG.imgData);
  a.broadcast(MSG.imgData, jpeg(IMAGE_MAX_BYTES + 1), { metadata: { ...META, imageId: 'big' } });
  a.broadcast(MSG.imgData, jpeg(IMAGE_MAX_BYTES), { metadata: { ...META, imageId: 'max' } });
  await until(() => got.length >= 1);
  await wait(200);
  assert.deepEqual(got.map((x) => x.metadata.imageId), ['max']);
  assert.equal(got[0].data.byteLength, IMAGE_MAX_BYTES);
});

test('rejoin by playerId: binary addressed to that playerId reaches the new connection', async () => {
  const g = roomOf();
  const host = make(g, 'host', true);
  const joins = record(host, SESSION_EVENT.peerJoin), left = record(host, SESSION_EVENT.peerLeave);
  const a1 = make(g, 'alice');
  await until(() => joins.length === 1);
  a1.leave();
  await until(() => left.length === 1);
  host.send(MSG.imgData, jpeg(5), 'alice', { metadata: META });   // nobody to deliver to: silently ignored

  const a2 = make(g, 'alice');
  const atA2 = record(a2, MSG.imgData);
  await until(() => joins.length === 2 && a2.hostPlayerId() === 'host');
  host.send(MSG.imgData, jpeg(6), 'alice', { metadata: { ...META, imageId: 'img9' } });
  await until(() => atA2.length === 1);
  assert.equal(atA2[0].metadata.imageId, 'img9');
  assert.equal(atA2[0].from, 'host');
});

test('transport mock: session hands send(type, data, target, metadata) through and forwards onMessage metadata', () => {
  const sent = [], handlers = new Map();
  const link = {
    selfId: 'me', send: (...a) => sent.push(a), onMessage: (t, h) => handlers.set(t, h), onPeerJoin() {}, onPeerLeave() {}, ping: async () => 0, leave() {},
  };
  const s = createSession({ roomCode: 'GEO-MOCK', transport: link, profile: defaultProfile(), playerId: 'me', isHost: false });
  open.push(s);
  s.broadcast(MSG.imgData, jpeg(2), { metadata: { m: 1 } });
  const call = sent.find((a) => a[0] === MSG.imgData);
  assert.deepEqual([call[0], call[1].byteLength, call[2], call[3]], [MSG.imgData, 2, undefined, { m: 1 }]);
  // all MSG types + hb are registered (imgData / imgRequest come along)
  assert.deepEqual([...handlers.keys()].sort(), [...Object.values(MSG), 'hb'].sort());
  for (const k of handlers.keys()) assert.ok(new TextEncoder().encode(k).length <= 32);
});

test('identity: stable playerId, sanitized profile round trip (with and without storage)', () => {
  assert.doesNotThrow(() => loadIdentity());   // no localStorage in node
  const idNoStorage = loadIdentity('nostore');
  assert.equal(loadIdentity('nostore').playerId, idNoStorage.playerId);
  assert.equal(idNoStorage.profile, null);
  assert.doesNotThrow(() => saveProfile({ name: 'x' }));

  const data = new Map();
  globalThis.localStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
  try {
    const id = loadIdentity();
    assert.match(id.playerId, /^[0-9a-f-]{36}$/);
    assert.equal(loadIdentity().playerId, id.playerId);
    assert.equal(data.get(KEYS.playerId(null)), id.playerId);
    assert.notEqual(loadIdentity('t2').playerId, id.playerId);
    assert.ok(data.has(KEYS.playerId('t2')));

    saveProfile({ name: 'Walter', color: 'sky', head: 'hex', face: 'cool' });
    assert.deepEqual(loadIdentity().profile, { name: 'Walter', color: 'sky', head: 'hex', face: 'cool' });
    assert.equal(loadIdentity('t2').profile, null);
    saveProfile({ name: '', color: 'bogus', playerId: 'leak' }, 't3');
    assert.deepEqual(loadIdentity('t3').profile, { name: 'Player', color: 'coral', head: 'round', face: 'happy' });
    data.set(KEYS.profile(null), 'not json');
    assert.equal(loadIdentity().profile, null);

    globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.equal(loadIdentity('broken').playerId, loadIdentity('broken').playerId);
    assert.doesNotThrow(() => saveProfile({}));
  } finally {
    delete globalThis.localStorage;
  }
});

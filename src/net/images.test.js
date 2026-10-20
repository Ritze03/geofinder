import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, IMAGE_MAX_BYTES, IMAGE_REQUEST_MAX_IDS, IMAGE_REQUEST_TIMEOUT_MS, defaultProfile } from '../contracts.js';
import { createSession } from './session.js';
import { createImageStore } from './images.js';

const sessions = [], stores = [];
const roomOf = () => 'GEO-I' + Math.random().toString(36).slice(2, 8);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail('timed out waiting for condition');
    await wait(10);
  }
}
/** session + image store with a manual scheduler: fallback timers only run when the test calls fire() */
function make(room, name, isHost = false) {
  const s = createSession({ roomCode: room, transport: 'local', profile: { ...defaultProfile(), name }, playerId: name, isHost });
  const timers = new Set();
  const store = createImageStore(s, {
    setTimeout: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearTimeout: (t) => timers.delete(t),
    createObjectURL: (blob) => `blob:fake/${blob.size}/${blob.type}`,
    revokeObjectURL: () => {},
  });
  sessions.push(s); stores.push(store);
  return { s, store, fire: () => { const due = [...timers]; timers.clear(); due.forEach((t) => t.fn()); }, pending: () => timers.size };
}
after(() => { for (const x of stores) x.dispose(); for (const s of sessions) s.leave(); });

const jpeg = (n, fill = 7) => new Uint8Array(n).fill(fill);
const meta = (imageId, ownerId, extra = {}) => ({ kind: 'capture', imageId, ownerId, categoryId: 'cat1', at: 1, mime: 'image/jpeg', ...extra });
/** record what arrives at a session (a raw listener, independent of the store) */
const tap = (s, type) => { const got = []; s.on(type, (data, from, metadata) => got.push({ data, from, metadata })); return got; };

async function trio() {
  const room = roomOf();
  const host = make(room, 'host', true), alice = make(room, 'alice'), bob = make(room, 'bob');
  await until(() => [host, alice, bob].every((x) => x.s.peers().length === 2) && alice.s.hostPlayerId() && bob.s.hostPlayerId());
  return { host, alice, bob };
}

test('sendImage stores locally, broadcasts bytes + ImageMeta to everybody, receivers store it and notify onImage', async () => {
  const { host, alice, bob } = await trio();
  const seen = [];
  bob.store.onImage((id, e) => seen.push([id, e.meta.ownerId, e.bytes.byteLength]));
  const own = [];
  alice.store.onImage((id) => own.push(id));

  const m = alice.store.sendImage(jpeg(1000, 3), { kind: 'capture', imageId: 'c1', categoryId: 'cat2', w: 1280, h: 720 });
  assert.equal(m.ownerId, 'alice');
  assert.equal(m.mime, 'image/jpeg');
  assert.equal(typeof m.at, 'number');
  assert.ok(alice.store.has('c1'));   // stored before any network round trip
  assert.deepEqual(own, ['c1']);

  await until(() => host.store.has('c1') && bob.store.has('c1'));
  const got = bob.store.get('c1');
  assert.deepEqual(got.meta, m);
  assert.equal(got.bytes.byteLength, 1000);
  assert.ok(got.bytes.every((b) => b === 3));
  assert.deepEqual(seen, [['c1', 'alice', 1000]]);
  assert.equal(bob.store.objectUrl('c1'), 'blob:fake/1000/image/jpeg');
  assert.equal(bob.store.objectUrl('c1'), bob.store.objectUrl('c1'));
  assert.equal(bob.store.objectUrl('nope'), null);
});

test('duplicate imgData is harmless (no second notification, first copy kept); invalid ones are ignored', async () => {
  const { host, alice } = await trio();
  const seen = [];
  host.store.onImage((id) => seen.push(id));
  alice.s.broadcast(MSG.imgData, jpeg(10, 1), { metadata: meta('d1', 'alice') });
  alice.s.broadcast(MSG.imgData, jpeg(10, 2), { metadata: meta('d1', 'alice') });
  alice.s.broadcast(MSG.imgData, jpeg(10), { metadata: meta('bad-mime', 'alice', { mime: 'image/png' }) });
  alice.s.broadcast(MSG.imgData, jpeg(10), { metadata: { kind: 'chat', mime: 'image/jpeg' } });   // no imageId
  alice.s.broadcast(MSG.imgData, jpeg(10));                                                          // no metadata
  alice.s.broadcast(MSG.imgData, { not: 'binary' }, { metadata: meta('json', 'alice') });
  alice.s.broadcast(MSG.imgData, jpeg(10, 4), { metadata: meta('d2', 'alice') });
  await until(() => seen.includes('d2'));
  assert.deepEqual(seen, ['d1', 'd2']);
  assert.equal(host.store.get('d1').bytes[0], 1);
  assert.deepEqual(host.store.ids().sort(), ['d1', 'd2']);
});

test('oversize image: sendImage throws, and a hostile oversize broadcast is dropped without stopping later ones', async () => {
  const { host, alice } = await trio();
  assert.throws(() => alice.store.sendImage(jpeg(IMAGE_MAX_BYTES + 1), { kind: 'chat', imageId: 'huge' }), RangeError);
  assert.equal(alice.store.has('huge'), false);
  alice.s.broadcast(MSG.imgData, jpeg(IMAGE_MAX_BYTES + 1), { metadata: meta('huge', 'alice') });
  alice.s.broadcast(MSG.imgData, jpeg(20), { metadata: meta('ok', 'alice') });
  await until(() => host.store.has('ok'));
  assert.equal(host.store.has('huge'), false);
});

test('requestMissing asks the OWNER only, grouped per owner; the answer goes to the requester only', async () => {
  const { host, alice, bob } = await trio();
  alice.store.sendImage(jpeg(50, 1), { kind: 'capture', imageId: 'a1', categoryId: 'cat1' });
  host.store.sendImage(jpeg(60, 2), { kind: 'capture', imageId: 'h1', categoryId: 'cat1' });
  await until(() => bob.store.has('a1') && bob.store.has('h1'));
  bob.store.drop('a1'); bob.store.drop('h1');   // bob "missed" the transfers

  const reqAtHost = tap(host.s, MSG.imgRequest), reqAtAlice = tap(alice.s, MSG.imgRequest), reqAtBob = tap(bob.s, MSG.imgRequest);
  const dataAtAlice = tap(alice.s, MSG.imgData), dataAtHost = tap(host.s, MSG.imgData), dataAtBob = tap(bob.s, MSG.imgData);
  bob.store.requestMissing([{ imageId: 'a1', ownerId: 'alice' }, { imageId: 'h1', ownerId: 'host' }, { imageId: 'a1', ownerId: 'alice' }]);

  await until(() => bob.store.has('a1') && bob.store.has('h1'));
  assert.deepEqual(reqAtAlice.map((r) => r.data), [{ imageIds: ['a1'] }]);
  assert.deepEqual(reqAtHost.map((r) => r.data), [{ imageIds: ['h1'] }]);
  assert.equal(reqAtBob.length, 0);
  assert.equal(bob.store.get('a1').meta.ownerId, 'alice');
  assert.equal(bob.store.get('h1').bytes.byteLength, 60);
  await wait(150);
  assert.equal(dataAtBob.length, 2);
  assert.equal(dataAtAlice.length, 0, 'replies are not broadcast');
  assert.equal(dataAtHost.length, 0, 'replies are not broadcast');
  assert.equal(bob.pending(), 2, 'one fallback timer per owner group');
  bob.fire();   // everything arrived: the fallback finds nothing missing and sends nothing
  await wait(100);
  assert.equal(reqAtAlice.length + reqAtHost.length, 2);
});

test('timeout fallback: owner does not answer -> the request is broadcast and any holder replies to the requester only', async () => {
  const { host, alice, bob } = await trio();
  // alice made the image but no longer holds it; the host got a copy
  host.store.sendImage(jpeg(70, 5), { kind: 'capture', imageId: 'x1', ownerId: 'alice', categoryId: 'cat1' });
  await until(() => alice.store.has('x1') && bob.store.has('x1'));
  bob.store.drop('x1');
  alice.store.drop('x1');
  const reqAtHost = tap(host.s, MSG.imgRequest), reqAtAlice = tap(alice.s, MSG.imgRequest);
  const dataAtAlice = tap(alice.s, MSG.imgData);

  bob.store.requestMissing([{ imageId: 'x1', ownerId: 'alice' }]);
  await until(() => reqAtAlice.length === 1);
  await wait(200);
  assert.equal(bob.store.has('x1'), false);
  assert.equal(reqAtHost.length, 0, 'before the timeout only the owner is asked');
  assert.equal(bob.pending(), 1);

  bob.fire();   // IMAGE_REQUEST_TIMEOUT_MS elapsed
  await until(() => bob.store.has('x1'));
  assert.equal(reqAtHost.length, 1);
  assert.equal(reqAtAlice.length, 2, 'the broadcast reaches the owner too');
  assert.deepEqual(reqAtHost[0].data, { imageIds: ['x1'] });
  assert.equal(bob.store.get('x1').bytes[0], 5);
  assert.equal(bob.store.get('x1').meta.ownerId, 'alice');
  await wait(150);
  assert.equal(dataAtAlice.length, 0, 'the holder answered the requester only');
});

test('an owner that is not connected (or unknown / ourselves) is broadcast to right away, no waiting', async () => {
  const { host, alice, bob } = await trio();
  host.store.sendImage(jpeg(30, 8), { kind: 'chat', imageId: 'g1', ownerId: 'ghost' });
  await until(() => alice.store.has('g1') && bob.store.has('g1'));
  alice.store.drop('g1');
  const reqAtHost = tap(host.s, MSG.imgRequest);
  alice.store.requestMissing([{ imageId: 'g1', ownerId: 'ghost' }]);
  await until(() => alice.store.has('g1'));
  assert.equal(reqAtHost.length, 1);
  assert.equal(alice.pending(), 0);

  bob.store.drop('g1');
  bob.store.requestMissing(['g1']);   // bare id: owner unknown
  await until(() => bob.store.has('g1'));
  assert.equal(bob.pending(), 0);
  assert.equal(reqAtHost.length, 2);
  bob.store.requestMissing([{ imageId: 'g1', ownerId: 'bob' }]);   // already held: nothing happens
  await wait(100);
  assert.equal(reqAtHost.length, 2);
  bob.store.drop('g1');
  bob.store.requestMissing([{ imageId: 'g1', ownerId: 'bob' }]);   // owner == self: nobody to ask first
  await until(() => bob.store.has('g1'));
  assert.equal(reqAtHost.length, 3);
});

test('repeated requestMissing (one call per snapshot) does not re-send until a full timeout has passed', async () => {
  const room = roomOf();
  let t = 1000;
  const host = createSession({ roomCode: room, transport: 'local', profile: defaultProfile(), playerId: 'host', isHost: true });
  const alice = createSession({ roomCode: room, transport: 'local', profile: defaultProfile(), playerId: 'alice', isHost: false });
  sessions.push(host, alice);
  const store = createImageStore(alice, { now: () => t, setTimeout: () => ({}), clearTimeout() {} });
  stores.push(store);
  await until(() => alice.peers().length === 1);
  const req = tap(host, MSG.imgRequest);
  const want = [{ imageId: 'm1', ownerId: 'host' }];
  store.requestMissing(want); store.requestMissing(want); store.requestMissing(want);
  await until(() => req.length >= 1);
  await wait(100);
  assert.equal(req.length, 1);
  t += IMAGE_REQUEST_TIMEOUT_MS - 1;
  store.requestMissing(want);
  await wait(100);
  assert.equal(req.length, 1);
  t += 1;
  store.requestMissing(want);
  await until(() => req.length === 2);
});

test('requests are chunked to IMAGE_REQUEST_MAX_IDS ids per message; incoming requests are capped the same way', async () => {
  const { host, alice } = await trio();
  const reqAtHost = tap(host.s, MSG.imgRequest);
  const ids = Array.from({ length: IMAGE_REQUEST_MAX_IDS + 5 }, (_, i) => `k${i}`);
  alice.store.requestMissing(ids.map((imageId) => ({ imageId, ownerId: 'host' })));
  await until(() => reqAtHost.length === 2);
  assert.deepEqual(reqAtHost.map((r) => r.data.imageIds.length).sort((a, b) => a - b), [5, IMAGE_REQUEST_MAX_IDS]);

  // a hostile oversized request: only the first IMAGE_REQUEST_MAX_IDS ids are served
  for (const id of ids) host.store.sendImage(jpeg(5), { kind: 'chat', imageId: id });
  await until(() => alice.store.has(ids[ids.length - 1]));
  for (const id of ids) alice.store.drop(id);
  const dataAtAlice = tap(alice.s, MSG.imgData);
  alice.s.sendToHost(MSG.imgRequest, { imageIds: ids });
  await until(() => dataAtAlice.length === IMAGE_REQUEST_MAX_IDS);
  await wait(150);
  assert.equal(dataAtAlice.length, IMAGE_REQUEST_MAX_IDS);
  host.s.send(MSG.imgRequest, { imageIds: 'garbage' }, 'alice');   // garbage requests are ignored, nothing throws
  alice.s.sendToHost(MSG.imgRequest, null);
  await wait(50);
});

test('drop/dispose free object URLs', () => {
  const revoked = [];
  const s = createSession({ roomCode: roomOf(), transport: 'local', profile: defaultProfile(), playerId: 'solo', isHost: true });
  sessions.push(s);
  const store = createImageStore(s, { createObjectURL: (b) => `blob:${b.size}`, revokeObjectURL: (u) => revoked.push(u), setTimeout: () => ({}), clearTimeout() {} });
  store.sendImage(jpeg(11), { kind: 'chat', imageId: 'u1' });
  store.sendImage(jpeg(12), { kind: 'chat', imageId: 'u2' });
  assert.equal(store.objectUrl('u1'), 'blob:11');
  assert.equal(store.objectUrl('u2'), 'blob:12');
  store.drop('u1');
  assert.deepEqual(revoked, ['blob:11']);
  assert.equal(store.has('u1'), false);
  store.dispose();
  assert.deepEqual(revoked, ['blob:11', 'blob:12']);
  assert.equal(store.has('u2'), false);
});

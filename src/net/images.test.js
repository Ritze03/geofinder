import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, IMAGE_MAX_BYTES, IMAGE_REQUEST_MAX_IDS, IMAGE_REQUEST_TIMEOUT_MS, defaultProfile } from '../contracts.js';
import { createSession } from './session.js';
import { createImageStore, IMAGE_GRACE_MS, IMAGE_KEEP_MS } from './images.js';

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
/** session + image store with a fake clock and scheduler: nothing time-based happens until the test calls advance(ms) */
function make(room, name, isHost = false) {
  const s = createSession({ roomCode: room, transport: 'local', profile: { ...defaultProfile(), name }, playerId: name, isHost });
  let t = 1000;
  const timers = new Set();
  const store = createImageStore(s, {
    now: () => t,
    setTimeout: (fn, ms) => { const x = { fn, at: t + ms }; timers.add(x); return x; },
    clearTimeout: (x) => timers.delete(x),
    createObjectURL: (blob) => `blob:fake/${blob.size}/${blob.type}`,
    revokeObjectURL: () => {},
  });
  sessions.push(s); stores.push(store);
  /** move the clock forward, firing every timer that falls due on the way (in order); then give the local transport a moment to deliver */
  const advance = async (ms) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers].filter((x) => x.at <= end).sort((p, q) => p.at - q.at)[0];
      if (!due) break;
      timers.delete(due); t = Math.max(t, due.at); due.fn();
    }
    t = end;
    await wait(60);
  };
  return { s, store, advance };
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

test('requestMissing asks the OWNER only, grouped per owner, after the grace delay; the answer goes to the requester only', async () => {
  const { host, alice, bob } = await trio();
  alice.store.sendImage(jpeg(50, 1), { kind: 'capture', imageId: 'a1', categoryId: 'cat1' });
  host.store.sendImage(jpeg(60, 2), { kind: 'capture', imageId: 'h1', categoryId: 'cat1' });
  await until(() => bob.store.has('a1') && bob.store.has('h1'));
  bob.store.drop('a1'); bob.store.drop('h1');   // bob "missed" the transfers

  const reqAtHost = tap(host.s, MSG.imgRequest), reqAtAlice = tap(alice.s, MSG.imgRequest), reqAtBob = tap(bob.s, MSG.imgRequest);
  const dataAtAlice = tap(alice.s, MSG.imgData), dataAtHost = tap(host.s, MSG.imgData), dataAtBob = tap(bob.s, MSG.imgData);
  bob.store.requestMissing([{ imageId: 'a1', ownerId: 'alice' }, { imageId: 'h1', ownerId: 'host' }, { imageId: 'a1', ownerId: 'alice' }]);
  await bob.advance(IMAGE_GRACE_MS - 1);
  assert.equal(reqAtAlice.length + reqAtHost.length, 0, 'nothing is asked inside the grace delay');
  await bob.advance(1);

  await until(() => bob.store.has('a1') && bob.store.has('h1'));
  assert.deepEqual(reqAtAlice.map((r) => r.data), [{ imageIds: ['a1'] }]);
  assert.deepEqual(reqAtHost.map((r) => r.data), [{ imageIds: ['h1'] }]);
  assert.equal(reqAtBob.length, 0);
  assert.equal(bob.store.get('a1').meta.ownerId, 'alice');
  assert.equal(bob.store.get('h1').bytes.byteLength, 60);
  await wait(150);
  assert.equal(dataAtBob.length, 2, 'exactly one copy of each');
  assert.equal(dataAtAlice.length, 0, 'replies are not broadcast');
  assert.equal(dataAtHost.length, 0, 'replies are not broadcast');
  await bob.advance(IMAGE_REQUEST_TIMEOUT_MS * 5);   // everything arrived: nothing is asked again
  assert.equal(reqAtAlice.length + reqAtHost.length, 2);
});

test('grace delay: bytes that land during it cancel the ask completely', async () => {
  const { host, alice, bob } = await trio();
  const reqs = [tap(host.s, MSG.imgRequest), tap(alice.s, MSG.imgRequest)];
  bob.store.requestMissing([{ imageId: 'late1', ownerId: 'alice' }]);   // the snapshot overtook the bytes
  await bob.advance(1000);
  alice.store.sendImage(jpeg(40, 6), { kind: 'capture', imageId: 'late1', categoryId: 'cat1' });
  await until(() => bob.store.has('late1'));
  await bob.advance(IMAGE_GRACE_MS + IMAGE_REQUEST_TIMEOUT_MS * 4);
  assert.deepEqual(reqs.map((r) => r.length), [0, 0], 'no request at all');
});

test('owner away (not connected / ourselves / unknown): ONE peer is asked, never a broadcast', async () => {
  const { host, alice, bob } = await trio();
  host.store.sendImage(jpeg(30, 8), { kind: 'chat', imageId: 'g1', ownerId: 'ghost' });
  await until(() => alice.store.has('g1') && bob.store.has('g1'));
  alice.store.drop('g1'); bob.store.drop('g1');
  const req = { host: tap(host.s, MSG.imgRequest), alice: tap(alice.s, MSG.imgRequest), bob: tap(bob.s, MSG.imgRequest) };

  alice.store.requestMissing([{ imageId: 'g1', ownerId: 'ghost' }]);   // owner not connected
  await alice.advance(IMAGE_GRACE_MS);
  await until(() => alice.store.has('g1'));
  assert.deepEqual([req.host.length, req.bob.length, req.alice.length], [1, 0, 0], 'the host only, not bob');

  bob.store.requestMissing(['g1']);   // bare id: owner unknown
  await bob.advance(IMAGE_GRACE_MS);
  await until(() => bob.store.has('g1'));
  assert.deepEqual([req.host.length, req.alice.length], [2, 0]);

  bob.store.requestMissing([{ imageId: 'g1', ownerId: 'bob' }]);   // already held: nothing happens
  await bob.advance(IMAGE_GRACE_MS + 100);
  assert.equal(req.host.length, 2);
  bob.store.drop('g1');
  bob.store.requestMissing([{ imageId: 'g1', ownerId: 'bob' }]);   // owner == self: not a candidate, the host is asked
  await bob.advance(IMAGE_GRACE_MS);
  await until(() => bob.store.has('g1'));
  assert.deepEqual([req.host.length, req.alice.length], [3, 0]);
});

test('escalation order: owner, then the host, then (last resort) everybody; the broadcast repeats only every 2 timeouts', async () => {
  const { host, alice, bob } = await trio();
  // nobody holds it: the whole ladder runs
  const reqAtHost = tap(host.s, MSG.imgRequest), reqAtAlice = tap(alice.s, MSG.imgRequest);
  bob.store.requestMissing([{ imageId: 'nobody', ownerId: 'alice' }]);
  const counts = () => [reqAtAlice.length, reqAtHost.length];

  await bob.advance(IMAGE_GRACE_MS - 1);
  assert.deepEqual(counts(), [0, 0]);
  await bob.advance(1);                                    // 1st ask: the owner
  assert.deepEqual(counts(), [1, 0]);
  await bob.advance(IMAGE_REQUEST_TIMEOUT_MS - 1);
  assert.deepEqual(counts(), [1, 0]);
  await bob.advance(1);                                    // 2nd ask: the next peer (host), the owner is not asked twice
  assert.deepEqual(counts(), [1, 1]);
  await bob.advance(IMAGE_REQUEST_TIMEOUT_MS);             // last resort: broadcast, reaches both
  assert.deepEqual(counts(), [2, 2]);
  await bob.advance(IMAGE_REQUEST_TIMEOUT_MS * 2 - 1);
  assert.deepEqual(counts(), [2, 2]);
  await bob.advance(1);                                    // and again, at the slower pace
  assert.deepEqual(counts(), [3, 3]);
  // an answer at any point ends it
  host.store.sendImage(jpeg(9, 4), { kind: 'chat', imageId: 'nobody', ownerId: 'alice' });
  await until(() => bob.store.has('nobody'));
  await bob.advance(IMAGE_REQUEST_TIMEOUT_MS * 6);
  assert.deepEqual(counts(), [3, 3]);
});

test('escalation stops at the first holder: owner silent, host answers -> no broadcast', async () => {
  const { host, alice, bob } = await trio();
  host.store.sendImage(jpeg(70, 5), { kind: 'capture', imageId: 'x1', ownerId: 'alice', categoryId: 'cat1' });
  await until(() => alice.store.has('x1') && bob.store.has('x1'));
  bob.store.drop('x1'); alice.store.drop('x1');   // alice made it but no longer holds it
  const reqAtHost = tap(host.s, MSG.imgRequest), reqAtAlice = tap(alice.s, MSG.imgRequest);
  const dataAtAlice = tap(alice.s, MSG.imgData), dataAtBob = tap(bob.s, MSG.imgData);

  bob.store.requestMissing([{ imageId: 'x1', ownerId: 'alice' }]);
  await bob.advance(IMAGE_GRACE_MS);
  assert.deepEqual([reqAtAlice.length, reqAtHost.length], [1, 0], 'before the timeout only the owner is asked');
  await bob.advance(IMAGE_REQUEST_TIMEOUT_MS);
  await until(() => bob.store.has('x1'));
  assert.deepEqual([reqAtAlice.length, reqAtHost.length], [1, 1]);
  assert.deepEqual(reqAtHost[0].data, { imageIds: ['x1'] });
  assert.equal(bob.store.get('x1').bytes[0], 5);
  await bob.advance(IMAGE_REQUEST_TIMEOUT_MS * 4);
  assert.deepEqual([reqAtAlice.length, reqAtHost.length], [1, 1]);
  assert.equal(dataAtAlice.length, 0, 'the holder answered the requester only');
  assert.equal(dataAtBob.length, 1);
});

test('repeated requestMissing (one call per snapshot) keeps the schedule: no extra asks, no restarted grace', async () => {
  const { host, alice } = await trio();
  const req = tap(host.s, MSG.imgRequest);
  const want = [{ imageId: 'm1', ownerId: 'host' }];
  for (let i = 0; i < 4; i++) { alice.store.requestMissing(want); await alice.advance(500); }   // 2 s of snapshots
  assert.equal(req.length, 0, 'still inside the grace delay of the FIRST call');
  await alice.advance(IMAGE_GRACE_MS - 2000);
  for (let i = 0; i < 3; i++) alice.store.requestMissing(want);
  await until(() => req.length >= 1);
  await wait(100);
  assert.equal(req.length, 1);
  await alice.advance(IMAGE_REQUEST_TIMEOUT_MS - 1);
  alice.store.requestMissing(want);
  await wait(100);
  assert.equal(req.length, 1);
});

test('requestMissing forgets wanted ids that the caller no longer lists (replaced capture)', async () => {
  const { host, alice } = await trio();
  const req = tap(host.s, MSG.imgRequest);
  alice.store.requestMissing([{ imageId: 'old1', ownerId: 'host' }]);
  alice.store.requestMissing([{ imageId: 'new1', ownerId: 'host' }]);   // old1 was replaced in the next snapshot
  await alice.advance(IMAGE_GRACE_MS);
  await until(() => req.length === 1);
  assert.deepEqual(req[0].data, { imageIds: ['new1'] });
});

test('requests are chunked to IMAGE_REQUEST_MAX_IDS ids per message; incoming requests are capped the same way', async () => {
  const { host, alice } = await trio();
  const reqAtHost = tap(host.s, MSG.imgRequest);
  const ids = Array.from({ length: IMAGE_REQUEST_MAX_IDS + 5 }, (_, i) => `k${i}`);
  alice.store.requestMissing(ids.map((imageId) => ({ imageId, ownerId: 'host' })));
  await alice.advance(IMAGE_GRACE_MS);
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

test('retainOnly drops unreferenced images (revoking their URLs) but spares referenced and young ones', () => {
  const revoked = [];
  const s = createSession({ roomCode: roomOf(), transport: 'local', profile: defaultProfile(), playerId: 'solo', isHost: true });
  sessions.push(s);
  let t = 5000;
  const store = createImageStore(s, { now: () => t, createObjectURL: (b) => `blob:${b.size}`, revokeObjectURL: (u) => revoked.push(u), setTimeout: () => ({}), clearTimeout() {} });
  stores.push(store);
  store.sendImage(jpeg(11), { kind: 'capture', imageId: 'kept' });
  store.sendImage(jpeg(12), { kind: 'capture', imageId: 'replaced' });
  store.objectUrl('kept'); store.objectUrl('replaced');
  t += IMAGE_KEEP_MS - 1;
  store.sendImage(jpeg(13), { kind: 'capture', imageId: 'justSent' });   // its ref has not reached a snapshot yet

  assert.deepEqual(store.retainOnly(new Set(['kept'])), [], 'nothing is IMAGE_KEEP_MS old yet');
  t += 1;   // kept / replaced are now IMAGE_KEEP_MS old, justSent is 1 ms old
  assert.deepEqual(store.retainOnly(new Set(['kept'])), ['replaced']);
  assert.deepEqual(revoked, ['blob:12']);
  assert.deepEqual(store.ids().sort(), ['justSent', 'kept']);
  t += IMAGE_KEEP_MS;
  assert.deepEqual(store.retainOnly(new Set()), ['kept', 'justSent']);
  assert.deepEqual(revoked, ['blob:12', 'blob:11']);
  assert.deepEqual(store.ids(), []);
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

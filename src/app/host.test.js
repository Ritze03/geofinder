import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_INTENT, INTENT, MSG, PHASE, PROTOCOL_VERSION, SESSION_EVENT, SYSTEM, createInitialState, defaultProfile } from '../contracts.js';
import { createHost } from './host.js';

/** minimal Session stand-in: lets a test fire any event/message by hand and records what the host sends */
function fakeSession() {
  const handlers = new Map(), sent = [];
  return {
    sent,
    selfPlayerId: 'h',
    on(type, h) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(h); return () => handlers.get(type).delete(h); },
    emit(type, data, from) { for (const h of handlers.get(type) ?? []) h(data, from); },
    send: (...a) => sent.push(['send', ...a]),
    broadcast: (...a) => sent.push(['broadcast', ...a]),
  };
}
const start = () => {
  const session = fakeSession();
  const host = createHost({ session, state: createInitialState({ playerId: 'h', profile: defaultProfile() }, 'GEO-TEST'), onState() {} });
  session.emit(SESSION_EVENT.peerJoin, { playerId: 'p2', profile: defaultProfile(), protocol: PROTOCOL_VERSION });
  return { session, host };
};

test('intents whose sender is SYSTEM are ignored (a forged hello can never speak as the host driver)', () => {
  const { session, host } = start();
  assert.deepEqual(host.getState().players.map((p) => p.playerId), ['h', 'p2']);
  const before = host.getState();
  session.emit(MSG.intent, { intent: { type: HOST_INTENT.leave, playerId: 'p2' } }, SYSTEM);
  session.emit(MSG.intent, { intent: { type: HOST_INTENT.join, playerId: 'p3', profile: defaultProfile() } }, SYSTEM);
  session.emit(MSG.intent, { intent: { type: HOST_INTENT.tick } }, SYSTEM);
  assert.equal(host.getState(), before);
  host.stop();
});

test('a peerJoin / peerLeave for SYSTEM changes nothing', () => {
  const { session, host } = start();
  const before = host.getState();
  session.emit(SESSION_EVENT.peerJoin, { playerId: SYSTEM, profile: defaultProfile(), protocol: PROTOCOL_VERSION });
  session.emit(SESSION_EVENT.peerLeave, { playerId: SYSTEM });
  assert.equal(host.getState(), before);
  host.stop();
});

test('a normal client intent still goes through, and a non-host client cannot send host-internal intents', () => {
  const { session, host } = start();
  session.emit(MSG.intent, { intent: { type: HOST_INTENT.leave, playerId: 'h' } }, 'p2');
  assert.deepEqual(host.getState().players.map((p) => p.playerId), ['h', 'p2'], 'applyIntent refuses host-internal intents from real actors');
  session.emit(MSG.intent, { intent: { type: 'setReady', ready: true } }, 'p2');
  assert.equal(host.getState().players.find((p) => p.playerId === 'p2').ready, true);
  host.stop();
});

test('a rejoining player gets a redacted snapshot during play: others\' urls null, their own kept', () => {
  const { session, host } = start();
  const intent = (from, i) => session.emit(MSG.intent, { intent: i }, from);
  intent('h', { type: INTENT.addCategory, id: 'c1', label: 'A red door' });
  intent('h', { type: INTENT.setReady, ready: true });
  intent('p2', { type: INTENT.setReady, ready: true });
  intent('h', { type: INTENT.startGame });
  assert.equal(host.getState().phase, PHASE.play);
  const hostUrl = 'https://www.google.com/maps/@48.1,9.1,15z', p2Url = 'https://www.google.com/maps/@50.2,8.2,15z';
  intent('h', { type: INTENT.capture, captureId: 'k1', categoryId: 'c1', url: hostUrl });
  intent('p2', { type: INTENT.capture, captureId: 'k2', categoryId: 'c1', url: p2Url });
  session.emit(SESSION_EVENT.peerLeave, { playerId: 'p2' });
  session.sent.length = 0;
  session.emit(SESSION_EVENT.peerJoin, { playerId: 'p2', profile: defaultProfile(), protocol: PROTOCOL_VERSION });
  const snap = session.sent.filter((c) => c[0] === 'send' && c[1] === MSG.state && c[3] === 'p2').at(-1)[2];
  assert.equal(snap.state.phase, PHASE.play);
  assert.deepEqual(Object.fromEntries(Object.entries(snap.state.captures.c1).map(([pid, c]) => [pid, c.url])), { h: null, p2: p2Url });
  assert.ok(!JSON.stringify(snap).includes(hostUrl));
  host.stop();
});

test('every publish sends each connected player their own snapshot: other players\' capture urls are nulled during play, the host keeps the real state', () => {
  const session = fakeSession(), seen = [];
  const host = createHost({ session, state: createInitialState({ playerId: 'h', profile: defaultProfile() }, 'GEO-TEST'), onState: (m) => seen.push(m) });
  session.emit(SESSION_EVENT.peerJoin, { playerId: 'p2', profile: defaultProfile(), protocol: PROTOCOL_VERSION });
  const intent = (from, i) => session.emit(MSG.intent, { intent: i }, from);
  intent('h', { type: INTENT.addCategory, id: 'c1', label: 'A red door' });
  intent('h', { type: INTENT.setReady, ready: true });
  intent('p2', { type: INTENT.setReady, ready: true });
  intent('h', { type: INTENT.startGame });
  assert.equal(host.getState().phase, PHASE.play);
  const hostUrl = 'https://www.google.com/maps/@48.1,9.1,15z', p2Url = 'https://www.google.com/maps/@50.2,8.2,15z';
  intent('h', { type: INTENT.capture, captureId: 'k1', categoryId: 'c1', url: hostUrl });
  intent('p2', { type: INTENT.capture, captureId: 'k2', categoryId: 'c1', url: p2Url });

  const urls = (state) => Object.fromEntries(Object.entries(state.captures.c1).map(([pid, c]) => [pid, c.url]));
  assert.deepEqual(urls(host.getState()), { h: hostUrl, p2: p2Url }, 'the authoritative state stays unredacted');
  assert.deepEqual(urls(seen.at(-1).state), { h: hostUrl, p2: null }, 'the host UI sees its own url only');
  const toP2 = session.sent.filter((c) => c[0] === 'send' && c[1] === MSG.state && c[3] === 'p2').at(-1)[2];
  assert.deepEqual(urls(toP2.state), { h: null, p2: p2Url }, 'p2 sees its own url only');
  assert.equal(toP2.rev, host.getState().rev, 'redacted copies keep rev');
  assert.ok(!session.sent.some((c) => c[0] === 'broadcast'), 'no unredacted broadcast');
  assert.ok(!session.sent.filter((c) => c[3] === 'p2').some((c) => JSON.stringify(c[2]).includes(hostUrl) && c[2].state.phase === PHASE.play), 'the host url never travels to p2 during play');
  host.stop();
});

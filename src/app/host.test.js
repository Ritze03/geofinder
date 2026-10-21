import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_INTENT, MSG, PROTOCOL_VERSION, SESSION_EVENT, SYSTEM, createInitialState, defaultProfile } from '../contracts.js';
import { createHost } from './host.js';

/** minimal Session stand-in: lets a test fire any event/message by hand and records what the host sends */
function fakeSession() {
  const handlers = new Map(), sent = [];
  return {
    sent,
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

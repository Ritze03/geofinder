// Host driver: the one place that runs core.applyIntent. Clients send intents, this applies them and broadcasts full snapshots.
//   const host = createHost({ session, state, onState(msg), onIntentError?(actorId, intent, err) })
//   host.stop()
// Wiring: hello (SESSION_EVENT.peerJoin) -> HOST_INTENT.join (+ MSG.reject on full / started / protocol), peerLeave -> HOST_INTENT.leave,
// MSG.intent -> applyIntent(actor = the stamped sender), setInterval(HOST_TICK_MS) -> HOST_INTENT.tick. Every change
// (result.state !== state) is broadcast as { rev, now, state } and handed to onState (the host's own UI); a (re)joining player
// additionally gets the snapshot alone right away.
import { ERR, HOST_INTENT, HOST_TICK_MS, MSG, PROTOCOL_VERSION, SESSION_EVENT, SYSTEM } from '../contracts.js';
import { applyIntent } from '../core/index.js';

export function createHost({ session, state: initial, onState, onIntentError }) {
  let state = initial;
  let stopped = false;

  const snapshot = (now = Date.now()) => ({ rev: state.rev, now, state });
  const publish = () => {
    const msg = snapshot();
    session.broadcast(MSG.state, msg);
    onState(msg);
  };

  /** applyIntent + broadcast on change. Returns the ERR code or null. */
  function apply(actor, intent, now = Date.now()) {
    if (stopped) return null;
    const r = applyIntent(state, actor, intent, now);
    if (r.error) return r.error;
    if (r.state !== state) { state = r.state; publish(); }
    return null;
  }

  const offs = [
    session.on(SESSION_EVENT.peerJoin, (info) => {
      if (info.playerId === SYSTEM) return;
      if (info.protocol !== PROTOCOL_VERSION) {
        session.send(MSG.reject, { reason: ERR.protocol }, info.playerId);
        return;
      }
      const err = apply(SYSTEM, { type: HOST_INTENT.join, playerId: info.playerId, profile: info.profile });
      if (err === ERR.full || err === ERR.started) session.send(MSG.reject, { reason: err }, info.playerId);
      else if (!err) session.send(MSG.state, snapshot(), info.playerId); // new seat or rejoin: bring them up to date at once
    }),
    session.on(SESSION_EVENT.peerLeave, ({ playerId }) => { if (playerId !== SYSTEM) apply(SYSTEM, { type: HOST_INTENT.leave, playerId }); }),
    session.on(MSG.intent, (data, from) => {
      const intent = data && data.intent;
      if (!intent || typeof intent.type !== 'string' || from === SYSTEM) return;   // SYSTEM is the host driver's own actor, never a peer (defence in depth: the session already refuses such hellos)
      apply(SYSTEM, { type: HOST_INTENT.tick }); // contract: tick right before applying, so a late intent sees the ended round
      const err = apply(from, intent);
      if (err && onIntentError) onIntentError(from, intent, err);
    }),
  ];
  const timer = setInterval(() => apply(SYSTEM, { type: HOST_INTENT.tick }), HOST_TICK_MS);

  publish(); // initial snapshot for the local UI (nobody else is connected yet)

  return {
    stop() { stopped = true; clearInterval(timer); for (const off of offs) off(); },
    getState: () => state,
  };
}

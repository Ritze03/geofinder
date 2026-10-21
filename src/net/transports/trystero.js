// Production transport: Trystero 0.26.0 (Nostr strategy = package default export), loaded lazily so node tests and the local transport never pull it in.
// createTransport returns synchronously; the room is joined once the module has loaded. Until then sends are dropped (there are no peers yet).
//
// Trystero 0.26.0 API used (verified against @trystero-p2p/core types.d.mts):
//   action.send(data: JsonValue, {target?}): Promise<void>;  action.onMessage = (data, {peerId}) => void
//   makeAction(type, {onReceive: ({peerId, byteLength}) => boolean})  accept/decline BEFORE a large payload is transferred
// Action names must be 1..32 UTF-8 bytes.
import { APP_ID, MSG } from '../../contracts.js';

/** Cap for every action (hello, reject, intent, state, hb). Worst-case full snapshot (8 players x 20 categories of 2048-char capture urls + 200 chat links of 2048 chars + all-CJK text): ~1.03 MB, ~0.9 MB with ASCII chat (measured in trystero.test.js), so 4 MiB leaves ~4x headroom. */
export const JSON_MAX_BYTES = 4 * 1024 * 1024;

/** @param {string} roomCode Trystero room id
 *  @param {string[]} types action names to create (<= 32 bytes each); every peer must create the same set up front */
export function createTransport(roomCode, types = Object.values(MSG)) {
  const actions = {}, handlers = new Map();
  let room = null, selfId = null, left = false;
  let joinHandler = null, leaveHandler = null, errorHandler = null;

  (async () => {
    const trystero = await import('trystero');
    if (left) return;
    selfId = trystero.selfId;
    room = trystero.joinRoom({ appId: APP_ID }, roomCode, { onJoinError: (e) => errorHandler?.(new Error(e.error)) });
    for (const type of types) {
      // Declined before the payload is transferred. Without onReceive Trystero accepts up to 256 MB per message, so every action gets a cap.
      const config = { onReceive: ({ byteLength }) => byteLength <= JSON_MAX_BYTES };
      const action = room.makeAction(type, config);
      action.onMessage = (data, { peerId }) => handlers.get(type)?.(data, peerId);
      actions[type] = action;
    }
    room.onPeerJoin = (id) => joinHandler?.(id);
    room.onPeerLeave = (id) => leaveHandler?.(id);
  })().catch((e) => errorHandler?.(e));

  return {
    get selfId() { return selfId; },   // null until the Trystero module has loaded
    send(type, data, target) {
      actions[type]?.send(data, target ? { target } : {}).catch(() => {});
    },
    onMessage: (type, handler) => handlers.set(type, handler),
    onPeerJoin(handler) { joinHandler = handler; if (room) room.onPeerJoin = (id) => joinHandler?.(id); },   // re-assigning replays peers already present
    onPeerLeave(handler) { leaveHandler = handler; },
    onError(handler) { errorHandler = handler; },   // extra, optional: import / join failures (session turns it into SESSION_EVENT.error)
    ping: (peerId) => (room ? room.ping(peerId) : Promise.reject(new Error('not connected'))),
    leave() { left = true; room?.leave().catch(() => {}); },
  };
}

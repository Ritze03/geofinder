// Production transport: Trystero 0.26.0 (Nostr strategy = package default export), loaded lazily so node tests and the local transport never pull it in.
// createTransport returns synchronously; the room is joined once the module has loaded. Until then sends are dropped (there are no peers yet).
//
// Binary (verified against @trystero-p2p/core 0.26.0 types.d.mts + README "Binary metadata"):
//   action.send(data: JsonValue|Blob|ArrayBuffer|ArrayBufferView, {target?, metadata?}): Promise<void>
//   action.onMessage = (data, {peerId, metadata}) => void       (binary arrives as a raw ArrayBuffer, JSON as the parsed value)
//   makeAction(type, {onReceive: ({peerId, byteLength, kind, metadata}) => boolean})  accept/decline BEFORE a large payload is transferred
// Chunking/throttling of large payloads is done by Trystero itself. Action names must be 1..32 UTF-8 bytes.
import { APP_ID, MSG, IMAGE_MAX_BYTES } from '../../contracts.js';

/** Cap for every non-image action (hello, reject, intent, state, imgRequest, hb). Worst-case full snapshot: ~290 KB with all-CJK chat, ~170 KB with ASCII chat (measured in trystero.test.js), so 1 MiB leaves >3x headroom. */
export const JSON_MAX_BYTES = 1024 * 1024;

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
      // Declined before the payload is transferred (the session also re-checks images on delivery). Without onReceive Trystero accepts
      // up to 256 MB per message, so JSON actions get a cap too: JSON_MAX_BYTES.
      const config = { onReceive: ({ byteLength }) => byteLength <= (type === MSG.imgData ? IMAGE_MAX_BYTES : JSON_MAX_BYTES) };
      const action = room.makeAction(type, config);
      action.onMessage = (data, { peerId, metadata }) => handlers.get(type)?.(data, peerId, metadata);
      actions[type] = action;
    }
    room.onPeerJoin = (id) => joinHandler?.(id);
    room.onPeerLeave = (id) => leaveHandler?.(id);
  })().catch((e) => errorHandler?.(e));

  return {
    get selfId() { return selfId; },   // null until the Trystero module has loaded
    send(type, data, target, metadata) {
      const options = {};
      if (target) options.target = target;
      if (metadata !== undefined) options.metadata = metadata;
      actions[type]?.send(data, options).catch(() => {});
    },
    onMessage: (type, handler) => handlers.set(type, handler),
    onPeerJoin(handler) { joinHandler = handler; if (room) room.onPeerJoin = (id) => joinHandler?.(id); },   // re-assigning replays peers already present
    onPeerLeave(handler) { leaveHandler = handler; },
    onError(handler) { errorHandler = handler; },   // extra, optional: import / join failures (session turns it into SESSION_EVENT.error)
    ping: (peerId) => (room ? room.ping(peerId) : Promise.reject(new Error('not connected'))),
    leave() { left = true; room?.leave().catch(() => {}); },
  };
}

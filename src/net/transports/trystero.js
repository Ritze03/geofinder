// Production transport: Trystero 0.26.0 (Nostr strategy = package default export), loaded lazily so node tests and the local transport never pull it in.
// createTransport returns synchronously; the room is joined once the module has loaded. Until then sends are dropped (there are no peers yet).
//
// Binary (verified against @trystero-p2p/core 0.26.0 types.d.mts + README "Binary metadata"):
//   action.send(data: JsonValue|Blob|ArrayBuffer|ArrayBufferView, {target?, metadata?}): Promise<void>
//   action.onMessage = (data, {peerId, metadata}) => void       (binary arrives as a raw ArrayBuffer, JSON as the parsed value)
//   makeAction(type, {onReceive: ({peerId, byteLength, kind, metadata}) => boolean})  accept/decline BEFORE a large payload is transferred
// Chunking/throttling of large payloads is done by Trystero itself. Action names must be 1..32 UTF-8 bytes.
import { APP_ID, MSG, IMAGE_MAX_BYTES } from '../../contracts.js';

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
      // an oversize image is declined before its chunks are even requested (the session also re-checks on delivery)
      const config = type === MSG.imgData ? { onReceive: ({ byteLength }) => byteLength <= IMAGE_MAX_BYTES } : undefined;
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

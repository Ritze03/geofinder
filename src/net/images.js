// Image transfer helper (contracts section 7, D11). One store per session: Map<imageId, {bytes, meta}> in memory plus the routing:
//   send:    sendImage(bytes, meta) stores locally and broadcasts MSG.imgData (metadata = ImageMeta) to everybody.
//   receive: MSG.imgData is validated (size, mime, imageId) and stored if new; duplicates are ignored.
//   missing: requestMissing(items) asks each OWNER (MSG.imgRequest {imageIds}, grouped per owner, <= IMAGE_REQUEST_MAX_IDS per message);
//            ids still missing after IMAGE_REQUEST_TIMEOUT_MS are asked from EVERYBODY (broadcast).
//   serve:   any peer holding a requested image answers with MSG.imgData to the REQUESTER ONLY.
// The app calls requestMissing after every snapshot with the images it references but lacks; repeated calls for an id that is already being
// asked are no-ops until the previous ask is a full timeout old, so a snapshot per second does not flood the mesh.
import { MSG, IMAGE_MIME, IMAGE_MAX_BYTES, IMAGE_REQUEST_TIMEOUT_MS, IMAGE_REQUEST_MAX_IDS } from '../contracts.js';

/** @typedef {import('../contracts.js').ImageMeta} ImageMeta */
/** @typedef {{ bytes:Uint8Array, meta:ImageMeta }} StoredImage */

/** any binary payload -> Uint8Array view (no copy), or null */
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
const validMeta = (m) => !!m && typeof m === 'object' && typeof m.imageId === 'string' && m.imageId !== '' && m.mime === IMAGE_MIME;

/**
 * @param {import('../contracts.js').Session} session
 * @param {{ timeoutMs?:number, setTimeout?:Function, clearTimeout?:Function, now?:(() => number), createObjectURL?:((blob:Blob) => string), revokeObjectURL?:((url:string) => void) }} [opts]
 *   all optional; injectable for tests (fake timers, no URL global in node).
 */
export function createImageStore(session, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS;
  const setTimer = opts.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = opts.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const now = opts.now ?? Date.now;
  const makeUrl = opts.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
  const revokeUrl = opts.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));

  /** @type {Map<string, StoredImage>} */ const images = new Map();
  const urls = new Map();       // imageId -> object URL
  const listeners = new Set();  // (imageId, StoredImage) => void
  const asked = new Map();      // missing imageId -> { askedAt:number }   (when we last asked for it; gates repeat calls)
  const timers = new Set();
  let disposed = false;

  const notify = (imageId, entry) => {
    for (const cb of [...listeners]) {
      try { cb(imageId, entry); } catch (e) { console.error('[net] onImage listener threw', e); }
    }
  };

  /** store if valid and new; returns the entry when it was added */
  function store(bytes, meta) {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_BYTES || !validMeta(meta) || images.has(meta.imageId)) return null;
    const entry = { bytes, meta: { ...meta } };
    images.set(meta.imageId, entry);
    asked.delete(meta.imageId);
    return entry;
  }

  const offData = session.on(MSG.imgData, (data, _from, metadata) => {
    const entry = store(toBytes(data), metadata);
    if (entry) notify(entry.meta.imageId, entry);
  });

  const offRequest = session.on(MSG.imgRequest, (data, from) => {
    const ids = Array.isArray(data?.imageIds) ? data.imageIds.slice(0, IMAGE_REQUEST_MAX_IDS) : [];
    for (const id of ids) {
      const held = typeof id === 'string' ? images.get(id) : null;
      if (held) session.send(MSG.imgData, held.bytes, from, { metadata: held.meta });   // requester only; ids nobody holds are ignored
    }
  });

  const ask = (imageIds, toPlayerId) => {
    for (let i = 0; i < imageIds.length; i += IMAGE_REQUEST_MAX_IDS) {
      const payload = { imageIds: imageIds.slice(i, i + IMAGE_REQUEST_MAX_IDS) };
      if (toPlayerId) session.send(MSG.imgRequest, payload, toPlayerId);
      else session.broadcast(MSG.imgRequest, payload);
    }
  };

  return {
    /** Store `bytes` locally and broadcast them to every peer. `meta` needs imageId (and kind/categoryId); ownerId, at, mime default.
     *  Throws RangeError when the image exceeds IMAGE_MAX_BYTES (receivers would drop it anyway). Returns the full ImageMeta. */
    sendImage(bytes, meta) {
      const u8 = toBytes(bytes);
      if (!u8 || u8.byteLength === 0) throw new TypeError('sendImage: bytes must be a non-empty ArrayBuffer/Uint8Array');
      if (u8.byteLength > IMAGE_MAX_BYTES) throw new RangeError(`sendImage: ${u8.byteLength} bytes exceeds IMAGE_MAX_BYTES`);
      const full = { ownerId: session.selfPlayerId, at: now(), mime: IMAGE_MIME, ...meta };
      if (!validMeta(full)) throw new TypeError('sendImage: meta needs a string imageId and mime image/jpeg');
      const entry = store(u8, full);
      session.broadcast(MSG.imgData, u8, { metadata: entry?.meta ?? images.get(full.imageId).meta });   // re-sending a known id re-broadcasts the stored copy
      if (entry) notify(full.imageId, entry);
      return { ...(entry?.meta ?? images.get(full.imageId).meta) };
    },

    /** Ask for images we lack. items: `{imageId, ownerId}` (ownerId = CaptureRef.playerId / ChatMessage.playerId) or a bare imageId string
     *  (owner unknown => asked from everybody at once). Held ids and ids already being asked are skipped. An owner that is not currently connected
     *  (or is ourselves) is not waited for: that id goes straight to the broadcast. */
    requestMissing(items) {
      if (disposed) return;
      const t = now();
      const byOwner = new Map();   // ownerId -> ids, null key = broadcast now
      for (const it of items ?? []) {
        const imageId = typeof it === 'string' ? it : it?.imageId;
        if (typeof imageId !== 'string' || images.has(imageId)) continue;
        const prev = asked.get(imageId);
        if (prev && t - prev.askedAt < timeoutMs) continue;
        let owner = typeof it === 'string' ? null : it.ownerId ?? null;
        if (owner === session.selfPlayerId || (owner && !session.peers().some((p) => p.playerId === owner))) owner = null;
        asked.set(imageId, { askedAt: t });
        if (!byOwner.has(owner)) byOwner.set(owner, []);
        byOwner.get(owner).push(imageId);
      }
      for (const [owner, ids] of byOwner) {
        ask(ids, owner);
        if (!owner) continue;
        const timer = setTimer(() => {
          timers.delete(timer);
          if (disposed) return;
          const still = ids.filter((id) => !images.has(id));
          for (const id of still) asked.set(id, { askedAt: now() });
          ask(still);   // nobody answered in time: ask everybody
        }, timeoutMs);
        timers.add(timer);
      }
    },

    /** @returns {StoredImage|undefined} */
    get: (imageId) => images.get(imageId),
    has: (imageId) => images.has(imageId),
    /** Subscribe to newly stored images (own sends included): cb(imageId, {bytes, meta}). Returns unsubscribe. */
    onImage(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    /** Cached blob: object URL for an <img>, or null while the bytes are missing. Revoked by drop()/dispose(). */
    objectUrl(imageId) {
      const e = images.get(imageId);
      if (!e) return null;
      if (!urls.has(imageId)) urls.set(imageId, makeUrl(new Blob([e.bytes], { type: e.meta.mime })));
      return urls.get(imageId);
    },
    /** Free one image (e.g. replaced capture / chat message trimmed out of state). */
    drop(imageId) {
      images.delete(imageId);
      asked.delete(imageId);
      const u = urls.get(imageId);
      if (u) { urls.delete(imageId); revokeUrl(u); }
    },
    /** Ids currently held. */
    ids: () => [...images.keys()],
    dispose() {
      disposed = true;
      offData(); offRequest();
      for (const t of timers) clearTimer(t);
      timers.clear();
      for (const u of urls.values()) revokeUrl(u);
      urls.clear(); images.clear(); asked.clear(); listeners.clear();
    },
  };
}

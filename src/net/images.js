// Image transfer helper (contracts section 7, D11). One store per session: Map<imageId, {bytes, meta}> in memory plus the routing:
//   send:    sendImage(bytes, meta) stores locally and broadcasts MSG.imgData (metadata = ImageMeta) to everybody.
//   receive: MSG.imgData is validated (size, mime, imageId) and stored if new; duplicates are ignored.
//   missing: requestMissing(items) never broadcasts as a first step (every holder would answer with the full bytes). Per missing id:
//            wait IMAGE_GRACE_MS after the ref first showed up (the bytes may still be in flight), then ask ONE connected peer: the owner if
//            he is connected and not us, else the host, else any other peer. Every IMAGE_REQUEST_TIMEOUT_MS without an answer, ask the NEXT
//            candidate. After IMAGE_PEER_TRIES single asks, broadcast to everybody as the last resort (repeated every 2 timeouts).
//   serve:   any peer holding a requested image answers with MSG.imgData to the REQUESTER ONLY.
// The app calls requestMissing after every snapshot with the images it references but lacks (the COMPLETE set; wanted ids that are no longer
// in it are forgotten) and retainOnly() with every id the snapshot references. Repeated calls are cheap no-ops: the schedule is kept per id.
import { MSG, IMAGE_MIME, IMAGE_MAX_BYTES, IMAGE_REQUEST_TIMEOUT_MS, IMAGE_REQUEST_MAX_IDS } from '../contracts.js';

/** first ask for a missing image comes this long after its ref first appeared, so bytes that are still in flight can land first */
export const IMAGE_GRACE_MS = 2500;
/** single-peer asks before the last-resort broadcast */
export const IMAGE_PEER_TRIES = 2;
/** retainOnly() never drops an image younger than this: it may be in flight or just sent by us with its ref not in a snapshot yet */
export const IMAGE_KEEP_MS = 10_000;

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
  const graceMs = opts.graceMs ?? IMAGE_GRACE_MS;
  const keepMs = opts.keepMs ?? IMAGE_KEEP_MS;
  const setTimer = opts.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = opts.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const now = opts.now ?? Date.now;
  const makeUrl = opts.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
  const revokeUrl = opts.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));

  /** @type {Map<string, StoredImage>} */ const images = new Map();
  const urls = new Map();       // imageId -> object URL
  const listeners = new Set();  // (imageId, StoredImage) => void
  const wanted = new Map();     // missing imageId -> { ownerId, tried:Set<playerId>, nextAt:number, broadcasts:number }
  let timer = null;             // the one pump timer, always set for the earliest nextAt
  let disposed = false;

  const notify = (imageId, entry) => {
    for (const cb of [...listeners]) {
      try { cb(imageId, entry); } catch (e) { console.error('[net] onImage listener threw', e); }
    }
  };

  /** store if valid and new; returns the entry when it was added */
  function store(bytes, meta) {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_BYTES || !validMeta(meta) || images.has(meta.imageId)) return null;
    const entry = { bytes, meta: { ...meta }, storedAt: now() };
    images.set(meta.imageId, entry);
    wanted.delete(meta.imageId);
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

  const send = (imageIds, toPlayerId) => {
    for (let i = 0; i < imageIds.length; i += IMAGE_REQUEST_MAX_IDS) {
      const payload = { imageIds: imageIds.slice(i, i + IMAGE_REQUEST_MAX_IDS) };
      if (toPlayerId) session.send(MSG.imgRequest, payload, toPlayerId);
      else session.broadcast(MSG.imgRequest, payload);
    }
  };

  /** untried connected peers, best first: the owner (unless it is us), then the host, then everybody else */
  function candidates(w) {
    const connected = session.peers().map((p) => p.playerId).filter((id) => id !== session.selfPlayerId);
    const order = [w.ownerId, session.hostPlayerId(), ...connected];
    return [...new Set(order)].filter((id) => id && connected.includes(id) && !w.tried.has(id));
  }

  /** do every due ask, then re-arm the timer for the earliest remaining one. Idempotent: calling it early does nothing. */
  function pump() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (disposed) return;
    const t = now();
    const perPeer = new Map(), everybody = [];
    for (const [id, w] of wanted) {
      if (w.nextAt > t) continue;
      const next = w.tried.size < IMAGE_PEER_TRIES ? candidates(w)[0] : undefined;
      if (next) {
        w.tried.add(next);
        w.nextAt = t + timeoutMs;
        if (!perPeer.has(next)) perPeer.set(next, []);
        perPeer.get(next).push(id);
      } else if (w.tried.size > 0) {
        everybody.push(id);              // tried enough peers (or all there are): last resort, repeated at a slower pace
        w.nextAt = t + 2 * timeoutMs;
      } else {
        w.nextAt = t + timeoutMs;        // nobody to ask yet: look again later, no broadcast into an empty room
      }
    }
    for (const [peer, ids] of perPeer) send(ids, peer);
    if (everybody.length) send(everybody);
    let earliest = Infinity;
    for (const w of wanted.values()) earliest = Math.min(earliest, w.nextAt);
    if (earliest !== Infinity) timer = setTimer(pump, Math.max(0, earliest - now()));
  }

  function drop(imageId) {
    images.delete(imageId);
    wanted.delete(imageId);
    const u = urls.get(imageId);
    if (u) { urls.delete(imageId); revokeUrl(u); }
  }

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

    /** Ask for images we lack. items: `{imageId, ownerId}` (ownerId = CaptureRef.playerId / ChatMessage.playerId) or a bare imageId string.
     *  Pass the COMPLETE set the current state references each time (held ids are skipped; wanted ids missing from it are forgotten).
     *  Safe to call on every snapshot: a known id keeps its schedule. Nothing is sent before IMAGE_GRACE_MS; see the file header for the order. */
    requestMissing(items) {
      if (disposed) return;
      const t = now();
      const keep = new Set();
      for (const it of items ?? []) {
        const imageId = typeof it === 'string' ? it : it?.imageId;
        if (typeof imageId !== 'string' || images.has(imageId)) continue;
        keep.add(imageId);
        if (!wanted.has(imageId)) {
          wanted.set(imageId, { ownerId: typeof it === 'string' ? null : it.ownerId ?? null, tried: new Set(), nextAt: t + graceMs });
        }
      }
      for (const id of [...wanted.keys()]) if (!keep.has(id)) wanted.delete(id);
      pump();
    },

    /** Drop every held image that is not in `referenced` (a Set of imageIds) and was stored at least IMAGE_KEEP_MS ago. Returns the dropped ids. */
    retainOnly(referenced) {
      const t = now(), gone = [];
      for (const [id, e] of images) if (!referenced.has(id) && t - e.storedAt >= keepMs) gone.push(id);
      for (const id of gone) drop(id);
      return gone;
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
    drop,
    /** Ids currently held. */
    ids: () => [...images.keys()],
    dispose() {
      disposed = true;
      offData(); offRequest();
      if (timer !== null) clearTimer(timer);
      timer = null;
      for (const u of urls.values()) revokeUrl(u);
      urls.clear(); images.clear(); wanted.clear(); listeners.clear();
    },
  };
}

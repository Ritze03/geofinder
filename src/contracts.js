/**
 * Geofinder -- FROZEN MODULE CONTRACTS (single source of truth between modules).
 *
 * Importable from browser AND plain node. No imports, no DOM/storage access at module load.
 * Real code here is limited to constants/enums and tiny pure helpers that several modules must share.
 * Game RULES (ready/done/scoring/review flow) live in src/core/, not here. If a signature here is wrong,
 * tell the lead; do not fork it locally.
 *
 * GLOBAL CONVENTIONS
 *  - Identity inside a game is `playerId` (uuid string, permanent per install, see KEYS). No seat indices.
 *  - All times are integer MILLISECONDS (epoch, HOST clock) unless the name says otherwise (`minutes`).
 *  - All state and all wire payloads are plain JSON (except image bytes, section 6). No Maps/Sets/undefined.
 *  - Code/identifiers English, user-visible strings English (the mockup is English).
 *  - The host is authoritative and the only one that runs core.applyIntent. Clients render `state` messages.
 *  - Core is PURE: it never calls Date.now()/Math.random(). Time comes in as the `now` argument, and every
 *    intent that creates something carries a client-made `id` (makeId()), so replaying an intent is deterministic
 *    and a duplicate (same id) can be ignored.
 *
 * SECTIONS (grep the `=====` headers)
 *   1 Constants & enums        5 Wire: messages, transport, session
 *   2 Profile presets          6 Intents (client -> host, host-internal)
 *   3 Identity & storage       7 Image routing (D11)
 *   4 GameState                8 Shared pure helpers: ids, room codes, profile sanitising, clock skew
 */

const freeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v); return Object.freeze(o); };
/** enum helper: en('a','b') -> {a:'a', b:'b'} (frozen), so typos become undefined instead of silent strings. */
const en = (...names) => Object.freeze(Object.fromEntries(names.map((n) => [n, n])));

// ===== 1. Constants & enums =====

/** Trystero appId; the local (BroadcastChannel) transport channel is `${APP_ID}:${roomCode}`. */
export const APP_ID = 'geofinder-v1';
/** Bump on ANY wire or GameState shape change. Mismatch => host answers MSG.reject {reason:'protocol'}. */
export const PROTOCOL_VERSION = 1;
/** Seats per room, host included. A 9th joiner gets reject 'full'. */
export const MAX_PLAYERS = 8;
/** Host Start needs at least this many connected players (rating needs someone else). */
export const MIN_PLAYERS = 2;
/** Profile name length cap (the mockup input has maxlength 14). */
export const NAME_MAX = 14;
/** Category label length cap (suggestions, host categories, renames). */
export const CATEGORY_LABEL_MAX = 60;
/** Caps on list sizes; the host rejects intents beyond them with ERR.limit. */
export const MAX_CATEGORIES = 20;
/** Max PENDING suggestions in total. */
export const MAX_SUGGESTIONS = 20;
/** Chat text cap per message. */
export const CHAT_TEXT_MAX = 300;
/** Core keeps only the newest N chat messages in state.chat (older ones are dropped, their images may be freed). */
export const CHAT_HISTORY_MAX = 200;

/**
 * Round-time presets in MINUTES (the lobby slider: 5..30 step 5). Default 10.
 * state.settings.roundMinutes holds one of these; round length in ms = minutes * 60_000.
 */
export const ROUND_TIMES_MIN = Object.freeze([5, 10, 15, 20, 25, 30]);
export const DEFAULT_ROUND_MIN = 10;

/** Everybody done => this countdown starts; at zero the round ends. Cancelled when anyone un-dones; restarts full. */
export const DONE_COUNTDOWN_MS = 60_000;
/** The host driver calls applyIntent(HOST_INTENT.tick) at this cadence (and once more right before each broadcast). */
export const HOST_TICK_MS = 250;

/** Review rating range. */
export const STARS_MIN = 1;
export const STARS_MAX = 5;

/** Images (D11): JPEG, at most this many px wide, at this quality. mapPanel.capture() already produces them. */
export const IMAGE_MAX_WIDTH = 1280;
export const IMAGE_JPEG_QUALITY = 0.8;
export const IMAGE_MIME = 'image/jpeg';
/** Receivers drop an incoming image larger than this (a 1280 px q0.8 map shot is ~150-500 KB). */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** After asking the owner for a missing image, wait this long, then ask everybody (see section 6). */
export const IMAGE_REQUEST_TIMEOUT_MS = 4000;
/** Max imageIds in one MSG.imgRequest. */
export const IMAGE_REQUEST_MAX_IDS = 40;

/**
 * Phases. 'profile' is LOCAL ONLY (before joining a room); it never appears in GameState.phase.
 * Flow: profile -> lobby -> play -> review -> results -> (playAgain) lobby.
 */
export const PHASE = en('profile', 'lobby', 'play', 'review', 'results');
/** @typedef {'lobby'|'play'|'review'|'results'} GamePhase   the values GameState.phase can take */

/** Starter categories for a fresh room (the mockup's sample list). Ids are deterministic: 'cat1'..'cat6'. */
export const DEFAULT_CATEGORIES = Object.freeze([
  'a heart-shaped pool', 'a red car on a roundabout', 'a giant letter on a field',
  'a football pitch next to a river', 'a boat on a lake', 'a roof covered in solar panels',
]);

/** Error codes of a refused intent / join (core returns them in ApplyResult.error; host may relay as MSG.reject). */
export const ERR = en('forbidden', 'wrongPhase', 'invalid', 'notFound', 'limit', 'tooFewPlayers', 'noCategories', 'notReady',
  'full', 'started', 'protocol');

// ===== 2. Profile presets =====
// A profile is exactly: name + color + head + face. Ids are stable and stored/sent; `hex` / drawing is UI's business.
// Source of truth for the look is design/mockup.html (COLORS / HEADS / FACES arrays; index order is preserved here).
// I6 draws heads and faces as SVG from the ids (the mockup's SVG paths are the reference). 8 players share 6 colors,
// so colors are NOT unique per room.

/** Player colors. `hex` is the head fill and the player's accent everywhere (ring, chat name, review card). */
export const COLORS = freeze([
  { id: 'coral', hex: '#ff6b5e' }, { id: 'sky', hex: '#4cc9f0' }, { id: 'mint', hex: '#3ddc97' },
  { id: 'violet', hex: '#a78bfa' }, { id: 'orange', hex: '#ff9f43' }, { id: 'pink', hex: '#f472b6' },
]);
/** Head shapes, mockup order: circle, rounded square, wide ellipse, hexagon, dome/bell. `label` for aria. */
export const HEADS = freeze([
  { id: 'round', label: 'Round' }, { id: 'square', label: 'Square' }, { id: 'wide', label: 'Wide' },
  { id: 'hex', label: 'Hexagon' }, { id: 'dome', label: 'Dome' },
]);
/** Faces, mockup order: dots+smile, shades, wink+open mouth, surprised, sleepy (with a "z"). */
export const FACES = freeze([
  { id: 'happy', label: 'Happy' }, { id: 'cool', label: 'Cool' }, { id: 'wink', label: 'Wink' },
  { id: 'oh', label: 'Surprised' }, { id: 'sleepy', label: 'Sleepy' },
]);
/** Ink color of face features in the mockup. */
export const FACE_INK = '#1b1428';

/** @typedef {'coral'|'sky'|'mint'|'violet'|'orange'|'pink'} ColorId */
/** @typedef {'round'|'square'|'wide'|'hex'|'dome'} HeadId */
/** @typedef {'happy'|'cool'|'wink'|'oh'|'sleepy'} FaceId */
/** @typedef {{ name:string, color:ColorId, head:HeadId, face:FaceId }} Profile
 *  name: trimmed, 1..NAME_MAX chars. The other three are ids from COLORS / HEADS / FACES. Nothing else belongs in a profile.
 *  Persisted in localStorage under KEYS.profile(pid) (JSON Profile). playerId is stored separately under KEYS.playerId(pid). */

// ===== 3. Identity & storage =====
// One install = one player. playerId is permanent (crypto.randomUUID()); a dropped client rejoins its seat by playerId.
// `pid` is an optional storage namespace suffix (debug/tests: several instances sharing one storage); null/'' => no suffix.
// Every storage read/write MUST be try/catch-wrapped; a failed read behaves as "nothing stored".
export const KEYS = freeze({
  playerId: (pid) => `geofinder:player${pid ? ':' + pid : ''}`,    // string uuid
  profile: (pid) => `geofinder:profile${pid ? ':' + pid : ''}`,    // JSON Profile
});
// (WK's KEYS.host / KEYS.save / muted / volume are gone: no host resume in v1, no audio.)

/** Identity helpers exported by src/net/identity.js (all sync, never throw):
 *  @typedef {{
 *    loadIdentity(pid?:(string|null)): { playerId:string, profile:(Profile|null) },   // creates+stores playerId on first call; profile null if none stored/corrupt
 *    saveProfile(profile:Profile, pid?:(string|null)): void,
 *  }} IdentityApi */

// ===== 4. GameState =====
// Plain JSON, JSON.stringify round-trips, never mutated by readers. NOT frozen (core clones and returns a new object per change).
// `rev` increments on every applyIntent that changed anything; clients drop `state` messages with rev <= last applied.
// There is NO save/resume: host gone => game over (SESSION_EVENT.hostGone).
//
// DERIVED, NOT STORED: points. points(player) = sum of every star rating that player RECEIVED over all categories
// (ratings[cat][player][*]); a missing capture simply has no ratings => 0. Results ranking = players sorted by points desc.
// core exports the selectors; state holds only the raw ratings.

/** @typedef {{ playerId:string, profile:Profile, isHost:boolean, connected:boolean, ready:boolean, done:boolean }} Player
 *  Array order = join order, host first (stable; UI shows players in this order).
 *  ready: lobby flag (setReady). done: play flag (setDone). Both are reset by core on phase change (ready=false when entering
 *  lobby, done=false when entering play) and set false for a fresh joiner.
 *  connected: false while the peer is away. In 'lobby' a disconnected player is REMOVED (frees the seat); from 'play' on the
 *  player stays (connected:false) and may rejoin by playerId (HOST_INTENT.join with a known playerId flips connected back).
 *  "All players ready/done" means all CONNECTED players (and at least one). A player cannot rate or be waited for while away. */

/** @typedef {{ id:string, label:string }} Category   id: 'cat1'..'cat6' for the defaults, else the client-made makeId() */
/** @typedef {{ id:string, playerId:string, label:string, at:number }} Suggestion   a pending suggestion; accepted/rejected ones are removed */

/** @typedef {{ captureId:string, playerId:string, categoryId:string, at:number }} CaptureRef
 *  Reference only. captureId IS the imageId of the JPEG bytes (travels on MSG.imgData, section 6). `at` = host `now` when
 *  the intent was applied. The LAST capture of a player for a category replaces the previous ref (D10). */

/** @typedef {{ id:string, playerId:string, at:number, text:(string|null), imageId:(string|null) }} ChatMessage
 *  Text and/or a shared screen: text (<= CHAT_TEXT_MAX) is null for a bare "Share screen"; imageId (bytes via MSG.imgData, kind 'chat') is null for plain text. */

/** @typedef {{
 *   roomCode:string,                                  // 'GEO-7Q4K'; also the Trystero room id
 *   rev:number,                                       // 0 at creation
 *   phase:GamePhase,
 *   players:Player[],                                 // <= MAX_PLAYERS, host first, exactly one isHost
 *   settings:{ roundMinutes:number },                 // one of ROUND_TIMES_MIN, default DEFAULT_ROUND_MIN; editable only in lobby
 *   categories:Category[],                            // ordered; host-edited in lobby, host may append during play; frozen from review on
 *   suggestions:Suggestion[],                         // pending, oldest first; lobby only (cleared when the game starts)
 *   roundEndsAt:(number|null),                        // host-clock deadline of the round; set at start, null in lobby/review/results
 *   doneCountdownEndsAt:(number|null),                // host-clock deadline of the 60 s all-done countdown, null when not running
 *   captures:Object<string, Object<string, CaptureRef>>, // captures[categoryId][playerId]; missing key = not captured
 *   chat:ChatMessage[],                               // oldest first, <= CHAT_HISTORY_MAX
 *   reviewIndex:number,                               // index into categories of the category being reviewed (review phase), else 0
 *   ratings:Object<string, Object<string, Object<string, number>>>, // ratings[categoryId][targetPlayerId][raterPlayerId] = STARS_MIN..STARS_MAX; never a self-rating
 * }} GameState
 *
 * TIMERS / CLOCK SKEW. Deadlines are absolute HOST-clock ms. Clients never trust their own clock for them: every MSG.state
 * carries the host's `now` (StateMessage.now); the client stores offset = clockOffset(msg.now) at receipt and shows
 * msLeft(deadline, offset) = max(0, deadline - (Date.now() + offset)). Error = one-way latency (well under a second), fine for a
 * mm:ss readout. The UI re-renders the readout itself every ~250 ms (state is NOT re-sent for time passing); time-left readouts
 * use a mono font with tabular numerals (D7). Round end and countdown end are executed by the HOST (HOST_INTENT.tick), so
 * the host's timer always ends the round regardless of the done countdown.
 *
 * ROUND/DONE RULES the state encodes (I4 implements; written here so every reader agrees):
 *  - start (lobby -> play): roundEndsAt = now + roundMinutes*60_000; doneCountdownEndsAt = null; all done=false.
 *  - setDone changes a flag; if every connected player is done and doneCountdownEndsAt is null => doneCountdownEndsAt = now + DONE_COUNTDOWN_MS.
 *    If not everyone is done any more => doneCountdownEndsAt = null (cancel; a full 60 s restarts when all are done again).
 *  - host addCategory during play: new unfinished work, so core also clears every done flag and cancels the countdown.
 *  - tick: play and (now >= roundEndsAt or (doneCountdownEndsAt != null and now >= doneCountdownEndsAt)) => phase 'review', reviewIndex 0, both timers null.
 */

/** Builds the state of a brand-new room. THE one place the state shape is created; core starts from it.
 *  Phase 'lobby', rev 0, host the only player (connected, ready:false, done:false), DEFAULT_CATEGORIES seeded as 'cat1'..'cat6',
 *  settings.roundMinutes = DEFAULT_ROUND_MIN, everything else empty/null/0.
 *  @param {{ playerId:string, profile:Profile }} hostPlayer  profile is passed through sanitizeProfile()
 *  @param {string} [roomCode]  defaults to makeRoomCode() (the only impure thing here); pass one to stay deterministic
 *  @returns {GameState} */
export function createInitialState(hostPlayer, roomCode = makeRoomCode()) {
  return {
    roomCode,
    rev: 0,
    phase: PHASE.lobby,
    players: [{ playerId: hostPlayer.playerId, profile: sanitizeProfile(hostPlayer.profile), isHost: true, connected: true, ready: false, done: false }],
    settings: { roundMinutes: DEFAULT_ROUND_MIN },
    categories: DEFAULT_CATEGORIES.map((label, i) => ({ id: `cat${i + 1}`, label })),
    suggestions: [],
    roundEndsAt: null,
    doneCountdownEndsAt: null,
    captures: {},
    chat: [],
    reviewIndex: 0,
    ratings: {},
  };
}

// ===== 5. Wire: messages, transport, session =====
// Topology: Trystero is a full mesh with no host concept. Host-ness is app level: whoever CREATED the room (it called
// makeRoomCode) runs with isHost:true and announces it in `hello`. The room code is the Trystero room id. Joiners type it in.
// Host leaves => peers get SESSION_EVENT.hostGone and the game is over (UI returns to the start/profile screen). No host migration.

/** Wire messages. Trystero action name === type string (all <= 32 bytes; test asserts it). Payloads are JSON, except imgData.
 *  The net layer stamps `from` (sender playerId) on delivery from its own peerId->playerId table (built from `hello`);
 *  receivers NEVER read a playerId out of a payload for authority (ImageMeta.ownerId is informational, see section 6).
 *  type        dir                    cadence / when                       payload
 *  hello       any -> each peer       once per connection (on peer join)   { protocol:number, playerId, profile:Profile, isHost:boolean }
 *  reject      host -> one            answer to a refused join             { reason:'full'|'started'|'protocol' }
 *  intent      client -> host         user action                          { intent:Intent }          (host loops its own back to itself)
 *  state       host -> all(+self)     after EVERY applyIntent that changed state, and to a (re)joined peer alone
 *                                                                          StateMessage = { rev:number, now:number, state:GameState }  (FULL snapshots, no patches)
 *  imgData     any -> all | one       binary action: JPEG bytes + metadata   data: ArrayBuffer/Uint8Array of the JPEG, metadata: ImageMeta
 *  imgRequest  any -> one | all       ask for images we are missing        { imageIds:string[] }  (<= IMAGE_REQUEST_MAX_IDS)
 *  (WK's mgInput/mgProgress/mgFinal/mgState have no equivalent: there are no realtime minigames.)
 *  Session-internal `hb` heartbeat is NOT in MSG (the session adds it itself, as in WK).
 */
export const MSG = en('hello', 'reject', 'intent', 'state', 'imgData', 'imgRequest');
/** Session-level events (not on the wire). Same `session.on(name, handler)` as messages, so names never collide with MSG.
 *  peerJoin(PeerInfo) | peerLeave({playerId}) | hostGone({}) | hostBack({playerId}) | error({message}).
 *  hostBack fires when the session first learns (or relearns) the host's hello, so it also fires once on a normal join; in v1 the
 *  UI ignores hostBack for resume purposes and treats hostGone as game over. */
export const SESSION_EVENT = en('peerJoin', 'peerLeave', 'hostGone', 'hostBack', 'error');

/** @typedef {{ rev:number, now:number, state:GameState }} StateMessage   now = host Date.now() at send time (clock skew, see GameState) */
/** @typedef {{ playerId:string, profile:Profile, isHost:boolean, pingMs:(number|null) }} PeerInfo   WK's isBot is dropped */
/** @typedef {null|boolean|number|string|Json[]|{[k:string]:Json}} Json */

/** Low level link, one per transport (src/net/transports/{trystero,local}.js, each `createTransport(roomCode[, types])`).
 *  Same as WK EXCEPT binary support: `send` takes a 4th arg `metadata` and handlers get it as 3rd arg.
 *  Trystero: action.send(data, {target, metadata}) / action.onMessage = (data, {peerId, metadata}); binary arrives as ArrayBuffer and is
 *  chunked automatically (trystero@0.26.0). Local transport must carry (ArrayBuffer, metadata) through BroadcastChannel too.
 *  @typedef {{
 *    selfId:string,
 *    send(type:string, data:(Json|ArrayBuffer|Uint8Array), targetPeerId?:string, metadata?:Json): void,   // no target => all peers
 *    onMessage(type:string, handler:(data:any, peerId:string, metadata?:Json) => void): void,
 *    onPeerJoin(handler:(peerId:string) => void): void,
 *    onPeerLeave(handler:(peerId:string) => void): void,
 *    onError?(handler:(e:Error) => void): void,
 *    ping(peerId:string): Promise<number>,
 *    leave(): void,
 *  }} Transport */

/** Session = WK's Session with `gameId` renamed `roomCode` and `metadata` plumbed through. createSession returns synchronously.
 *  @typedef {{
 *    roomCode:string, transport:('trystero'|'local'), selfPlayerId:string, isHost:boolean,
 *    hostPlayerId(): (string|null),                                   // own id on the host; null while the host is absent
 *    peers(): PeerInfo[],                                             // other hello'd peers, not self
 *    sendIntent(intent:Intent): void,                                 // client -> host; on the host it loops back into its own on(MSG.intent) (from = selfPlayerId)
 *    send(type:string, data:any, toPlayerId:string, opts?:{ metadata?:Json }): void,
 *    sendToHost(type:string, data:any, opts?:{ metadata?:Json }): void,
 *    broadcast(type:string, data:any, opts?:{ self?:boolean, metadata?:Json }): void,   // all other peers; self:true also delivers to own handlers
 *    on(type:string, handler:(data:any, fromPlayerId:string, metadata?:Json) => void): () => void,   // MSG type or SESSION_EVENT name; returns unsubscribe
 *    ping(playerId:string): Promise<number>,
 *    leave(): void,
 *  }} Session
 *  @typedef {{ roomCode:string, transport:('trystero'|'local'), profile:Profile, playerId:string, isHost:boolean }} SessionOptions
 *  const createSession: (o:SessionOptions) => Session */

// ===== 6. Intents =====
// Intents travel client -> host as MSG.intent { intent }. The host NEVER trusts an actor in the payload: actor = the `from`
// playerId stamped by the net layer. Suggested core entry point (I4 owns the final signature and documents it):
//   applyIntent(state, actor:(playerId|SYSTEM), intent, now:number) -> { state, error:(ERR|null) }   // on error state is the unchanged input
// Every creating intent carries a client-made `id` = makeId() (idempotent: an id that already exists is ignored, not an error).

export const INTENT = en(
  'setProfile', 'setReady', 'suggestCategory', 'acceptSuggestion', 'rejectSuggestion',
  'addCategory', 'removeCategory', 'renameCategory', 'setRoundTime', 'startGame',
  'capture', 'setDone', 'chatText', 'chatImage',
  'rate', 'reviewNext', 'reviewPrev', 'showResults', 'reviewAgain', 'playAgain',
);

/** @typedef {(
 *   { type:'setProfile', profile:Profile }                                   // any player, lobby only (join itself happens via hello, not an intent); core sanitizes
 * | { type:'setReady', ready:boolean }                                       // any player incl. host, lobby only. SET not toggle: idempotent on a lossy mesh; the UI sends !current
 * | { type:'suggestCategory', id:string, label:string }                      // non-host player, lobby only; label trimmed, 1..CATEGORY_LABEL_MAX, <= MAX_SUGGESTIONS pending
 * | { type:'acceptSuggestion', suggestionId:string }                         // host, lobby: appends Category {id: suggestionId, label} and removes the suggestion
 * | { type:'rejectSuggestion', suggestionId:string }                         // host, lobby: removes the suggestion
 * | { type:'addCategory', id:string, label:string }                          // host, lobby OR play (mid-game add); <= MAX_CATEGORIES
 * | { type:'removeCategory', categoryId:string }                             // host, lobby only
 * | { type:'renameCategory', categoryId:string, label:string }               // host, lobby only
 * | { type:'setRoundTime', minutes:number }                                  // host, lobby only; must be in ROUND_TIMES_MIN
 * | { type:'startGame' }                                                     // host, lobby; needs >= MIN_PLAYERS connected, ALL connected players (host included) ready, >= 1 category. No countdown: phase becomes 'play' at once
 * | { type:'capture', captureId:string, categoryId:string }                  // any player, play only. The JPEG bytes were ALREADY broadcast as MSG.imgData with imageId === captureId. Replaces the player's earlier ref for that category (last capture counts)
 * | { type:'setDone', done:boolean }                                         // any player, play only (SET not toggle, like setReady)
 * | { type:'chatText', id:string, text:string }                              // any player, lobby/play/review/results; text trimmed, 1..CHAT_TEXT_MAX
 * | { type:'chatImage', id:string, imageId:string, text?:string }            // any player, "Share screen": bytes already broadcast as MSG.imgData (kind 'chat'); optional caption
 * | { type:'rate', categoryId:string, targetPlayerId:string, stars:number }  // review only; categoryId must be categories[reviewIndex]; rater = actor; target != actor; target must have a capture for that category; stars STARS_MIN..STARS_MAX; re-rating overwrites
 * | { type:'reviewNext' }                                                    // host, review: reviewIndex+1 (no-op/invalid past the last category)
 * | { type:'reviewPrev' }                                                    // host, review: reviewIndex-1 (invalid below 0)
 * | { type:'showResults' }                                                   // host, review (any index; the UI offers it on the last category): phase 'results'
 * | { type:'reviewAgain' }                                                   // host, results: back to phase 'review', reviewIndex 0, ratings kept (mockup "Review the captures again")
 * | { type:'playAgain' }                                                     // host, results: back to 'lobby' keeping players/categories/settings; clears captures, chat, ratings, suggestions, timers, reviewIndex, ready, done
 * )} PlayerIntent */

/** Host-internal intents (actor === SYSTEM; any other actor => ERR.forbidden). Sent by the host driver, never over the wire. */
export const SYSTEM = '$system';
export const HOST_INTENT = en('join', 'leave', 'tick');
/** @typedef {(
 *   { type:'join', playerId:string, profile:Profile }   // from a verified hello. Known playerId => connected:true again (profile refreshed only in lobby). Unknown + lobby + free seat => new Player (ready:false). Else ERR.full (lobby/room full) or ERR.started (unknown player after the lobby)
 * | { type:'leave', playerId:string }                    // peerLeave. Lobby: player removed. Later: connected:false (done/ready kept). May cancel the all-done countdown or complete it (core re-evaluates)
 * | { type:'tick' }                                      // time passes (every HOST_TICK_MS): executes round end / done-countdown end, see GameState
 * )} HostIntent */
/** @typedef {PlayerIntent|HostIntent} Intent */

// ===== 7. Image routing (D11) =====
// IMAGES ARE NEVER IN STATE. State carries refs only (CaptureRef.captureId, ChatMessage.imageId); the bytes are a separate
// binary action, keyed by imageId. Every peer keeps every image it receives in memory (Map<imageId, {blob/bytes, meta}>).
//
// WHO SENDS WHAT TO WHOM
//  1. Capture (category): the capturing player makes the JPEG (mapPanel.capture()), picks captureId = makeId(), keeps the bytes locally,
//     BROADCASTS them to ALL peers (session.broadcast(MSG.imgData, bytes, {metadata})) and THEN sends the host the small intent
//     {type:'capture', captureId, categoryId}. Host records the CaptureRef and snapshots it. Bytes may arrive before or after the
//     snapshot with the ref; the UI shows a placeholder until the bytes for a ref are present. Re-capture = new captureId, same flow;
//     the old bytes are simply orphaned (receivers may drop an image once no ref/chat message points at it).
//  2. Share screen (chat): same, with a new imageId, metadata kind 'chat', then intent {type:'chatImage', id, imageId, text?}.
//  3. Late joiner / rejoiner / missed transfer: after applying a snapshot, a peer computes the imageIds it references but does not hold
//     (all captures refs + chat imageIds) and sends MSG.imgRequest { imageIds } to the OWNER of each (CaptureRef.playerId / ChatMessage.playerId),
//     grouped per owner. If still missing after IMAGE_REQUEST_TIMEOUT_MS it sends the request to EVERYBODY (session.broadcast).
//     ANY peer that holds a requested image answers by sending MSG.imgData to the REQUESTER ONLY (session.send), same bytes, same metadata.
//     Ids nobody holds are silently ignored. Receiving the same imageId twice is harmless (idempotent).
//  4. Receivers validate: byteLength <= IMAGE_MAX_BYTES, metadata.mime === IMAGE_MIME, metadata.imageId is a string. A host-authority check is not
//     needed: bytes are only displayed through a ref that the host put in state.

/** @typedef {(
 *   { kind:'capture', imageId:string, ownerId:string, categoryId:string, at:number, mime:'image/jpeg', w?:number, h?:number }
 * | { kind:'chat', imageId:string, ownerId:string, at:number, mime:'image/jpeg', w?:number, h?:number }
 * )} ImageMeta
 *  Trystero binary-action metadata for MSG.imgData. imageId === CaptureRef.captureId for kind 'capture'. ownerId = the player who made the image
 *  (answers to an imgRequest are sent by other peers, so the stamped `from` is NOT the owner). `at` = sender's clock, informational only
 *  (the authoritative time is CaptureRef.at / ChatMessage.at). */

// ===== 8. Shared pure helpers =====

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // lowercase, no i l o 0 1
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // uppercase, no I L O 0 1
export const ROOM_CODE_PREFIX = 'GEO-';

function randomChars(alphabet, len) {
  const out = [];
  const limit = 256 - (256 % alphabet.length);   // rejection sampling: no modulo bias
  while (out.length < len) {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(len * 2));
    for (const x of b) if (x < limit && out.length < len) out.push(alphabet[x % alphabet.length]);
  }
  return out.join('');
}

/** Short random id (8 chars, lowercase unambiguous alphabet) for categories, suggestions, captures, images and chat messages. */
export function makeId() { return randomChars(ID_ALPHABET, 8); }

/** Room code = Trystero room id: 'GEO-' + 4 chars from 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' (no 0/O/1/I, also no L), e.g. 'GEO-7Q4K'. */
export function makeRoomCode() { return ROOM_CODE_PREFIX + randomChars(CODE_ALPHABET, 4); }

/** User input -> canonical room code, or null. Trims, uppercases, accepts a missing 'GEO-' prefix (also 'GEO7Q4K' / 'geo 7q4k').
 *  A code containing characters outside the alphabet (0, O, 1, I, L, ...) is invalid => null; ambiguous characters are NOT auto-corrected.
 *  @param {unknown} input @returns {(string|null)} */
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const m = /^(?:GEO[-_\s]?)?([ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4})$/.exec(input.trim().toUpperCase());
  return m ? ROOM_CODE_PREFIX + m[1] : null;
}

/** The default look: first color/head/face, empty name (the profile form must make the user type one). */
export function defaultProfile() {
  return { name: '', color: COLORS[0].id, head: HEADS[0].id, face: FACES[0].id };
}

/** Force anything (hello from the wire, localStorage, a form) into a valid Profile: name trimmed/clamped to NAME_MAX
 *  (empty => 'Player'), unknown or missing ids fall back to the first preset. Never throws. Host and core use it on every inbound profile.
 *  @param {unknown} p @returns {Profile} */
export function sanitizeProfile(p) {
  const o = p && typeof p === 'object' ? p : {};
  const pick = (list, v) => (list.some((x) => x.id === v) ? v : list[0].id);
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, NAME_MAX).trim() : '';
  return { name: name || 'Player', color: pick(COLORS, o.color), head: pick(HEADS, o.head), face: pick(FACES, o.face) };
}

/** Client clock offset to the host clock: offset = hostNow - localNow, measured when a StateMessage arrives. */
export const clockOffset = (hostNow, localNow = Date.now()) => hostNow - localNow;
/** Milliseconds left until a host-clock deadline, never negative. `deadline` null => null (timer not running). */
export function msLeft(deadline, offset, localNow = Date.now()) {
  return deadline == null ? null : Math.max(0, deadline - (localNow + offset));
}

// Identity storage (contracts section 3). Everything is sync, never throws, and works without localStorage (node, private windows).
// No host-resume / save storage in v1 (D12): only playerId + profile.
import { KEYS, sanitizeProfile } from '../contracts.js';

const memory = new Map();   // fallback so a page without usable storage keeps ONE playerId per pid for its lifetime

const read = (key) => { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } };
const write = (key, value) => { try { globalThis.localStorage?.setItem(key, value); } catch { /* quota / private mode: behave as "not stored" */ } };

/** crypto.randomUUID only exists in secure contexts; plain http needs the getRandomValues path. */
function uuid() {
  const c = globalThis.crypto;
  if (c.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** @param {string|null} [pid] storage namespace suffix (several players in one browser / tests)
 *  @returns {{ playerId:string, profile:(import('../contracts.js').Profile|null) }} profile is null when none is stored or it is corrupt */
export function loadIdentity(pid = null) {
  const key = KEYS.playerId(pid);
  let playerId = read(key);
  if (!playerId) {
    playerId = memory.get(key) ?? uuid();
    memory.set(key, playerId);
    write(key, playerId);
  }
  let profile = null;
  try {
    const p = JSON.parse(read(KEYS.profile(pid)));
    if (p && typeof p === 'object' && !Array.isArray(p)) profile = sanitizeProfile(p);
  } catch { /* nothing stored or corrupt */ }
  return { playerId, profile };
}

export function saveProfile(profile, pid = null) {
  try { write(KEYS.profile(pid), JSON.stringify(profile)); } catch { /* unserialisable: ignore */ }
}

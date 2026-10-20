// Shared helpers for the e2e specs. Everything runs against `vite preview` (see playwright.config.js).
//
// ?local uses BroadcastChannel, which does not cross browser contexts, so every local game lives in ONE context with one page per
// player, and each page gets its own ?pid= (otherwise all tabs would share one localStorage identity).
import { expect } from '@playwright/test';

/** Known-harmless console noise: Google Fonts are @imported by theme.css and may be unreachable in CI. */
const HARMLESS = [/Failed to load resource/i, /fonts\.googleapis/i, /fonts\.gstatic/i, /ERR_(INTERNET|NAME|CONNECTION|BLOCKED)/i];
function collectErrors(page, bucket, label) {
  const keep = (text) => !HARMLESS.some((re) => re.test(text));
  page.on('pageerror', (e) => { if (keep(e.message)) bucket.push(`${label} pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && keep(m.text())) bucket.push(`${label} console.error: ${m.text()}`); });
}

/** Opens a page in `context` on the Profile screen with its own identity. `errors` collects page errors for the final assertion. */
export async function openPlayer(context, errors, label, pid) {
  const page = await context.newPage();
  collectErrors(page, errors, label);
  await page.goto(`/?local&pid=${pid}`);
  await expect(page.locator('[data-screen=profile]')).toBeVisible();
  return page;
}

export async function fillName(page, name) {
  await page.locator('#pf-name').fill(name);
}

/** Host: type a name, Create room. Returns the room code shown in the lobby. */
export async function createRoom(page, name) {
  await fillName(page, name);
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.locator('[data-screen=lobby]')).toBeVisible();
  const code = (await page.locator('.invite code').textContent()).trim();
  expect(code).toMatch(/^GEO-[A-Z0-9]{4}$/);
  return code;
}

/** Client: type a name and the code, Join room (does not wait for the lobby). */
export async function joinRoom(page, name, code) {
  await fillName(page, name);
  await page.locator('#pf-code').fill(code);
  await page.getByRole('button', { name: 'Join room' }).click();
}

export const playerIdOf = (page) => page.evaluate(() => window.__gf.identity.playerId);
export const stateOf = (page) => page.evaluate(() => window.__gf.getState());

/** An <img> inside `locator` carries a blob: URL and has actually decoded (naturalWidth > 0): the bytes really arrived. */
export async function expectLoadedBlobImage(locator) {
  await expect(locator).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => locator.evaluate((img) => img.complete && img.naturalWidth > 0), { message: 'image decoded' }).toBe(true);
}

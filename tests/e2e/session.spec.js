import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, openPlayer } from './helpers.js';

// Edge flows of the session layer: unknown room, late joiner, host leaving.

test('connecting to a room nobody hosts waits, and Cancel returns to the profile', async ({ context }) => {
  const errors = [];
  const p = await openPlayer(context, errors, 'lonely', 'x1');
  await joinRoom(p, 'Lonely', 'GEO-2222');
  await expect(p.locator('[data-screen=connecting]')).toBeVisible();
  await expect(p.getByText('Connecting to GEO-2222')).toBeVisible();
  await p.getByRole('button', { name: 'Cancel' }).click();
  await expect(p.locator('[data-screen=profile]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a late joiner is rejected once the game started; when the host leaves the others get "Host left"', async ({ context }) => {
  const errors = [];
  const host = await openPlayer(context, errors, 'host', 'h');
  const c1 = await openPlayer(context, errors, 'c1', 'c1');
  const late = await openPlayer(context, errors, 'late', 'c2');

  const code = await createRoom(host, 'Hosty');
  await joinRoom(c1, 'Anna', code);
  await expect(c1.locator('[data-screen=lobby]')).toBeVisible();
  for (const p of [host, c1]) await p.getByRole('button', { name: /^Ready$/ }).click();
  await host.getByRole('button', { name: 'Start game' }).click();
  for (const p of [host, c1]) await expect(p.locator('[data-screen=play]')).toBeVisible();

  await joinRoom(late, 'Latecomer', code);
  await expect(late.locator('[data-screen=profile]')).toBeVisible();
  await expect(late.locator('[data-testid=notice]')).toHaveText('That game has already started.');
  await expect(host.locator('.minis .mini')).toHaveCount(2); // nobody was added

  // a player who dropped can come back to their seat: same pid => same playerId (rejoin)
  await c1.reload();
  await expect(c1.locator('[data-screen=profile]')).toBeVisible();
  await joinRoom(c1, 'Anna', code);
  await expect(c1.locator('[data-screen=play]')).toBeVisible();
  await expect(host.locator('.minis .mini')).toHaveCount(2);

  // the host closes the tab: v1 has no host resume, the client lands on the profile screen with a notice
  await host.close();
  await expect(c1.locator('[data-screen=profile]')).toBeVisible({ timeout: 20_000 });
  await expect(c1.locator('[data-testid=notice]')).toHaveText('Host left — game over.');
  expect(errors).toEqual([]);
});

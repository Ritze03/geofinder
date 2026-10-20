import { test, expect } from '@playwright/test';
import { createRoom, expectLoadedBlobImage, joinRoom, openPlayer, playerIdOf } from './helpers.js';

// The plan's acceptance criterion, one explicit assertion per clause: three players over ?local play a whole game.
const DONE_COUNTDOWN_MS = 60_000;

test('3 players play a full game: lobby gate, image transfer, done countdown, ratings = results', async ({ context }) => {
  const errors = [];
  const [host, c1, c2] = [
    await openPlayer(context, errors, 'host', 'h'),
    await openPlayer(context, errors, 'c1', 'c1'),
    await openPlayer(context, errors, 'c2', 'c2'),
  ];
  const pages = [host, c1, c2];
  const NAMES = ['Hosty', 'Anna', 'Ben'];

  // ---- 1. host creates, two join with the code shown in the lobby ----
  const code = await createRoom(host, NAMES[0]);
  await expect(host.locator('[data-testid=room-code]')).toHaveText(code); // header shows it too
  await joinRoom(c1, NAMES[1], code);
  await joinRoom(c2, NAMES[2], code);
  for (const p of pages) {
    await expect(p.locator('[data-screen=lobby]')).toBeVisible();
    await expect(p.locator('.invite code')).toHaveText(code);
    await expect(p.locator('[data-testid=player-count]')).toHaveText('3/8 players');
    await expect(p.locator('.pl li')).toHaveCount(3);
  }
  const [hid, id1, id2] = await Promise.all(pages.map(playerIdOf));
  expect(new Set([hid, id1, id2]).size).toBe(3);

  // a non-host's suggestion, accepted by the host, shows up in everybody's list
  await c1.getByLabel('Suggest a category').fill('a windmill');
  await c1.getByRole('button', { name: 'Suggest' }).click();
  await expect(host.locator('.sug li', { hasText: 'a windmill' })).toBeVisible();
  await host.getByRole('button', { name: 'Accept a windmill' }).click();
  for (const p of pages) {
    await expect(p.locator('.cats li', { hasText: 'a windmill' })).toBeVisible();
    await expect(p.locator('.cats li')).toHaveCount(7);
  }
  await expect(host.locator('.sug li.empty')).toBeVisible();

  // ---- 2. Start stays disabled until EVERYONE (host included) is ready: 0, 1, 2 of 3, then 3 of 3 ----
  const start = host.getByRole('button', { name: 'Start game' });
  const ready = (p) => p.getByRole('button', { name: /^(Not ready|Ready)$/ });
  await expect(start).toBeDisabled(); // 0/3
  await expect(host.locator('.ready-box .txt')).toContainText('0/3');
  await ready(c1).click();
  await expect(host.locator('.pl li', { hasText: NAMES[1] }).locator('.st')).toHaveClass(/on/);
  await expect(host.locator('.ready-box .txt')).toContainText('1/3');
  await expect(start).toBeDisabled(); // 1/3
  await ready(c2).click();
  await expect(host.locator('.ready-box .txt')).toContainText('2/3');
  await expect(start).toBeDisabled(); // 2/3: the host itself is the one missing
  await ready(host).click();
  await expect(start).toBeEnabled(); // 3/3
  for (const p of pages) await expect(p.locator('.pl .st.on')).toHaveCount(3);
  // un-readying one player locks it again, then back
  await ready(c2).click();
  await expect(start).toBeDisabled();
  await ready(c2).click();
  await expect(start).toBeEnabled();

  await start.click();
  for (const p of pages) await expect(p.locator('[data-screen=play]')).toBeVisible();
  for (const p of pages) await expect(p.locator('[data-stub-map]')).toHaveCount(1); // browser mode runs on the stub map

  // ---- 3. captures and a chat share arrive at the other players as decoded images ----
  const capture = async (p, catId) => {
    const row = p.locator(`li[data-id="${catId}"]`);
    await row.locator('.cap').click();
    await expect(row).toHaveClass(/done/); // the snapshot carries my new ref
    await expect(row.locator('.th img')).toHaveAttribute('src', /^blob:/);
  };
  await capture(host, 'cat1');
  await capture(c1, 'cat1');
  await capture(c2, 'cat1');
  await capture(host, 'cat2');
  await capture(c1, 'cat2'); // c2 deliberately skips cat2

  for (const [viewer, others] of [[host, [1, 2]], [c1, [0, 2]], [c2, [0, 1]]]) {
    const row = viewer.locator('li[data-id="cat1"]');
    await expect(row.locator('.oth button')).toHaveCount(2);
    for (const i of others) {
      // open the other player's capture in the lightbox: a blob: <img> that decoded
      await row.locator(`.oth button[title="${NAMES[i]}'s capture"]`).click();
      const modal = viewer.locator('.modal:not([hidden])');
      await expect(modal.locator('figure figcaption b').first()).toHaveText(NAMES[i]);
      await expectLoadedBlobImage(modal.locator('figure img').first());
      await modal.locator('[data-close]').click();
      await expect(viewer.locator('.modal:not([hidden])')).toHaveCount(0);
    }
  }
  // cat2: c2 sees host + c1 captures too, and cat2 has no c2 capture of its own
  await expect(c2.locator('li[data-id="cat2"] .oth button')).toHaveCount(2);
  await expect(c2.locator('li[data-id="cat2"]')).not.toHaveClass(/done/);

  // chat share ("Share screen") with a caption, then a bare one from c2
  await host.locator('.cin input').fill('look at this');
  await host.getByRole('button', { name: 'Share screen' }).click();
  for (const p of pages) {
    const msg = p.locator('.msgs .msg', { hasText: 'look at this' });
    await expect(msg).toHaveCount(1);
    await expectLoadedBlobImage(msg.locator('img'));
  }
  await c2.getByRole('button', { name: 'Share screen' }).click();
  for (const p of pages) {
    await expect(p.locator('.msgs .msg img')).toHaveCount(2);
    for (const img of await p.locator('.msgs .msg img').all()) await expectLoadedBlobImage(img);
  }
  // plain chat text still works next to it
  await c1.locator('.cin input').fill('nice one');
  await c1.getByRole('button', { name: 'Send' }).click();
  for (const p of pages) await expect(p.locator('.msgs .msg', { hasText: 'nice one' })).toHaveCount(1);

  // ---- 4. everyone done -> banner, the round ends only after the 60 s countdown ----
  const done = (p) => p.locator('.dbtn');
  const banner = (p) => p.locator('.dbanner');
  await done(host).click();
  await done(c1).click();
  for (const p of pages) await expect(banner(p)).toBeHidden(); // 2 of 3 done: no countdown yet
  await done(c2).click();
  for (const p of pages) await expect(banner(p)).toBeVisible();
  // the countdown can be cancelled by anyone stepping back, and restarts in full
  await done(c2).click();
  await expect(banner(host)).toBeHidden();
  await done(c2).click();
  const allDoneAt = Date.now();
  for (const p of pages) await expect(banner(p)).toBeVisible();

  await host.waitForTimeout(8_000);
  for (const p of pages) await expect(p.locator('[data-screen=play]')).toBeVisible(); // still playing well inside the countdown
  for (const p of pages) await expect(p.locator('[data-screen=review]')).toBeVisible({ timeout: DONE_COUNTDOWN_MS });
  const elapsed = Date.now() - allDoneAt;
  expect(elapsed, 'review began only after the ~60 s countdown').toBeGreaterThan(DONE_COUNTDOWN_MS - 5_000);
  expect(elapsed, 'and not much later than that').toBeLessThan(DONE_COUNTDOWN_MS + 10_000);

  // ---- 5. ratings -> results totals == stars received ----
  // [rater, target, stars] per category index (0 = cat1 ... ); only players with a capture can be rated
  const ids = [hid, id1, id2];
  const RATINGS = {
    0: [[0, 1, 5], [0, 2, 3], [1, 0, 4], [1, 2, 2], [2, 0, 1], [2, 1, 5]],
    1: [[0, 1, 4], [1, 0, 2], [2, 0, 5], [2, 1, 3]],
  };
  const expected = [0, 0, 0];
  for (const list of Object.values(RATINGS)) for (const [, target, stars] of list) expected[target] += stars;
  expect(expected).toEqual([12, 17, 5]);

  const rate = async (p, targetIdx, stars) => {
    const card = p.locator(`.rcard[data-pid="${ids[targetIdx]}"]`);
    await card.locator(`.stars button[aria-label="${stars} star${stars > 1 ? 's' : ''}"]`).click();
    await expect(card.locator('.rate small')).toHaveText(`${stars} of 5 stars`);
  };
  const CATS = 7;
  for (let ci = 0; ci < CATS; ci++) {
    for (const p of pages) await expect(p.locator('.rv-head .eyebrow')).toHaveText(`Category ${ci + 1} of ${CATS}`);
    if (ci === 0) {
      // the captures arrived as images on the review cards, too
      for (const p of pages) {
        await expect(p.locator('.rcard:not(.miss)')).toHaveCount(3);
        for (const img of await p.locator('.rcard img').all()) await expectLoadedBlobImage(img);
      }
    }
    if (ci === 1) await expect(c2.locator(`.rcard[data-pid="${id2}"]`)).toHaveClass(/miss/); // c2 skipped cat2
    for (const [rater, target, stars] of RATINGS[ci] ?? []) await rate(pages[rater], target, stars);
    if (ci < CATS - 1) await host.getByRole('button', { name: 'Next category →' }).click();
  }
  // only the host steps; the others have no controls
  await expect(c1.getByRole('button', { name: 'Show results' })).toHaveCount(0);
  await host.getByRole('button', { name: 'Show results' }).click();

  for (const p of pages) {
    await expect(p.locator('[data-screen=results]')).toBeVisible();
    for (let i = 0; i < 3; i++) {
      await expect(p.locator(`tbody tr[data-pid="${ids[i]}"] td.tot`)).toHaveText(new RegExp(`^${expected[i]}\\s*pts$`));
    }
    // ranking: Anna 17, Hosty 12, Ben 5
    await expect(p.locator('tbody tr').nth(0)).toHaveAttribute('data-pid', id1);
    await expect(p.locator('tbody tr').nth(1)).toHaveAttribute('data-pid', hid);
    await expect(p.locator('tbody tr').nth(2)).toHaveAttribute('data-pid', id2);
    await expect(p.locator(`.pod[data-pid="${id1}"] .blk .num`)).toHaveText('17');
  }
  await expect(c1.getByRole('button', { name: 'Play again' })).toBeHidden(); // host-only

  // ---- play again -> lobby with a clean slate ----
  await host.getByRole('button', { name: 'Play again' }).click();
  for (const p of pages) {
    await expect(p.locator('[data-screen=lobby]')).toBeVisible();
    await expect(p.locator('.pl .st.on')).toHaveCount(0);
  }

  expect(errors).toEqual([]);
});

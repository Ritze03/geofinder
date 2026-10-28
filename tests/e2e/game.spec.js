import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, openPlayer, playerIdOf, stateOf, urlOf } from './helpers.js';

// The plan's acceptance criterion, one explicit assertion per clause: three players over ?local play a whole game.
const DONE_COUNTDOWN_MS = 60_000;

test('3 players play a full game: lobby gate, links instead of screenshots, done countdown, ratings (bottom bar, doesn\'t fit) = results', async ({ context }) => {
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

  // ---- 3. captures are links: no peeking during play, own spot is restorable, chat links open a live viewer ----
  // Browser mode runs on the stub map: its "position" is a Google Maps URL ([data-url]) that moves with every click on it.
  const mapOf = (p) => p.locator('.play-s .map > .map-panel');
  const moveMap = async (p) => {
    const before = await urlOf(mapOf(p));
    await mapOf(p).locator('.map-view').click();
    await expect(mapOf(p)).not.toHaveAttribute('data-url', before);
  };
  /** move the map, then "Submit this spot" for catId; returns the url that was on the map at that moment */
  const submit = async (p, pid, catId) => {
    await moveMap(p);
    const url = await urlOf(mapOf(p));
    const row = p.locator(`li[data-id="${catId}"]`);
    await row.locator('.cap').click();
    await expect(row).toHaveClass(/done/); // the snapshot carries my ref
    await expect.poll(async () => (await stateOf(p)).captures[catId][pid].url, { message: 'my own capture carries exactly the submitted url' }).toBe(url);
    return url;
  };
  const submitted = { cat1: {}, cat2: {} }; // catId -> playerId -> url
  submitted.cat1[hid] = await submit(host, hid, 'cat1');
  submitted.cat1[id1] = await submit(c1, id1, 'cat1');
  submitted.cat1[id2] = await submit(c2, id2, 'cat1');
  submitted.cat2[hid] = await submit(host, hid, 'cat2');
  submitted.cat2[id1] = await submit(c1, id1, 'cat2'); // c2 deliberately skips cat2
  const allUrls = [...Object.values(submitted.cat1), ...Object.values(submitted.cat2)];
  expect(new Set(allUrls).size, 'every submission is a different spot').toBe(allUrls.length);

  // (a) NO PEEKING: while the game runs, a page holds no url of anybody else's capture, neither in its state nor on screen
  for (const [p, me] of [[host, hid], [c1, id1], [c2, id2]]) {
    await expect(p.locator('li[data-id="cat1"] .stat')).toContainText('3 of 3 found it'); // refs (counts) are public, urls are not
    const state = await stateOf(p);
    for (const [catId, byPlayer] of Object.entries(state.captures)) {
      for (const [pid, ref] of Object.entries(byPlayer)) {
        if (pid === me) expect(ref.url, `${catId}: my own url`).toBe(submitted[catId][me]);
        else expect(ref.url, `${catId}: ${pid}'s url as seen by ${me}`).toBeNull();
      }
    }
    const html = await p.evaluate(() => `${document.documentElement.outerHTML}\n${document.body.innerText}`);
    const json = JSON.stringify(state);
    for (const [catId, byPlayer] of Object.entries(submitted)) {
      for (const [pid, url] of Object.entries(byPlayer)) {
        if (pid === me) continue;
        expect(html.includes(url), `${catId}: ${pid}'s url is in ${me}'s DOM`).toBe(false);
        expect(json.includes(url), `${catId}: ${pid}'s url is in ${me}'s state`).toBe(false);
      }
    }
    // and nothing clickable that would open somebody else's submission
    await expect(p.locator('.play-s .oth, .modal:not([hidden]), .vw')).toHaveCount(0);
  }
  // cat2: c2 sees the count but has no capture of its own
  await expect(c2.locator('li[data-id="cat2"] .stat')).toContainText('2 of 3 found it');
  await expect(c2.locator('li[data-id="cat2"]')).not.toHaveClass(/done/);

  // "Go to my spot" puts the map back on my own submission
  await moveMap(host);
  expect(await urlOf(mapOf(host))).not.toBe(submitted.cat1[hid]);
  await host.locator('li[data-id="cat1"] .go').click();
  await expect(mapOf(host)).toHaveAttribute('data-url', submitted.cat1[hid]);

  // (c) CHAT LINK: "Share this spot" with a caption, then a bare one from c2; the 📍 chip opens a live viewer on the shared url
  const shared = {};
  await moveMap(host);
  shared.host = await urlOf(mapOf(host));
  await host.locator('.cin input').fill('look at this');
  await host.getByRole('button', { name: 'Share this spot' }).click();
  for (const p of pages) await expect(p.locator('.msgs .msg', { hasText: 'look at this' })).toHaveCount(1);
  await moveMap(c2);
  shared.c2 = await urlOf(mapOf(c2));
  await c2.getByRole('button', { name: 'Share this spot' }).click();
  for (const p of pages) await expect(p.locator('.msgs .msg .spot')).toHaveCount(2);
  expect(new Set([shared.host, shared.c2, ...allUrls]).size).toBe(allUrls.length + 2);
  for (const p of pages) {
    const links = (await stateOf(p)).chat.map((m) => m.url).filter(Boolean).sort();
    expect(links, 'chat links are never redacted').toEqual([shared.host, shared.c2].sort());
  }

  for (const [p, from, name] of [[c1, 'host', NAMES[0]], [c2, 'host', NAMES[0]], [host, 'c2', NAMES[2]], [c1, 'c2', NAMES[2]]]) {
    await p.locator('.msgs .msg', { hasText: name }).locator('.spot').click();
    const viewer = p.locator('.vw .map-panel');
    await expect(viewer).toHaveAttribute('data-url', shared[from]);
    await expect(p.locator('.vw .map-bar')).toHaveCount(0); // a viewer has no provider bar
    // look around in it, then "Back to shared spot" restores the link
    await viewer.locator('.map-view').click();
    await expect(viewer).not.toHaveAttribute('data-url', shared[from]);
    await p.locator('.vw [data-back]').click();
    await expect(viewer).toHaveAttribute('data-url', shared[from]);
    await p.locator('.vw [data-close]').click();
    await expect(p.locator('.vw')).toHaveCount(0);
  }
  // opening a link never touched my own map
  await expect(mapOf(host)).toHaveAttribute('data-url', shared.host);

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

  // ---- 5. ratings -> results totals == NORMALISED stars received (3 players); "Doesn't fit" = 0 points, not part of the rater's mean ----
  // [rater, target, stars] per category index (0 = cat1 ... ); only players with a capture can be rated. NOFIT = "Doesn't fit".
  const NOFIT = 'nofit';
  const ids = [hid, id1, id2];
  const RATINGS = {
    0: [[0, 1, 5], [0, 2, 3], [1, 0, 4], [1, 2, 2], [2, 0, 1], [2, 1, NOFIT]],
    1: [[0, 1, 4], [1, 0, 2], [2, 0, 5], [2, 1, 3]],
  };
  // each star rating counts as stars - (mean of all STARS that rater gave in the game) + 3, so every rater averages 3
  const given = [[], [], []];
  for (const list of Object.values(RATINGS)) for (const [rater, , stars] of list) if (stars !== NOFIT) given[rater].push(stars);
  const raterMean = given.map((l) => l.reduce((a, b) => a + b, 0) / l.length);   // 4, 8/3, 3 (Ben's no-fit is not in his mean)
  const expected = [0, 0, 0];
  for (const list of Object.values(RATINGS)) for (const [rater, target, stars] of list) expected[target] += stars === NOFIT ? 0 : stars - raterMean[rater] + 3;
  expect(expected.map((x) => Math.round(x * 10) / 10)).toEqual([12.7, 10, 4.3]);   // raw stars would have been 12 / 12 / 5
  const shown = ['12.7', '10', '4.3'];

  const card = (p, targetIdx) => p.locator(`.rcard[data-pid="${ids[targetIdx]}"]`);
  const barOf = (p) => p.locator('.rv-rate');
  const starLabel = (n) => `${n} star${n > 1 ? 's' : ''}`;
  /** rate with the small stars on the card */
  const rate = async (p, targetIdx, stars) => {
    await card(p, targetIdx).locator(`.stars button[aria-label="${starLabel(stars)}"]`).click();
    await expect(card(p, targetIdx).locator('.rate small')).toHaveText(`${stars} of 5 stars`);
  };
  /** select the card, then rate with the big stars in the bottom bar; the card stars stay in sync */
  const rateBar = async (p, targetIdx, stars) => {
    await card(p, targetIdx).locator('.pick').click();
    await expect(barOf(p).locator('.rb-name')).toHaveText(NAMES[targetIdx]);
    await barOf(p).locator(`.stars button[aria-label="${starLabel(stars)}"]`).click();
    await expect(barOf(p).locator('.rb-note')).toHaveText(`${stars} of 5 stars`);
    await expect(barOf(p).locator('.star.on')).toHaveCount(stars);
    await expect(card(p, targetIdx).locator('.rate small')).toHaveText(`${stars} of 5 stars`);
    await expect(card(p, targetIdx).locator('.star.on')).toHaveCount(stars);
  };
  /** "Doesn't fit" in the bottom bar: shown on the card and the bar, no star lit, counts as rated */
  const rateNoFit = async (p, targetIdx) => {
    await card(p, targetIdx).locator('.pick').click();
    await barOf(p).getByRole('button', { name: "Doesn't fit" }).click();
    await expect(barOf(p).getByRole('button', { name: "Doesn't fit" })).toHaveAttribute('aria-pressed', 'true');
    await expect(barOf(p).locator('.rb-note')).toHaveText("Doesn't fit · 0 points");
    await expect(barOf(p).locator('.star.on')).toHaveCount(0);
    await expect(card(p, targetIdx)).toHaveClass(/nofit/);
    await expect(card(p, targetIdx).locator('.rate small')).toHaveText("Doesn't fit · 0 points");
    await expect(card(p, targetIdx).locator('.star.on')).toHaveCount(0);
  };
  const CATS = 7;
  for (let ci = 0; ci < CATS; ci++) {
    for (const p of pages) await expect(p.locator('.rv-head .eyebrow')).toHaveText(`Category ${ci + 1} of ${CATS}`);
    const catId = `cat${ci + 1}`;
    const viewerOf = (p) => p.locator('.rv-vbody .map-panel');
    if (ci < 2) {
      // (b) REVIEW SHOWS THE SUBMITTED SPOT: every page holds every url now; selecting a card loads exactly that url in the live viewer
      const owners = Object.keys(submitted[catId]);
      for (const [pi, p] of pages.entries()) {
        await expect(p.locator('.rcard:not(.miss)')).toHaveCount(owners.length);
        const state = await stateOf(p);
        for (const pid of owners) expect(state.captures[catId][pid].url, `review state carries ${pid}'s url`).toBe(submitted[catId][pid]);
        // a new category auto-selects the first submission (join order: host first)
        await expect(viewerOf(p)).toHaveAttribute('data-url', submitted[catId][owners[0]]);
        await expect(viewerOf(p)).toBeVisible();
        await expect(p.locator('.rv-empty')).toBeHidden();
        await expect(p.locator('.rv-back')).toBeVisible();
        for (const pid of owners) {
          await p.locator(`.rcard[data-pid="${pid}"] .pick`).click();
          await expect(viewerOf(p)).toHaveAttribute('data-url', submitted[catId][pid]);
          // the big rating bar is for other people's captures only
          if (pid === ids[pi]) await expect(barOf(p), 'no rating bar on my own capture').toBeHidden();
          else {
            await expect(barOf(p)).toBeVisible();
            await expect(barOf(p).locator('.rb-name')).toHaveText(NAMES[ids.indexOf(pid)]);
            await expect(barOf(p).getByRole('button', { name: "Doesn't fit" })).toBeVisible();
          }
        }
        // wander off in the viewer, "Back to submitted spot" re-loads the selected submission
        const last = submitted[catId][owners.at(-1)];
        await viewerOf(p).locator('.map-view').click();
        await expect(viewerOf(p)).not.toHaveAttribute('data-url', last);
        await p.locator('.rv-back').click();
        await expect(viewerOf(p)).toHaveAttribute('data-url', last);
        await expect(p.locator('.rv-vbody .map-bar')).toHaveCount(0);
      }
    } else {
      // NOBODY submitted this one: the previous category's spot must not be visible anywhere, there is nothing to rate or to go back to
      for (const p of pages) {
        await expect(p.locator('.rv-empty')).toBeVisible();
        await expect(p.locator('.rv-empty')).toHaveText('Nobody submitted a spot for this one.');
        await expect(viewerOf(p), 'the viewer (still holding the previous spot) is hidden').toBeHidden();
        await expect(p.locator('.rv-back')).toBeHidden();
        await expect(barOf(p)).toBeHidden();
        await expect(p.locator('.rcard:not(.miss)')).toHaveCount(0);
      }
    }
    if (ci === 2) {
      // going back to a category with submissions brings the viewer back
      await host.getByRole('button', { name: '← Previous' }).click();
      for (const p of pages) {
        await expect(p.locator('.rv-head .eyebrow')).toHaveText(`Category 2 of ${CATS}`);
        await expect(viewerOf(p)).toBeVisible();
        await expect(viewerOf(p)).toHaveAttribute('data-url', submitted.cat2[hid]);
        await expect(p.locator('.rv-empty')).toBeHidden();
        await expect(p.locator('.rv-back')).toBeVisible();
      }
      await host.getByRole('button', { name: 'Next category →' }).click();
      for (const p of pages) await expect(p.locator('.rv-head .eyebrow')).toHaveText(`Category 3 of ${CATS}`);
      for (const p of pages) await expect(viewerOf(p)).toBeHidden();
    }
    if (ci === 1) {
      await expect(c2.locator(`.rcard[data-pid="${id2}"]`)).toHaveClass(/miss/); // c2 skipped cat2
      await expect(c2.locator(`.rcard[data-pid="${id2}"] .pick`)).toBeDisabled();
    }
    // the host sees how many players have rated everything (informative only; nothing is blocked)
    const progress = host.locator('.rv-side .row.all .big');
    const readyCount = (p) => p.locator('.rv-side .row.rdy .big');
    const readyBtn = (p) => p.locator('.rv-ready');
    if (ci < 2) await expect(progress).toHaveText(/^0\s*\/ 3 rated$/);
    for (const p of pages) {
      await expect(readyCount(p)).toHaveText(/^0\s*\/ 3 ready$/);
      await expect(readyBtn(p)).toBeEnabled();
    }
    // the Ready button hints at what the player has not rated yet (ci 0: everybody owes two ratings)
    if (ci === 0) await expect(readyBtn(c1)).toContainText('2 unrated');
    for (const [rater, target, stars] of RATINGS[ci] ?? []) {
      const p = pages[rater];
      if (stars === NOFIT) {
        // Ben first rates 5 stars with the card stars, then switches to "Doesn't fit" (re-rating overwrites); it counts as rated
        await rate(p, target, 5);
        await rateNoFit(p, target);
        await expect(p.locator('.rv-side .row:not(.all):not(.rdy) .big')).toHaveText(/^2\s*\/ 2 rated$/);
      } else if (ci === 1) await rateBar(p, target, stars);   // category 2 is rated with the big stars in the bottom bar
      else await rate(p, target, stars);
    }
    if (ci < 2) await expect(progress).toHaveText(/^3\s*\/ 3 rated$/);
    if (ci === 0) {
      // switching from "Doesn't fit" back to stars works (bar not pressed any more), and back again; the final answer stays no fit
      await rateBar(c2, 1, 2);
      await expect(card(c2, 1)).not.toHaveClass(/nofit/);
      await expect(barOf(c2).getByRole('button', { name: "Doesn't fit" })).toHaveAttribute('aria-pressed', 'false');
      await rateNoFit(c2, 1);
      await expect(progress).toHaveText(/^3\s*\/ 3 rated$/);
    }
    // only the host has the override controls
    await expect(c1.getByRole('button', { name: 'Next category →' })).toHaveCount(0);
    await expect(c1.getByRole('button', { name: 'Show results' })).toHaveCount(0);

    if (ci === 3) {
      // host override: Next moves on without anybody pressing Ready (and clears a half-way ready state)
      await readyBtn(c1).click();
      await expect(readyCount(host)).toHaveText(/^1\s*\/ 3 ready$/);
      await host.getByRole('button', { name: 'Next category →' }).click();
      continue;
    }
    // everybody presses Ready; only the LAST press moves on, and then at once (no countdown)
    await readyBtn(c1).click();
    await readyBtn(c2).click();
    for (const p of pages) await expect(readyCount(p)).toHaveText(/^2\s*\/ 3 ready$/);
    await expect(readyBtn(c1)).toHaveText(/✓ Ready/);
    await readyBtn(c2).click();   // un-ready works ...
    for (const p of pages) await expect(readyCount(p)).toHaveText(/^1\s*\/ 3 ready$/);
    await readyBtn(c2).click();
    await readyBtn(host).click();
    if (ci < CATS - 1) {
      for (const p of pages) await expect(p.locator('.rv-head .eyebrow')).toHaveText(`Category ${ci + 2} of ${CATS}`, { timeout: 1_500 });
    } else {
      for (const p of pages) await expect(p.locator('[data-screen=results]')).toBeVisible({ timeout: 1_500 });
    }
  }

  for (const p of pages) {
    await expect(p.locator('[data-screen=results]')).toBeVisible();
    for (let i = 0; i < 3; i++) {
      await expect(p.locator(`tbody tr[data-pid="${ids[i]}"] td.tot`)).toHaveText(new RegExp(`^${shown[i].replace('.', '\\.')}\\s*pts$`));
    }
    // ranking: Hosty 12.7, Anna 10, Ben 4.3
    await expect(p.locator('tbody tr').nth(0)).toHaveAttribute('data-pid', hid);
    await expect(p.locator('tbody tr').nth(1)).toHaveAttribute('data-pid', id1);
    await expect(p.locator('tbody tr').nth(2)).toHaveAttribute('data-pid', id2);
    await expect(p.locator(`.pod[data-pid="${hid}"] .blk .num`)).toHaveText('12.7');
    // Anna's category-1 cell: Hosty's 5 counted 4, Ben's "Doesn't fit" counted 0 and is called out
    await expect(p.locator(`tbody tr[data-pid="${id1}"] td`).nth(1)).toContainText("1× doesn't fit");
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

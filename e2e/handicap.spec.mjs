// Handicap tab on a 390 px phone with no window.claude: starting index, the calculated index after 3 rounds, counting
// scores, past scores added and removed, a round edited through Play and one deleted, and the round stats on Shots.
// Every expected number comes from the app's own computeHistory, bundled here from src/core/handicap.ts.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, eq, newPage, noHorizontalScroll, rancho, text } from './lib.mjs';

const KEY = 'golf-buddy:v1';
const SHOTS = process.env.REVIEW_DIR
  || '/tmp/claude-0/-home-user/24fc6364-1d94-5479-9217-f29e60caeeeb/scratchpad/review/T2.2';

async function loadEngine() {
  const out = await build({ entryPoints: [fileURLToPath(new URL('../src/core/handicap.ts', import.meta.url))],
    bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const fmtIndex = (n) => (n === null ? '–' : n < 0 ? `+${Math.abs(n).toFixed(1)}` : n.toFixed(1));

const tee = rancho.tees.find((t) => t.id === 'white-m');
/** A posted 18 at Rancho Solano, white tee: par plus `over[i]` on each hole, two putts, every fairway hit. */
function round(id, date, over) {
  return {
    id, date, courseId: rancho.id, teeId: tee.id,
    snapshot: { courseName: rancho.name, teeName: tee.name, rating: tee.rating, slope: tee.slope, par: tee.par,
      holes: rancho.holes.map((h) => ({ ...h })) },
    holesPlayed: '18', pcc: 0,
    scores: rancho.holes.map((h, i) => ({ hole: h.number, strokes: h.par + over[i % over.length], putts: 2,
      ...(h.par >= 4 ? { fairway: 'hit' } : {}) })),
    status: 'posted', courseHandicap: null, updatedAt: `${date}T18:00:00.000Z`,
  };
}

const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)).data, KEY);

export default async function ({ browser, baseURL }) {
  const { computeHistory } = await loadEngine();
  mkdirSync(SHOTS, { recursive: true });
  const { page, context, errors } = await newPage(browser, baseURL, { width: 390 });
  try {
    const expectIndex = async (when) => {
      const d = await stored(page);
      const h = computeHistory(Object.values(d.rounds), Object.values(d.imports), d.profile);
      if (!(await page.isVisible('#handicap-screen'))) await page.click('#tab-handicap');
      await page.waitForSelector('#handicap-screen');
      eq(await text(page, '#handicap-index'), fmtIndex(h.displayIndex), `${when}: index shown`);
      eq(await text(page, '#handicap-index-label'), h.indexSource === 'starting' ? 'Starting index' : 'Handicap Index', `${when}: label`);
      eq(await page.locator('#posted-rounds li[data-counting="true"]').count(), h.countingIds.length, `${when}: counting rows`);
      for (const id of h.countingIds) {
        eq(await page.locator(`#posted-rounds li[data-entry="${id}"]`).getAttribute('data-counting'), 'true', `${when}: ${id} marked`);
      }
      return h;
    };

    // 1. No scores: the starting index is set on the Handicap screen and shown, labelled.
    await page.click('#tab-handicap');
    eq(await text(page, '#handicap-index'), '–', 'no index yet');
    await page.fill('#profile-starting-index', '18.4');
    await page.click('#profile-save');
    await page.waitForSelector('#profile-saved');
    eq((await stored(page)).profile.startingIndex, 18.4, 'starting index saved in the profile');
    eq(await text(page, '#handicap-index-label'), 'Starting index', 'starting index label');
    eq(await text(page, '#handicap-index'), '18.4', 'starting index shown');
    assert(await page.isVisible('#unofficial-note'), 'unofficial-index note');
    await page.click('#how-calculated summary');
    const nine = await text(page, '#how-nine');
    assert(nine.includes('0.52 × your index + 1.2') && nine.includes('approximation'), `9-hole note: ${nine}`);

    // 2. Two rounds: still the starting index. Three: the calculated index, equal to computeHistory's.
    const seed = async (rounds) => {
      await page.evaluate(([k, rs]) => {
        const s = JSON.parse(localStorage.getItem(k));
        for (const r of rs) s.data.rounds[r.id] = r;
        localStorage.setItem(k, JSON.stringify(s));
      }, [KEY, rounds]);
      await page.reload();
      await page.waitForSelector('.app');
    };
    await seed([round('r-a', '2026-10-01', [1, 2, 1]), round('r-b', '2026-10-08', [1, 1, 0])]);
    let h = await expectIndex('two rounds');
    eq(h.indexSource, 'starting', 'two rounds: starting index');
    assert((await text(page, '#handicap-index-note')).includes('You have 2'), 'two rounds: note counts scores');
    await seed([round('r-c', '2026-10-15', [0, 1, 1, 2])]);
    h = await expectIndex('three rounds');
    eq(h.indexSource, 'calculated', 'three rounds: calculated');
    eq(h.countingIds.length, 1, 'three rounds: one counting score');

    // 3. Past scores: two added, they take part, one removed.
    for (const [date, diff, note] of [['2026-09-01', '9.8', 'Club medal'], ['2026-09-10', '30.1', '']]) {
      await page.click('#add-past-score');
      await page.fill('#past-date', date);
      await page.fill('#past-differential', diff);
      if (note) await page.fill('#past-note', note);
      await page.click('#past-save');
      await page.waitForSelector('#add-past-score');
    }
    const imps = Object.values((await stored(page)).imports);
    eq(imps.length, 2, 'two past scores stored');
    h = await expectIndex('with past scores');
    const low = imps.find((i) => i.differential === 9.8);
    assert(h.countingIds.includes(low.id), 'the 9.8 past score counts');
    await page.click(`#score-${low.id}`);
    await page.waitForSelector('#import-detail');
    eq(await text(page, '#import-differential'), '9.8', 'past score detail');
    await page.click('#import-delete');
    await page.click('#import-delete-yes');
    await page.waitForSelector('#handicap-screen');
    eq(Object.values((await stored(page)).imports).length, 1, 'past score removed');
    h = await expectIndex('after removing a past score');

    // A bad differential is refused in-page.
    await page.click('#add-past-score');
    await page.fill('#past-differential', 'abc');
    await page.click('#past-save');
    assert(await page.isVisible('#past-differential-error'), 'invalid differential message');
    await page.click('#past-cancel');

    // Screens for review: list and round detail, light.
    eq(await text(page, '#handicap-index-note'),
      `Your best differential of your 4 scores, ${h.entries.find((e) => e.counting).adjustedDifferential.toFixed(1)}, minus 1.0 (the adjustment for 4 scores).`,
      '4-score index wording');
    await page.evaluate(() => document.getElementById('main').scrollTo({ top: 0 }));
    assert(await page.isVisible('#index-trend'), 'trend sparkline from 2 calculated indexes');
    await page.screenshot({ path: `${SHOTS}/handicap-light.png`, fullPage: false });
    await page.locator('#posted-rounds').screenshot({ path: `${SHOTS}/handicap-list-light.png` });
    await noHorizontalScroll(page, 'handicap');

    // 4. Edit a round through Play: it leaves the index while open, and the edit is recalculated on posting.
    const before = h.displayIndex;
    await page.click('#score-r-b');
    await page.waitForSelector('#round-detail');
    eq(await text(page, '#detail-differential'), (h.entries.find((e) => e.id === 'r-b').differential).toFixed(1), 'detail differential');
    await page.screenshot({ path: `${SHOTS}/handicap-detail-light.png` });
    await page.evaluate(() => document.getElementById('main').scrollTo({ top: 99999 }));
    await page.screenshot({ path: `${SHOTS}/handicap-detail-actions-light.png` });
    await noHorizontalScroll(page, 'round detail');
    await page.click('#edit-round');
    await page.waitForSelector('#hole-screen');
    eq((await stored(page)).rounds['r-b'].status, 'active', 'reopened round is active');
    await page.click('#strip-hole-1');
    const par1 = rancho.holes[0].par;
    eq(await text(page, '#stroke-value b'), String(par1 + 1), 'hole 1 holds the saved bogey');
    await page.click('#stroke-minus');                   // bogey to par on hole 1
    await page.click('#open-scorecard');
    await page.waitForSelector('#finish-screen');
    await page.click('#post-round');
    await page.waitForSelector('#posted-view');
    await page.click('#posted-done');
    const edited = (await stored(page)).rounds['r-b'];
    eq(edited.status, 'posted', 'edited round posted again');
    eq(edited.scores[0].strokes, par1, 'edit saved');
    h = await expectIndex('after editing a round');
    assert(h.displayIndex < before, `the better score lowered the index (${before} -> ${h.displayIndex})`);

    // 5. Delete a round from its detail: everything is recalculated.
    await page.click('#score-r-a');
    await page.waitForSelector('#round-detail');
    await page.click('#detail-delete');
    await page.click('#detail-delete-yes');
    await page.waitForSelector('#handicap-screen');
    assert(!(await stored(page)).rounds['r-a'], 'round deleted');
    h = await expectIndex('after deleting a round');
    await page.reload();
    await page.waitForSelector('.app');
    await expectIndex('after reload');

    // 6. Shots: round stats from the posted rounds.
    await page.click('#tab-shots');
    await page.waitForSelector('#round-stats');
    eq(await text(page, '#stat-fairways'), '100%', 'every fairway hit');
    eq(await page.locator('#stats-rounds li').count(), 2, 'two posted rounds in stats');
    eq(await text(page, '#stat-putts'), '36.0', 'two putts a hole');
    await page.screenshot({ path: `${SHOTS}/shots-stats-light.png`, fullPage: false });
    await noHorizontalScroll(page, 'shots');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);

    // Dark screenshots of the same screens.
    const data = await page.evaluate((k) => localStorage.getItem(k), KEY);
    const dark = await newPage(browser, baseURL, { width: 390, dark: true });
    try {
      await dark.page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, data]);
      await dark.page.reload();
      await dark.page.waitForSelector('.app');
      await dark.page.click('#tab-handicap');
      await dark.page.screenshot({ path: `${SHOTS}/handicap-dark.png` });
      await dark.page.click('#how-calculated summary');
      await dark.page.evaluate(() => document.getElementById('main').scrollTo({ top: 99999 }));
      await dark.page.screenshot({ path: `${SHOTS}/handicap-bottom-dark.png` });
      await dark.page.click('#score-r-c');
      await dark.page.waitForSelector('#round-detail');
      await dark.page.screenshot({ path: `${SHOTS}/handicap-detail-dark.png` });
      await dark.page.click('#tab-shots');
      await dark.page.screenshot({ path: `${SHOTS}/shots-stats-dark.png` });
      eq(dark.errors.length, 0, `dark page errors: ${dark.errors.join(' | ')}`);
    } finally {
      await dark.context.close();
    }
  } finally {
    await context.close();
  }
}

// A full 18 at Rancho Solano on a 390 px phone with no window.claude: start, enter every hole, finish, post,
// and the posted round survives a reload (localStorage only).
import { assert, eq, newPage, rancho, setStrokes, startRound, tenth, text, whole } from './lib.mjs';

const fmtToPar = (n) => (n === 0 ? 'E' : n > 0 ? `+${n}` : `−${-n}`);
const fmtDiff = (n) => (n < 0 ? `−${Math.abs(n).toFixed(1)}` : n.toFixed(1));

export default async function ({ browser, baseURL }) {
  const { page, context, errors } = await newPage(browser, baseURL, { width: 390 });
  try {
    const hasClaude = await page.evaluate(() => 'claude' in window);
    assert(!hasClaude, 'window.claude should be absent in this spec');

    const tee = rancho.tees.find((t) => t.id === 'white-m');
    const index = 24.0;
    const ch = whole((index * tee.slope) / 113 + (tee.rating - tee.par));
    await startRound(page, { teeId: 'white-m', index });
    // Course handicap is stored on the round at the start.
    const stored = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('golf-buddy:v1')).data.rounds)[0]);
    eq(stored.courseHandicap, ch, 'course handicap at start');

    // One hole well over its maximum to exercise net double bogey.
    const scores = [6, 5, 3, 5, 3, 4, 6, 3, 5, 6, 4, 4, 5, 4, 10, 4, 5, 5];
    let total = 0, par = 0, ags = 0;
    for (let i = 0; i < 18; i++) {
      const h = rancho.holes[i];
      const received = Math.floor(ch / 18) + (h.strokeIndex <= ch % 18 ? 1 : 0);
      const max = h.par + 2 + received;
      eq(await text(page, '#hole-number'), String(h.number), `hole ${i + 1} number`);
      eq(await text(page, '#hole-par'), String(h.par), `hole ${h.number} par`);
      eq(await text(page, '#hole-yards'), String(tee.yardages[i]), `hole ${h.number} yards`);
      eq(await text(page, '#hole-si'), String(h.strokeIndex), `hole ${h.number} stroke index`);
      eq(await text(page, '#hole-max'), String(max), `hole ${h.number} maximum`);
      eq(await text(page, '#hole-received'), `${received} stroke${received > 1 ? 's' : ''} received`, `hole ${h.number} strokes received`);

      await setStrokes(page, scores[i], h.par);
      await page.click('#putts-2');
      if (h.par >= 4) await page.click('#fairway-hit');
      total += scores[i]; par += h.par; ags += Math.min(scores[i], max);
      eq(await text(page, '#running-total'), String(total), `running total after hole ${h.number}`);
      eq(await text(page, '#running-topar'), fmtToPar(total - par), `to par after hole ${h.number}`);
      if (scores[i] > max) assert(await page.isVisible('#stroke-capped'), `hole ${h.number}: capped note`);
      if (i < 17) await page.click('#hole-next');
    }
    // Changing a score updates the totals: hole 18 one more, then back.
    await page.click('#stroke-plus');
    eq(await text(page, '#running-total'), String(total + 1), 'total after a change');
    await page.click('#stroke-minus');
    eq(await text(page, '#running-total'), String(total), 'total after changing back');

    await page.click('#finish-round');
    await page.waitForSelector('#finish-screen');
    eq(await text(page, '#finish-gross'), String(total), 'finish gross');
    eq(await text(page, '#finish-ags'), String(ags), 'adjusted gross score');
    const diff = tenth((113 / tee.slope) * (ags - tee.rating));
    eq(await text(page, '#finish-differential'), fmtDiff(diff), 'differential');
    eq(await text(page, '#finish-index'), '24.0→24.0', 'index before and after (starting index, 1 score)');
    assert((await page.locator('.sc .mk-birdie').count()) >= 1, 'birdies are circled on the scorecard');
    assert((await page.locator('.sc .mk-double').count()) >= 1, 'double bogeys are boxed on the scorecard');

    await page.click('#post-round');
    await page.waitForSelector('#posted-view');
    eq(await text(page, '#posted-differential'), fmtDiff(diff), 'posted differential');
    await page.click('#posted-done');
    await page.waitForSelector('#start-round');

    const checkPosted = async (when) => {
      await page.click('#tab-handicap');
      const rows = page.locator('#posted-rounds li');
      eq(await rows.count(), 1, `${when}: posted rounds`);
      const row = (await rows.first().textContent()) ?? '';
      assert(row.includes('Posted') && row.includes(String(total)), `${when}: row shows Posted and ${total}: ${row}`);
      const status = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('golf-buddy:v1')).data.rounds)[0].status);
      eq(status, 'posted', `${when}: stored status`);
    };
    await checkPosted('after posting');
    await page.reload();
    await page.waitForSelector('#start-round');
    assert(await page.isVisible('#last-round'), 'last round shown on Play after reload');
    await checkPosted('after reload');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

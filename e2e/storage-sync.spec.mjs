// With a mocked claude.use('db') / ('user'): writes land under data/users/<id>/golf/rounds/<roundId>, and on
// load each document is merged by updatedAt (newer db copy wins, local-only documents are pushed).
import { assert, eq, newPage, startRound, text } from './lib.mjs';

const BASE = 'data/users/u-test/golf';

async function waitFor(page, fn, arg, what) {
  try { await page.waitForFunction(fn, arg, { timeout: 5000 }); } catch { throw new Error(`timed out waiting for ${what}`); }
}

const mockDb = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('__mockdb') || '{}'));

export default async function ({ browser, baseURL }) {
  const { page, context, errors } = await newPage(browser, baseURL, { mock: true });
  try {
    await waitFor(page, () => document.getElementById('sync-badge')?.textContent === 'Synced', null, 'Synced badge');

    // A score written on the course reaches db under the per-user path.
    await startRound(page, { teeId: 'white-m' });
    await page.click('#stroke-plus');                     // hole 1, par 5 -> 6
    const roundId = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('golf-buddy:v1')).data.rounds)[0]);
    const path = `${BASE}/rounds/${roundId}`;
    await waitFor(page, ([p]) => JSON.parse(localStorage.getItem('__mockdb') || '{}')[p]?.scores?.[0]?.strokes === 6,
      [path], `db document ${path}`);
    await waitFor(page, () => document.getElementById('sync-badge')?.textContent === 'Synced', null, 'Synced after write');
    const profilePath = `${BASE}/profile/main`;
    assert((await mockDb(page))[profilePath], 'profile written to db');

    // db holds a newer copy of the round (another device) plus a posted round this phone never saw;
    // this phone holds a round db lacks.
    await page.evaluate(([p, base]) => {
      const m = JSON.parse(localStorage.getItem('__mockdb'));
      const r = m[p];
      r.scores[0].strokes = 7;
      r.updatedAt = '2099-01-01T00:00:00.000Z';
      m[p] = r;
      m[`${base}/rounds/r-remote`] = { ...r, id: 'r-remote', status: 'posted', date: '2026-11-20',
        scores: r.scores.map((s) => ({ ...s, strokes: 5 })), updatedAt: '2026-11-20T18:00:00.000Z' };
      localStorage.setItem('__mockdb', JSON.stringify(m));
      const local = JSON.parse(localStorage.getItem('golf-buddy:v1'));
      local.data.rounds['r-local'] = { ...r, id: 'r-local', status: 'posted', date: '2026-11-10',
        scores: r.scores.map((s) => ({ ...s, strokes: 4 })), updatedAt: '2026-11-10T18:00:00.000Z' };
      localStorage.setItem('golf-buddy:v1', JSON.stringify(local));
    }, [path, BASE]);

    await page.reload();
    await page.waitForSelector('#hole-screen');
    await waitFor(page, () => document.getElementById('sync-badge')?.textContent === 'Synced', null, 'Synced after reload');
    eq(await text(page, '#strip-hole-1 span'), '7', 'newer db copy of the active round wins');
    const local = await page.evaluate(() => JSON.parse(localStorage.getItem('golf-buddy:v1')).data.rounds);
    assert(local['r-remote'], 'db-only round merged into local storage');
    const db = await mockDb(page);
    assert(db[`${BASE}/rounds/r-local`], 'local-only round pushed to db');
    eq(db[path].scores[0].strokes, 7, 'db keeps its newer copy');

    await page.click('#tab-handicap');
    eq(await page.locator('#posted-rounds li').count(), 2, 'both posted rounds listed');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

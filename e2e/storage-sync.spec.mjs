// With a mocked claude.use('db') / ('user'): writes land under data/users/<id>/golf/rounds/<roundId>, and on
// load each document is merged by updatedAt (newer db copy wins, local-only documents are pushed).
// Then two devices on one shared db: a view that missed updates never overwrites newer scores (per-hole merge),
// a deleted round stays deleted when the other device comes back, and an untouched starting-index field never
// writes to the profile.
import { assert, eq, newPage, rancho, sharedDb, startRound, text } from './lib.mjs';

const BASE = 'data/users/u-test/golf';

async function waitFor(page, fn, arg, what) {
  try { await page.waitForFunction(fn, arg, { timeout: 5000 }); } catch { throw new Error(`timed out waiting for ${what}`); }
}

const mockDb = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('__mockdb') || '{}'));

async function until(fn, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const strip = async (page, n) => text(page, `#strip-hole-${n} span`);

async function twoDevices({ browser, baseURL }) {
  const shared = sharedDb();
  const devA = await shared.device(browser, baseURL);
  const devB = await shared.device(browser, baseURL);
  try {
    const a = await devA.open();
    let b = await devB.open();
    for (const p of [a, b]) await waitFor(p, () => document.getElementById('sync-badge')?.textContent === 'Synced', null, 'Synced badge');

    // M1: B's start screen is open when A sets the starting index; B's field follows the profile, and tapping in
    // and out of it writes nothing.
    await a.fill('#starting-index', '14.2');
    await a.locator('#starting-index').blur();
    await until(() => shared.get(`${BASE}/profile/main`)?.startingIndex === 14.2, 'profile in db');
    await waitFor(b, () => document.getElementById('starting-index')?.value === '14.2', null, 'B field follows the profile');
    const profileStamp = shared.get(`${BASE}/profile/main`).updatedAt;
    await b.focus('#starting-index');
    await b.locator('#starting-index').blur();
    await new Promise((r) => setTimeout(r, 900));
    eq(shared.get(`${BASE}/profile/main`).updatedAt, profileStamp, 'untouched field wrote no profile');
    eq(shared.get(`${BASE}/profile/main`).startingIndex, 14.2, 'starting index kept');

    // H1: A plays holes 1-3, B hears them; B then misses updates while A enters holes 4-9; B enters hole 10.
    await startRound(a, { teeId: 'white-m' });
    const roundId = await a.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('golf-buddy:v1')).data.rounds)[0]);
    const path = `${BASE}/rounds/${roundId}`;
    const dbStrokes = () => (shared.get(path)?.scores ?? []).slice(0, 10).map((x) => x.strokes);
    for (let n = 1; n <= 3; n++) { await a.click('#stroke-value'); await a.click('#hole-next'); }
    await until(() => dbStrokes()[2] === rancho.holes[2].par, 'holes 1-3 in db');
    await b.waitForSelector('#hole-screen');
    await until(async () => (await strip(b, 3)) === String(rancho.holes[2].par), 'B shows hole 3');
    devB.pause();
    for (let n = 4; n <= 9; n++) { await a.click('#stroke-value'); await a.click('#hole-next'); }
    await until(() => dbStrokes()[8] === rancho.holes[8].par, 'holes 4-9 in db');
    eq(await strip(b, 9), '·', 'B is stale: it has not heard of hole 9');
    await b.click('#strip-hole-10');
    await b.click('#stroke-plus');                         // hole 10: par + 1
    const want = rancho.holes.slice(0, 10).map((h, i) => (i === 9 ? h.par + 1 : h.par));
    await until(() => dbStrokes()[9] === want[9], 'hole 10 in db');
    await devB.resume();
    await until(() => JSON.stringify(dbStrokes()) === JSON.stringify(want), 'all ten holes in db');
    for (const [name, p] of [['A', a], ['B', b]]) {
      await waitFor(p, () => document.getElementById('sync-badge')?.textContent === 'Synced', null, `${name} synced`);
      for (let n = 1; n <= 10; n++) eq(await strip(p, n), String(want[n - 1]), `${name} keeps hole ${n}`);
      const local = await p.evaluate((id) => JSON.parse(localStorage.getItem('golf-buddy:v1')).data.rounds[id], roundId);
      eq(JSON.stringify(local.scores.slice(0, 10).map((x) => x.strokes)), JSON.stringify(want), `${name} local storage keeps all ten`);
    }
    eq(JSON.stringify(dbStrokes()), JSON.stringify(want), 'db keeps all ten holes');

    // H2: B goes away holding the round; A deletes it; B comes back and the round stays deleted.
    await b.close();
    await a.click('#open-scorecard');
    await a.click('#delete-round');
    await a.click('#delete-round-yes');
    await until(() => shared.get(path)?.deleted === true, 'tombstone in db');
    b = await devB.open();
    await waitFor(b, () => document.getElementById('sync-badge')?.textContent === 'Synced', null, 'B synced again');
    await b.waitForSelector('#start-round');
    const bLocal = await b.evaluate((id) => JSON.parse(localStorage.getItem('golf-buddy:v1')).data.rounds[id] ?? null, roundId);
    eq(bLocal, null, 'B dropped its copy');
    await new Promise((r) => setTimeout(r, 900));
    assert(shared.get(path)?.deleted === true, 'round stays deleted in db');
    assert(await a.isVisible('#start-round'), 'A still has no round in progress');
    eq([...devA.errors, ...devB.errors].length, 0, `page errors: ${[...devA.errors, ...devB.errors].join(' | ')}`);
  } finally {
    await devA.context.close();
    await devB.context.close();
  }
}

export default async function ({ browser, baseURL }) {
  await oneDevice({ browser, baseURL });
  await twoDevices({ browser, baseURL });
}

async function oneDevice({ browser, baseURL }) {
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
      r.scores[0] = { ...r.scores[0], strokes: 7, updatedAt: '2099-01-01T00:00:00.000Z' };
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

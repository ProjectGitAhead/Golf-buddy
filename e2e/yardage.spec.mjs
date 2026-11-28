// T6.1: live yardage on the hole screen of the hosted copy (dist/site/ under /Golf-buddy/). Geolocation is mocked
// by Playwright, and the OpenStreetMap Overpass servers by routing (the hand-built fixture in src/core/greens.fixture.json
// stands in for their answer). 390 px phone, light and dark. Expected yards are worked out here independently of the app.
import { mkdirSync, readFileSync } from 'node:fs';
import { assert, eq, noHorizontalScroll, startRound, text } from './lib.mjs';

const KEY = 'golf-buddy:v1';
const SHOTS = process.env.REVIEW_DIR
  || '/tmp/claude-0/-home-user/24fc6364-1d94-5479-9217-f29e60caeeeb/scratchpad/review/T6.1';
const FIXTURE = readFileSync(new URL('../src/core/greens.fixture.json', import.meta.url), 'utf8');
const ELEMENTS = JSON.parse(FIXTURE).elements;
const MAIN = 'https://overpass-api.de/api/interpreter';
const SPARE = 'https://overpass.kumi.systems/api/interpreter';
const TEE1 = { latitude: 38.26, longitude: -122.03 };

// ----- independent expectations ---------------------------------------------------------------------------------
const M_PER_DEG = 6_371_008.8 * Math.PI / 180;
const xy = (o, p) => ({ x: (p.lon - o.lon) * M_PER_DEG * Math.cos(o.lat * Math.PI / 180), y: (p.lat - o.lat) * M_PER_DEG });
const toYd = (m) => m / 0.9144;
/** The fixture's own hole line for hole n on the main course (west of -122.02), and its green ring. */
function fixtureGreen(n) {
  const line = ELEMENTS.find((e) => e.tags?.golf === 'hole' && Number(e.tags.ref) === n && e.geometry[0].lon < -122.02);
  const end = line.geometry[line.geometry.length - 1];
  const rings = ELEMENTS.filter((e) => e.tags?.golf === 'green').map((e) => e.geometry
    ?? [...e.members[0].geometry, ...e.members[1].geometry.slice().reverse().slice(1)]);
  const mid = (r) => ({ lat: r.reduce((s, p) => s + p.lat, 0) / r.length, lon: r.reduce((s, p) => s + p.lon, 0) / r.length });
  const ring = rings.reduce((a, b) => (Math.hypot(...Object.values(xy(end, mid(b)))) < Math.hypot(...Object.values(xy(end, mid(a)))) ? b : a));
  return ring.slice(0, -1);
}
/** Centre (area centroid), front (nearest point of the outline) and back (farthest point), in yards. */
function expected(player, ring) {
  const o = { lat: player.latitude, lon: player.longitude };
  const p = ring.map((q) => xy(o, q));
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const f = p[j].x * p[i].y - p[i].x * p[j].y; a += f; cx += (p[j].x + p[i].x) * f; cy += (p[j].y + p[i].y) * f;
  }
  const c = { x: cx / (3 * a), y: cy / (3 * a) };
  let near = Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const A = p[j], B = p[i], dx = B.x - A.x, dy = B.y - A.y;
    const t = Math.max(0, Math.min(1, (-A.x * dx - A.y * dy) / (dx * dx + dy * dy)));
    near = Math.min(near, Math.hypot(A.x + t * dx, A.y + t * dy));
  }
  return { centre: toYd(Math.hypot(c.x, c.y)), front: toYd(near), back: toYd(Math.max(...p.map((q) => Math.hypot(q.x, q.y)))) };
}
/** A point part of the way from the first tee towards a green's middle. */
function along(from, ring, frac) {
  const m = { lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length, lon: ring.reduce((s, p) => s + p.lon, 0) / ring.length };
  return { latitude: from.latitude + (m.lat - from.latitude) * frac, longitude: from.longitude + (m.lon - from.longitude) * frac };
}
async function near(page, sel, want, what) {
  const got = Number(await text(page, sel));
  assert(Math.abs(got - want) <= 1, `${what}: shows ${got}, expected ${want.toFixed(1)} (within 1 yd)`);
}

// ----- the phone ----------------------------------------------------------------------------------------------------

/** Counts geolocation calls (and the most watches ever running at once) and wake locks, before any page script. */
function spies() {
  const g = navigator.geolocation;
  window.__geo = { get: 0, watch: 0, clear: 0, active: 0, maxActive: 0 };
  const live = new Set();
  const { getCurrentPosition, watchPosition, clearWatch } = g;
  g.getCurrentPosition = function (...a) { window.__geo.get++; return getCurrentPosition.apply(g, a); };
  g.watchPosition = function (...a) {
    window.__geo.watch++;
    const id = watchPosition.apply(g, a);
    live.add(id); window.__geo.active = live.size; window.__geo.maxActive = Math.max(window.__geo.maxActive, live.size);
    return id;
  };
  g.clearWatch = function (id) { window.__geo.clear++; live.delete(id); window.__geo.active = live.size; return clearWatch.call(g, id); };
  window.__wake = { requests: 0, releases: 0 };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
    request: async () => { window.__wake.requests++; return { release: async () => { window.__wake.releases++; } }; },
  } });
}

async function phone(browser, baseURL, { dark = false, geo = TEE1, acc = 4, serviceWorkers = 'block', granted = true } = {}) {
  const origin = baseURL.replace('127.0.0.1', 'localhost');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
    colorScheme: dark ? 'dark' : 'light', serviceWorkers, geolocation: { ...geo, accuracy: acc },
    permissions: granted ? ['geolocation'] : [] });
  await context.addInitScript(spies);
  const calls = { main: 0, spare: 0, bodies: [], other: [] };
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) calls.other.push(r.url()); });
  const url = `${origin}/Golf-buddy/`;
  await page.goto(url);
  await page.waitForSelector('.app');
  return { page, context, errors, calls, url, origin };
}

/** Answers for the two servers: 'ok' (the fixture), 'empty' (nothing mapped), 'abort' (no connection) or a status. */
async function servers(context, calls, main, spare = 'ok') {
  const answer = (which, how) => async (route) => {
    calls[which]++;
    calls.bodies.push(route.request().postData() ?? '');
    calls.other = calls.other.filter((u) => u !== route.request().url());
    if (how === 'abort') return route.abort('connectionfailed');
    const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
    if (typeof how === 'number') return route.fulfill({ status: how, headers, body: 'busy' });
    return route.fulfill({ status: 200, headers, body: how === 'empty' ? '{"elements":[]}' : FIXTURE });
  };
  await context.route(MAIN, answer('main', main));
  await context.route(SPARE, answer('spare', spare));
}

const geoCount = (page) => page.evaluate(() => window.__geo);
const shot = (page, name, dark) => page.screenshot({ path: `${SHOTS}/yardage-${name}-${dark ? 'dark' : 'light'}.png` });
const stored = (page, n) => page.evaluate(([k, h]) => {
  const d = JSON.parse(localStorage.getItem(k)).data;
  const r = Object.values(d.rounds).find((x) => x.status === 'active');
  const c = d.courses['rancho-solano']?.holes.find((x) => x.number === h);
  return { green: c?.green ?? null, shape: c?.greenShape ?? null, par: c?.par, si: c?.strokeIndex,
    snapshot: r.snapshot.holes.find((x) => x.number === h) };
}, [KEY, n]);
async function hidePage(page, hidden) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

// ----- flows ----------------------------------------------------------------------------------------------------------

async function live(browser, baseURL, dark) {
  const { page, context, errors, calls } = await phone(browser, baseURL, { dark });
  try {
    await servers(context, calls, 'ok');
    await startRound(page, {});
    // Off until a tap: no location, no network.
    await page.waitForSelector('#yardage[data-state="off"]');
    eq(await text(page, '#yardage-on'), 'Turn on live yardage', 'turn-on button');
    let g = await geoCount(page);
    eq(g.watch + g.get, 0, 'no geolocation call before the tap');
    eq(calls.main + calls.spare + calls.other.length, 0, `no network call before the tap (${calls.other.join(' ')})`);
    await stepperVisible(page, 'off');
    await shot(page, 'off', dark);

    await page.click('#yardage-on');
    await page.waitForSelector('#yardage[data-state="no-green"]');
    eq(await text(page, '#yardage-no-green'), 'No green position for hole 1', 'no-green line');
    eq(await text(page, '#yardage-privacy'),
      "Loading sends this course's rough location to OpenStreetMap. Nothing else leaves your phone.", 'privacy hint');
    assert(await page.isVisible('#yardage-save-pin'), "I'm at the pin offered");
    eq(calls.main + calls.spare, 0, 'no network call before Load');
    await stepperVisible(page, 'no green');
    await shot(page, 'no-green', dark);

    await page.click('#yardage-load');
    await page.waitForSelector('#yardage-found');
    eq(await text(page, '#yardage-found-line'), 'Found 18 of 18 greens', 'found line');
    eq(await page.locator('#yardage-missing').count(), 0, 'nothing missing');
    eq(calls.main, 1, 'one request to the first server');
    eq(calls.spare, 0, 'second server not needed');
    const body = decodeURIComponent(calls.bodies[0].replace(/^data=/, ''));
    assert(body.includes('way["golf"="green"](around:1500,38.260,-122.030)') && body.includes('way["golf"="hole"]')
      && body.includes('relation["golf"="green"]') && body.endsWith('out tags geom;'), `query: ${body}`);
    await shot(page, 'found', dark);
    // Nothing saved until he says so.
    eq((await stored(page, 1)).green, null, 'not saved before Save');
    await page.click('#yardage-save-greens');
    await page.waitForSelector('#yardage[data-state="live"]');
    const s1 = await stored(page, 1);
    assert(s1.green && s1.shape.length >= 3 && s1.shape.length <= 40, 'green and outline saved on the course');
    eq(s1.par, 5, "the course's own par kept (the map says 9)");
    eq(s1.si, 3, "the course's own stroke index kept");
    eq(s1.snapshot.green, undefined, "the round's snapshot untouched");

    // At the first tee.
    const ring1 = fixtureGreen(1);
    let want = expected(TEE1, ring1);
    await near(page, '#yardage-centre', want.centre, 'centre from the tee');
    await near(page, '#yardage-front', want.front, 'front from the tee');
    await near(page, '#yardage-back', want.back, 'back from the tee');
    eq(await text(page, '#yardage-acc'), '± 4 yd', 'accuracy');
    assert((await text(page, '#yardage-osm')).includes('Green positions © OpenStreetMap contributors'), 'attribution shown');
    eq(await page.getAttribute('#yardage-osm a', 'href'), 'https://www.openstreetmap.org/copyright', 'attribution link');

    // Walk down the fairway: the numbers follow, and nothing else on the hole screen changes.
    await page.evaluate(() => {
      window.__mut = 0;
      const panel = document.getElementById('yardage');
      new MutationObserver((list) => { for (const m of list) if (!panel.contains(m.target)) window.__mut++; })
        .observe(document.getElementById('hole-screen'), { subtree: true, childList: true, characterData: true, attributes: true });
    });
    const P = along(TEE1, ring1, 0.7);
    await context.setGeolocation({ ...P, accuracy: 6 });
    want = expected(P, ring1);
    await page.waitForFunction((w) => Math.abs(Number(document.querySelector('#yardage-centre')?.textContent) - w) <= 1,
      want.centre, { timeout: 4000 });
    await near(page, '#yardage-front', want.front, 'front after moving');
    await near(page, '#yardage-back', want.back, 'back after moving');
    eq(await page.evaluate(() => window.__mut), 0, 'a new position re-renders only the yardage panel');
    await stepperVisible(page, 'live');
    await noHorizontalScroll(page, 'live yardage');
    await shot(page, 'live', dark);

    // Next hole shows that hole's green.
    await page.click('#hole-next');
    await page.waitForSelector('#hole-screen[data-hole="2"]');
    want = expected(P, fixtureGreen(2));
    await near(page, '#yardage-centre', want.centre, 'hole 2 centre');
    await near(page, '#yardage-front', want.front, 'hole 2 front');
    await near(page, '#yardage-back', want.back, 'hole 2 back');

    // Weak signal: numbers dimmed, said plainly.
    await context.setGeolocation({ ...P, accuracy: 40 });
    await page.waitForSelector('#yardage[data-weak="true"]');
    eq(await text(page, '#yardage-weak'), 'Weak GPS signal', 'weak line');
    eq(await text(page, '#yardage-acc'), '± 44 yd', 'weak accuracy');
    await shot(page, 'weak', dark);

    // Far from the hole.
    await context.setGeolocation({ latitude: 38.30, longitude: -122.03, accuracy: 5 });
    await page.waitForSelector('#yardage[data-state="far"]');
    eq(await text(page, '#yardage-far'), 'You are not near this hole', 'far line');
    await context.setGeolocation({ ...P, accuracy: 5 });
    await page.waitForSelector('#yardage[data-state="live"]');

    // One watcher, shared with the Distance sheet; paused while the page is hidden.
    g = await geoCount(page);
    eq(g.watch, 1, 'one watch so far');
    await page.click('#distance-open');
    await page.waitForSelector('#gps-panel');
    await page.waitForSelector('#gps-acc');
    eq(await text(page, '#gps-acc'), 'Your location: ± 5 yd. Live yardage keeps location on while you play.', 'sheet shares the fix');
    await page.click('#distance-close');
    g = await geoCount(page);
    eq(g.watch, 1, 'the sheet started no watch of its own');
    eq(g.active, 1, 'closing the sheet leaves yardage running');
    await hidePage(page, true);
    g = await geoCount(page);
    eq(g.active, 0, 'paused while hidden');
    await hidePage(page, false);
    await page.waitForSelector('#yardage[data-state="live"]');
    g = await geoCount(page);
    eq(g.active, 1, 'resumed when shown');
    eq(g.maxActive, 1, 'never more than one watch');
    eq(g.get, 0, 'no one-off position calls');
    const w = await page.evaluate(() => window.__wake);
    assert(w.requests >= 1 && w.releases >= 1, `wake lock held while live and released when paused (${JSON.stringify(w)})`);

    // Turn off: watch stops.
    await page.click('#yardage-off');
    await page.waitForSelector('#yardage[data-state="off"]');
    eq((await geoCount(page)).active, 0, 'turned off');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

/** The stroke stepper stays on screen above the sticky Next hole bar. */
async function stepperVisible(page, where) {
  const r = await page.evaluate(() => {
    const s = document.querySelector('.stepper').getBoundingClientRect();
    const nav = document.querySelector('.hole-nav').getBoundingClientRect();
    return { bottom: s.bottom, navTop: nav.top };
  });
  assert(r.bottom <= r.navTop, `${where}: stroke stepper pushed below the fold (${Math.round(r.bottom)} > ${Math.round(r.navTop)})`);
}

async function failover(browser, baseURL) {
  // First server down: the second answers, each asked once.
  let { page, context, errors, calls } = await phone(browser, baseURL);
  try {
    await servers(context, calls, 'abort', 'ok');
    await startRound(page, {});
    await page.click('#yardage-on');
    await page.click('#yardage-load');
    await page.waitForSelector('#yardage-found');
    eq(await text(page, '#yardage-found-line'), 'Found 18 of 18 greens', 'found via the second server');
    eq(`${calls.main},${calls.spare}`, '1,1', 'one request to each server');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally { await context.close(); }

  // Both down: one plain line, no more tries.
  ({ page, context, errors, calls } = await phone(browser, baseURL));
  try {
    await servers(context, calls, 'abort', 504);
    await startRound(page, {});
    await page.click('#yardage-on');
    await page.click('#yardage-load');
    await page.waitForSelector('#yardage-load-failed');
    eq(await text(page, '#yardage-load-failed'), "Couldn't load green positions. Check your signal and try again.", 'failed line');
    await page.waitForTimeout(500);
    eq(`${calls.main},${calls.spare}`, '1,1', 'each server asked once, then it stops');
    assert(await page.isVisible('#yardage-save-pin'), 'learn-as-you-play still offered');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally { await context.close(); }
}

async function unmapped(browser, baseURL) {
  const { page, context, errors, calls } = await phone(browser, baseURL);
  try {
    await servers(context, calls, 'empty');
    await startRound(page, {});
    await page.click('#yardage-on');
    await page.click('#yardage-load');
    await page.waitForSelector('#yardage-unmapped');
    eq(await text(page, '#yardage-unmapped'),
      'This course is not mapped in OpenStreetMap yet. Stand at each pin once and save it.', 'unmapped line');
    // Learn as you play: stand at the pin and save it; the centre shows, with no front or back.
    await page.click('#yardage-save-pin');
    await page.waitForSelector('#yardage[data-state="live"]');
    eq(await text(page, '#yardage-centre'), '0', 'at the pin');
    eq(await page.locator('#yardage-front, #yardage-back, #yardage-osm').count(), 0, 'centre only, no attribution');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally { await context.close(); }
}

async function handSavedKept(browser, baseURL) {
  // The service worker is left on here: it must let the lookup through to the network (and Playwright's routing).
  const { page, context, errors, calls } = await phone(browser, baseURL, { serviceWorkers: 'allow' });
  try {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10_000 });
    await servers(context, calls, 'ok');
    await startRound(page, {});
    await page.click('#yardage-on');
    await page.waitForSelector('#yardage-save-pin');
    await page.click('#yardage-save-pin');              // his own pin for hole 1, at the first tee
    await page.waitForSelector('#yardage[data-state="live"]');
    eq(await text(page, '#yardage-centre'), '0', 'his own pin');
    await page.click('#hole-next');
    await page.waitForSelector('#yardage-load');
    await page.click('#yardage-load');
    await page.waitForSelector('#yardage-found');
    eq(calls.main, 1, 'the lookup passed the service worker');
    eq(await text(page, '#yardage-found-line'), 'Found 18 of 18 greens', 'found');
    eq(await text(page, '#yardage-mine'), 'You saved hole 1 yourself. Those stay as they are unless you replace them.', 'kept line');
    assert(await page.isVisible('#yardage-replace-mine'), 'Replace mine offered');
    await page.click('#yardage-save-greens');
    await page.waitForSelector('#yardage[data-state="live"]');
    const h1 = await stored(page, 1), h2 = await stored(page, 2);
    eq(JSON.stringify(h1.green), JSON.stringify({ lat: TEE1.latitude, lon: TEE1.longitude }), 'hand-saved green kept');
    eq(h1.shape, null, 'no outline on the hand-saved green');
    assert(h2.shape && h2.green, 'hole 2 from the map');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);

    // A later visit: it was on and location is granted, so it resumes without a tap and without a new lookup.
    await page.reload();
    await page.waitForSelector('#yardage[data-state="live"]', { timeout: 8000 });
    eq((await geoCount(page)).watch, 1, 'resumed by itself on a later visit');
    eq(calls.main + calls.spare, 1, 'no new lookup');
  } finally { await context.close(); }
}

async function laterVisitNotGranted(browser, baseURL) {
  // Live yardage was on, but the browser would ask again: nothing starts until a tap.
  const { page, context, errors } = await phone(browser, baseURL, { granted: false });
  try {
    await page.evaluate(() => localStorage.setItem('golf-buddy:live-yardage', '1'));
    await startRound(page, {});
    await page.reload();
    await page.waitForSelector('#yardage[data-state="off"]');
    await page.waitForTimeout(500);
    const g = await geoCount(page);
    eq(g.watch + g.get, 0, 'no geolocation call without a tap when permission is not granted');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally { await context.close(); }
}

async function refused(browser, baseURL) {
  const { page, context, errors } = await phone(browser, baseURL, { granted: false });
  try {
    await context.clearPermissions();
    await startRound(page, {});
    await page.click('#yardage-on');
    await page.waitForSelector('#yardage[data-state="blocked"]', { timeout: 5000 });
    assert((await text(page, '#yardage-blocked')).startsWith('Your phone is not letting this page use your location'), 'refused line');
    eq((await geoCount(page)).watch, 1, 'one call, no loop');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally { await context.close(); }
}

async function artifactCopy(browser, baseURL) {
  // Inside Claude (`window.claude` present) the hole screen is as before: no panel.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['geolocation'],
    geolocation: { ...TEE1, accuracy: 4 } });
  await context.addInitScript(() => { window.claude = { use: async () => null }; });
  await context.addInitScript(spies);
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/preview.html`);
    await page.waitForSelector('.app');
    await startRound(page, {});
    eq(await page.locator('#yardage').count(), 0, 'no yardage panel in the artifact');
    const g = await geoCount(page);
    eq(g.watch + g.get, 0, 'no geolocation call');
  } finally { await context.close(); }
}

export default async function ({ browser, baseURL }) {
  mkdirSync(SHOTS, { recursive: true });
  await live(browser, baseURL, false);
  await live(browser, baseURL, true);
  await failover(browser, baseURL);
  await unmapped(browser, baseURL);
  await handSavedKept(browser, baseURL);
  await laterVisitNotGranted(browser, baseURL);
  await refused(browser, baseURL);
  await artifactCopy(browser, baseURL);
}

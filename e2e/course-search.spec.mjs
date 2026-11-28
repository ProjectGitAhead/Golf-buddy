// T7.2 "Find a course" (plan 16.2) in the hosted copy's code path (local preview: no `window.claude`). OpenGolfAPI is
// mocked by routing with answers shaped like its source (see src/net/course-search.test.ts), the map lookup by
// routing /api/osm to the hand-built Overpass fixture. Covers: name search with results, no results and a failure;
// near me; the pre-filled editor with flagged values and the attribution; Save, then greens and hazards loaded
// around the course's own coordinates through /api/osm and stored on the course ("Found N of 18 greens"); and the
// artifact copy (with `window.claude`), where none of it shows and nothing is fetched. 390 px, light and dark.
import { mkdirSync, readFileSync } from 'node:fs';
import { assert, eq, noHorizontalScroll, text } from './lib.mjs';

const SHOTS = process.env.REVIEW_DIR
  || '/tmp/claude-0/-home-user/24fc6364-1d94-5479-9217-f29e60caeeeb/scratchpad/review/T7.2';
const KEY = 'golf-buddy:v1';
const FIXTURE = readFileSync(new URL('../src/core/greens.fixture.json', import.meta.url), 'utf8');
const PUBLIC = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const OGA = 'https://api.opengolfapi.org';

// The open data's own Rancho Solano row and 11-hole scorecard (github.com/opengolfapi/data).
const RANCHO_ID = '76c55499-5e08-4db3-aaa8-f97576dab4a6';
const RANCHO = { id: RANCHO_ID, course_name: 'Rancho Solano Golf Course', state: 'CA', city: 'Fairfield', par_total: 72,
  address: '3250 Rancho Solano Pkwy, Fairfield, CA 94534, USA', latitude: 38.291069, longitude: -122.0732421 };
const RANCHO_CARD = [[1, 5, 3], [4, 4, 13], [6, 4, 17], [7, 5, 5], [8, 3, 11], [11, 4, 2], [14, 4, 14], [15, 3, 18], [16, 4, 16], [17, 5, 12], [18, 4, 10]]
  .map(([hole_number, par, handicap_index]) => ({ hole_number, par, handicap_index }));
// A well-covered course (made up) sitting on the greens fixture: full card, a rated tee and an unrated one.
const PV_ID = 'pv-0001';
const PV = { id: PV_ID, course_name: 'Paradise Valley Test Course', state: 'CA', city: 'Fairfield', par_total: 72, latitude: 38.26, longitude: -122.03 };
const PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5];
const PV_CARD = PARS.map((par, i) => ({ hole_number: i + 1, par, handicap_index: ((i * 7) % 18) + 1 }));
const BLUE = Array.from({ length: 18 }, (_, i) => 320 + i * 10);
const PV_TEES = [
  { tee_name: 'Blue', gender: 'M', course_rating: 71.4, slope_rating: 128, total_yardage: BLUE.reduce((a, b) => a + b, 0), yardages: BLUE },
  { tee_name: 'White', gender: 'M', course_rating: null, slope_rating: null, yardages: BLUE.map((y) => y - 25) },
];

/** OpenGolfAPI by routing. `mode`: 'ok', 'empty' (no results), 'down' (connection fails) or a status for searches. */
async function api(context, mode = 'ok') {
  const seen = [];
  await context.route(`${OGA}/**`, (route) => {
    const u = new URL(route.request().url());
    seen.push(u.pathname + u.search);
    const json = (body) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (u.pathname === '/v1/courses/search' || u.pathname.startsWith('/v1/courses/state/')) {
      if (mode === 'down') return route.abort('connectionfailed');
      if (typeof mode === 'number') return route.fulfill({ status: mode, headers: { 'access-control-allow-origin': '*' }, body: '{"error":"x"}' });
      if (mode === 'empty') return json({ count: 0, courses: [] });
      return json({ count: 2, courses: [RANCHO, PV] });
    }
    if (u.pathname === `/v1/courses/${RANCHO_ID}`) return json({ ...RANCHO, scorecard: RANCHO_CARD });
    if (u.pathname === `/v1/courses/${RANCHO_ID}/tees`) return json({ tees: [] });
    if (u.pathname === `/v1/courses/${RANCHO_ID}/holes`) return json({ holes: RANCHO_CARD.map((h) => ({ ...h, yardages: null, meters: null })) });
    if (u.pathname === `/v1/courses/${PV_ID}`) return json({ ...PV, scorecard: PV_CARD });
    if (u.pathname === `/v1/courses/${PV_ID}/tees`) return json({ tees: PV_TEES });
    if (u.pathname === `/v1/courses/${PV_ID}/holes`) return json({ holes: PV_CARD });
    return route.fulfill({ status: 404, body: '{}' });
  });
  return seen;
}

/** /api/osm answers with the fixture; the four public servers are counted (they should not be needed). */
async function osm(context) {
  const calls = { proxy: [], public: 0 };
  await context.route('**/api/osm', (route) => {
    calls.proxy.push(route.request().postData() ?? '');
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: FIXTURE });
  });
  for (const u of PUBLIC) await context.route(u, (route) => { calls.public++; return route.fulfill({ status: 503, body: 'no' }); });
  return calls;
}

async function phone(browser, baseURL, { dark = false, claude = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
    colorScheme: dark ? 'dark' : 'light', geolocation: { latitude: 38.2604, longitude: -122.0301, accuracy: 20 }, permissions: ['geolocation'] });
  // Inside Claude: `window.claude` is there (every capability unavailable is enough to tell the copies apart).
  if (claude) await context.addInitScript(() => { window.claude = { use: async () => null }; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { context, page, errors };
}
const go = async (page, baseURL) => { await page.goto(`${baseURL}/preview.html`); await page.waitForSelector('.app'); };
const shot = (page, name, dark) => page.screenshot({ path: `${SHOTS}/${name}-${dark ? 'dark' : 'light'}.png`, fullPage: false });
const storedCourse = (page, pred) => page.evaluate(([k, src]) => {
  const d = JSON.parse(localStorage.getItem(k) ?? 'null')?.data;
  // eslint-disable-next-line no-new-func
  return Object.values(d?.courses ?? {}).find(new Function('c', `return ${src}`)) ?? null;
}, [KEY, pred]);

async function openFind(page) {
  await page.click('#tab-courses');
  await page.waitForSelector('#courses-screen');
  await page.click('#find-course');
  await page.waitForSelector('#find-panel');
}

async function flow(browser, baseURL, dark) {
  const { context, page, errors } = await phone(browser, baseURL, { dark });
  try {
    const seen = await api(context);
    const calls = await osm(context);
    await go(page, baseURL);
    await page.click('#tab-courses');
    await page.waitForSelector('#find-course');
    eq(seen.length, 0, 'nothing asked before a tap');
    // The find button is first; the scan button (no Claude here) is a plain one.
    eq(await page.evaluate(() => [...document.querySelectorAll('#courses-screen .stack > *')].map((e) => e.id).join(',')),
      'find-course,scan-card,add-course', 'button order');
    await page.click('#find-course');
    await page.waitForSelector('#find-hint');
    assert((await text(page, '#find-hint')).includes('never your position'), 'privacy line');
    await noHorizontalScroll(page, 'find empty');
    await shot(page, 'course-find-empty', dark);

    // By name.
    await page.fill('#find-q', 'rancho');
    await page.click('#find-search');
    await page.waitForSelector('#find-results');
    eq(seen[0], '/v1/courses/search?q=rancho&limit=25', 'search request');
    eq(await page.locator('#find-results li').count(), 2, 'two results');
    eq(await text(page, '#find-result-0 .t'), 'Rancho Solano Golf Course', 'first result');
    eq(await text(page, '#find-result-0 .s'), 'Fairfield, CA · par 72', 'result details');
    eq(await text(page, '#find-attribution'), 'Course data © OpenGolfAPI contributors', 'attribution with the results');
    await noHorizontalScroll(page, 'find results');
    await shot(page, 'course-find-result', dark);

    // Rancho Solano as the open data has it: 11 of 18 holes, no tees. Everything missing is flagged.
    await page.click('#find-result-0');
    await page.waitForSelector('#course-editor');
    eq(await text(page, '#course-editor .h1'), 'Found course', 'editor title');
    eq(await page.inputValue('#course-name-input'), 'Rancho Solano Golf Course', 'name filled');
    eq(await page.inputValue('#course-city'), 'Fairfield', 'city filled');
    eq(await page.inputValue('#par-1'), '5', 'hole 1 par filled');
    eq(await page.inputValue('#si-1'), '3', 'hole 1 stroke index filled');
    eq(await page.inputValue('#par-2'), '', 'hole 2 par left empty');
    eq(await page.getAttribute('#par-2', 'aria-invalid'), 'true', 'hole 2 par flagged');
    eq(await text(page, '#par-2-why'), 'Par: Not in the course data. Copy it from the card.', 'flag reason');
    eq(await page.getAttribute('#tee-0-rating', 'aria-invalid'), 'true', 'rating flagged');
    eq(await page.inputValue('#tee-0-rating'), '', 'no rating made up');
    eq(await page.inputValue('#tee-0-slope'), '', 'no slope made up');
    assert((await text(page, '#tee-0-name-why')).startsWith('No tees in the course data'), 'no-tee reason on the tee name');
    assert(/^35 values need you/.test(await text(page, '#scan-open')), `flag count: ${await text(page, '#scan-open')}`);
    eq(await text(page, '#found-attribution'), 'Course data © OpenGolfAPI contributors', 'attribution in the editor');
    assert((await text(page, '#scan-check')).includes("OpenGolfAPI's open course list"), 'says where the numbers came from');
    eq(await page.getAttribute('#par-1', 'aria-invalid'), null, 'filled values not flagged');
    await noHorizontalScroll(page, 'found editor');
    await shot(page, 'course-find-editor', dark);
    await page.evaluate(() => document.getElementById('par-2')?.scrollIntoView({ block: 'center' }));
    await shot(page, 'course-find-editor-holes', dark);
    await page.click('#save-course');
    eq(await storedCourse(page, "c.name === 'Rancho Solano Golf Course'"), null, 'flags block Save');
    await page.click('#cancel-edit');

    // The well-covered course: only the unrated tee needs him. Save loads its greens around the course.
    await openFind(page);
    await page.fill('#find-q', 'paradise');
    await page.press('#find-q', 'Enter');
    await page.waitForSelector('#find-results');
    await page.click('#find-result-1');
    await page.waitForSelector('#course-editor');
    eq(await page.inputValue('#tee-0-rating'), '71.4', 'rated tee filled');
    eq(await page.inputValue('#tee-1-slope'), '', 'unrated tee left empty');
    assert(/^2 values need you/.test(await text(page, '#scan-open')), `flag count: ${await text(page, '#scan-open')}`);
    assert((await text(page, '#save-hint')).includes('green positions from OpenStreetMap'), 'save says it loads greens');
    eq(calls.proxy.length, 0, 'no map lookup before Save');
    await page.fill('#tee-1-rating', '69.9');
    await page.fill('#tee-1-slope', '122');
    await page.click('#save-course');
    await page.waitForSelector('#course-greens-found');
    eq(await text(page, '#course-greens-found-line'), 'Found 18 of 18 greens', 'found line');
    eq(await page.locator('#course-greens-missing').count(), 0, 'nothing missing');
    eq(calls.proxy.length, 1, 'one request to /api/osm');
    eq(calls.public, 0, 'the public servers were not needed');
    const q = decodeURIComponent(calls.proxy[0].replace(/^data=/, ''));
    assert(q.includes('way["golf"="green"](around:2500,38.260,-122.030)'), `query around the course, 2,500 m: ${q.slice(0, 160)}`);
    const c = await storedCourse(page, `c.name === 'Paradise Valley Test Course'`);
    assert(c, 'course saved');
    eq(JSON.stringify(c.location), JSON.stringify({ lat: 38.26, lon: -122.03 }), 'location stored');
    eq(c.holes.filter((h) => h.green && h.greenShape?.length >= 3).length, 18, 'greens and outlines stored');
    eq(c.tees.map((t) => `${t.name} ${t.rating}/${t.slope}`).join(', '), 'Blue 71.4/128, White 69.9/122', 'tees as typed');
    assert(JSON.stringify(c).length < 256 * 1024, 'stored course under 256 KB');
    assert((c.sources ?? []).some((s) => s.includes('OpenGolfAPI')), 'source recorded');
    eq(await text(page, '#course-attribution'), 'Course data © OpenGolfAPI contributors', 'attribution on the course page');
    assert((await text(page, '#course-greens-found')).includes('Green positions © OpenStreetMap contributors'), 'OSM attribution');
    await page.evaluate(() => document.getElementById('course-greens')?.scrollIntoView({ block: 'center' }));
    await noHorizontalScroll(page, 'greens found');
    await shot(page, 'course-find-greens', dark);

    // Editing the numbers later keeps the greens, outlines and location.
    await page.click('#edit-course');
    await page.waitForSelector('#course-editor');
    await page.fill('#course-city', 'Fairfield Hills');
    await page.click('#save-course');
    await page.waitForSelector('#course-detail');
    const c2 = await storedCourse(page, `c.name === 'Paradise Valley Test Course'`);
    eq(c2.holes.filter((h) => h.greenShape?.length >= 3).length, 18, 'outlines kept on edit');
    eq(JSON.stringify(c2.location), JSON.stringify(c.location), 'location kept on edit');
    eq(await text(page, '#course-load-greens'), 'Load green positions again', 'can load again later');
    eq(errors.join(' | '), '', 'no page errors');
  } finally {
    await context.close();
  }
}

async function emptyAndFailing(browser, baseURL, dark) {
  for (const [mode, sel, want] of [
    ['empty', '#find-none', 'No course in the list matches "zzzz". Try part of the name, or add it by hand.'],
    ['down', '#find-failed', "Couldn't reach the course list. Check that this phone is online and try again."],
    [429, '#find-failed', 'The course list has had too many searches from this connection today. Try again tomorrow, or add the course by hand.'],
  ]) {
    const { context, page, errors } = await phone(browser, baseURL, { dark });
    try {
      await api(context, mode);
      await go(page, baseURL);
      await openFind(page);
      await page.fill('#find-q', 'zzzz');
      await page.click('#find-search');
      await page.waitForSelector(sel);
      eq(await text(page, sel), want, `${mode}: line`);
      assert(await page.isVisible('#find-search'), `${mode}: can search again`);
      await noHorizontalScroll(page, `find ${mode}`);
      if (mode !== 429) await shot(page, mode === 'empty' ? 'course-find-none' : 'course-find-failed', dark);
      eq(errors.join(' | '), '', `${mode}: no page errors`);
    } finally {
      await context.close();
    }
  }
}

async function nearMe(browser, baseURL) {
  const { context, page, errors } = await phone(browser, baseURL);
  try {
    const seen = await api(context);
    await go(page, baseURL);
    await openFind(page);
    await page.click('#find-near');
    await page.waitForSelector('#find-results');
    eq(seen.join(), '/v1/courses/state/CA?limit=500', 'near me asks for the state list, never the position');
    eq(await text(page, '#find-count'), '2 courses near you. Pick yours to check its numbers.', 'count line');
    eq(await text(page, '#find-result-0 .t'), 'Paradise Valley Test Course', 'nearest first');
    assert(/ yd$/.test(await text(page, '#find-result-0 .s')), `distance in yards: ${await text(page, '#find-result-0 .s')}`);
    assert(/ mi$/.test(await text(page, '#find-result-1 .s')), `distance in miles: ${await text(page, '#find-result-1 .s')}`);
    eq(errors.join(' | '), '', 'no page errors');
  } finally {
    await context.close();
  }
}

/** Inside Claude: no find button, no green lookup on a course page, and nothing fetched. */
async function artifact(browser, baseURL) {
  const { context, page, errors } = await phone(browser, baseURL, { claude: true });
  try {
    const seen = await api(context);
    const calls = await osm(context);
    await go(page, baseURL);
    await page.click('#tab-courses');
    await page.waitForSelector('#scan-card');
    eq(await page.locator('#find-course').count(), 0, 'no Find a course inside Claude');
    assert((await page.getAttribute('#scan-card', 'class')).includes('btn-primary'), 'scan stays the main button');
    await page.click('#course-rancho-solano');
    await page.waitForSelector('#course-detail');
    eq(await page.locator('#course-greens').count(), 0, 'no green lookup inside Claude');
    eq(seen.length + calls.proxy.length + calls.public, 0, 'nothing fetched');
    eq(errors.join(' | '), '', 'no page errors');
  } finally {
    await context.close();
  }
}

export default async function ({ browser, baseURL }) {
  mkdirSync(SHOTS, { recursive: true });
  for (const dark of [false, true]) {
    await flow(browser, baseURL, dark);
    await emptyAndFailing(browser, baseURL, dark);
  }
  await nearMe(browser, baseURL);
  await artifact(browser, baseURL);
}

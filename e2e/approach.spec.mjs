// T3.1: the green sheet (manual tap and drag, photo through a mocked `sample`, every fallback) and the heat map
// on the Shots screen, on a 390 px phone.
import { assert, eq, newPage, noHorizontalScroll, rancho, startRound, text } from './lib.mjs';

const KEY = 'golf-buddy:v1';
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

/** Installs `window.claude` with a mocked `sample` (and no db / user). `mode` picks what sample.json does. */
function installSample({ mode, answer }) {
  window.__sampleCalls = [];
  const sample = Object.freeze({
    limits: async () => ({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } }),
    json: async (prompt, opts) => {
      const img = opts?.images;
      let w = 0, h = 0;
      try { const b = await createImageBitmap(img); w = b.width; h = b.height; } catch { /* not an image */ }
      window.__sampleCalls.push({ prompt, type: img?.type, size: img?.size, w, h });
      if (mode === 'reject') throw { code: 'rate_limited', message: 'mock' };
      if (mode === 'declined') throw { code: 'not_granted', message: 'mock' };
      return answer;
    },
  });
  window.claude = { use: async (name) => (name === 'sample' && mode !== 'null' ? sample : null) };
}

async function photoPage(browser, baseURL, mode, answer) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.addInitScript(installSample, { mode, answer });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${baseURL}/preview.html`);
  await page.waitForSelector('.app');
  return { page, context: ctx, errors };
}

/** A big PNG made in the page, so the downscale has something to do. */
async function bigPng(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 2400; c.height = 1800;
    const x = c.getContext('2d'); x.fillStyle = '#3a7d44'; x.fillRect(0, 0, 2400, 1800);
    x.fillStyle = '#fff'; x.beginPath(); x.arc(1100, 1200, 20, 0, 7); x.fill();
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name: 'green.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

/** Page coordinates of a point on the green, in feet. */
async function ftToPx(page, xFt, yFt) {
  const r = await page.locator('#green-diagram').boundingBox();
  return { x: r.x + (xFt / 80 + 0.5) * r.width, y: r.y + (0.5 - yFt / 80) * r.height };
}
async function ballFt(page) {
  const g = page.locator('#green-ball');
  return { x: Number(await g.getAttribute('data-x')), y: Number(await g.getAttribute('data-y')) };
}
async function storedApproach(page, hole = 1) {
  return page.evaluate(([k, h]) => {
    const r = Object.values(JSON.parse(localStorage.getItem(k)).data.rounds).find((x) => x.status === 'active');
    return r.scores.find((s) => s.hole === h)?.approach ?? null;
  }, [KEY, hole]);
}
async function choosePhoto(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }), page.click('#green-photo')]);
  await chooser.setFiles(file);
}

async function manual(browser, baseURL) {
  const { page, context, errors } = await newPage(browser, baseURL);
  try {
    await startRound(page, {});
    eq(await page.getAttribute('#approach-open', 'data-state'), 'empty', 'no mark yet');
    await page.click('#approach-open');
    await page.waitForSelector('#green-sheet');
    assert(await page.isDisabled('#approach-save'), 'save waits for a ball');
    await noHorizontalScroll(page, 'green sheet');

    // Tap places the ball where tapped.
    const tap = await ftToPx(page, -9, -10.5);
    await page.mouse.click(tap.x, tap.y);
    const b1 = await ballFt(page);
    assert(near(b1.x, -9) && near(b1.y, -10.5), `tap: ball at ${b1.x},${b1.y}`);
    eq(await text(page, '#approach-readout'), '14 ft, short left', 'readout after tap');
    eq(await page.getAttribute('#approach-on-green', 'aria-pressed'), 'true', 'inside the green presets On the green');

    // Drag moves it.
    const to = await ftToPx(page, 12, 6);
    await page.mouse.move(tap.x, tap.y);
    await page.mouse.down();
    await page.mouse.move((tap.x + to.x) / 2, (tap.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await page.click('#approach-off-green');
    await page.click('#approach-save');
    await page.waitForSelector('#green-sheet', { state: 'detached' });
    const saved = await storedApproach(page);
    assert(saved && near(saved.xFt, 12) && near(saved.yFt, 6), `saved mark ${JSON.stringify(saved)} matches the drag`);
    eq(saved.source, 'manual', 'manual source');
    eq(saved.onGreen, false, 'off the green as chosen');

    // The hole screen shows the saved state; re-open, move, remove.
    eq(await page.getAttribute('#approach-open', 'data-state'), 'saved', 'saved state on the hole screen');
    eq(await text(page, '#approach-summary'), '13 ft, long right, off the green', 'summary on the hole screen');
    await page.click('#approach-open');
    const again = await ftToPx(page, 0, 20);
    await page.mouse.click(again.x, again.y);
    await page.click('#approach-save');
    const moved = await storedApproach(page);
    assert(near(moved.xFt, 0) && near(moved.yFt, 20), `moved mark ${JSON.stringify(moved)}`);
    await page.click('#approach-open');
    await page.click('#approach-remove');
    eq(await storedApproach(page), null, 'mark removed');
    eq(await page.getAttribute('#approach-open', 'data-state'), 'empty', 'empty after removing');

    // No window.claude: the photo button explains itself at once and manual placement carries on.
    await page.click('#approach-open');
    let chooser = false;
    page.once('filechooser', () => { chooser = true; });
    await page.click('#green-photo');
    assert((await text(page, '#green-photo-error')).startsWith("Photo reading isn't available here."), 'no-capability line');
    assert(!chooser, 'no picker without a capability');
    eq(await page.locator('#green-photo').count(), 0, 'photo button hidden after a permanent failure');
    const p = await ftToPx(page, 3, 3);
    await page.mouse.click(p.x, p.y);
    assert(!(await page.isDisabled('#approach-save')), 'manual still works');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

async function photo(browser, baseURL) {
  const answer = { found: true, xFt: -6, yFt: -12, onGreen: true, confidence: 0.8, note: 'Ball short left of the flag.' };
  const { page, context, errors } = await photoPage(browser, baseURL, 'ok', answer);
  try {
    await startRound(page, {});
    await page.click('#approach-open');
    await choosePhoto(page, await bigPng(page));
    await page.waitForSelector('.gs-suggest');
    const calls = await page.evaluate(() => window.__sampleCalls);
    eq(calls.length, 1, 'one sample call');
    eq(calls[0].type, 'image/jpeg', 'sent as JPEG');
    assert(Math.max(calls[0].w, calls[0].h) === 1280, `downscaled to 1280 px, got ${calls[0].w}x${calls[0].h}`);
    assert(calls[0].prompt.includes('found'), 'prompt asks for the JSON shape');
    eq(await text(page, '#approach-readout'), '13 ft, short left', 'suggestion readout');
    assert((await text(page, '#approach-source')).startsWith('From the photo'), 'marked as from the photo');
    eq(await text(page, '#green-photo-note'), answer.note, 'Claude note shown as text');
    eq(await page.inputValue('#green-photo-input'), '', 'file input cleared');

    // Drag the suggestion; it stays a photo mark.
    const from = await ftToPx(page, -6, -12);
    const to = await ftToPx(page, -4, -16);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await page.click('#approach-save');
    const saved = await storedApproach(page);
    assert(saved && near(saved.xFt, -4) && near(saved.yFt, -16), `dragged photo mark ${JSON.stringify(saved)}`);
    eq(saved.source, 'photo', 'saved with source photo');
    eq(saved.confidence, 0.8, 'confidence kept');
    eq(await text(page, '#approach-summary'), '16 ft, short', 'hole screen summary');

    // The photo is stored nowhere.
    const dump = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'));
    assert(!/data:image|base64|iVBOR|\/9j\//.test(dump), 'no image data in localStorage');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

async function fallback(browser, baseURL, mode, answer, expectStart, final) {
  const { page, context, errors } = await photoPage(browser, baseURL, mode, answer);
  try {
    await startRound(page, {});
    await page.click('#approach-open');
    await choosePhoto(page, await bigPng(page));
    await page.waitForSelector('#green-photo-error');
    const line = await text(page, '#green-photo-error');
    assert(line.startsWith(expectStart) && line.endsWith('Tap the green to place your ball.'), `${mode}: line "${line}"`);
    await page.waitForTimeout(600);
    const calls = await page.evaluate(() => window.__sampleCalls.length);
    eq(calls, mode === 'null' ? 0 : 1, `${mode}: sample.json calls (no retry)`);
    eq(await page.locator('.gs-suggest').count(), 0, `${mode}: no suggestion`);
    eq(await page.locator('#green-photo').count(), final ? 0 : 1, `${mode}: photo button ${final ? 'hidden' : 'kept for another photo'}`);
    const p = await ftToPx(page, 5, -5);
    await page.mouse.click(p.x, p.y);
    await page.click('#approach-save');
    eq((await storedApproach(page))?.source, 'manual', `${mode}: manual mark saves`);
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

/** Rounds with marks for the heat map: three posted at Rancho Solano, one active elsewhere. */
export function seedRounds() {
  const holes = rancho.holes.map((h) => ({ number: h.number, par: h.par, strokeIndex: h.strokeIndex }));
  const pts = [[-6, -12], [-9, -15], [-3, -18], [-12, -8], [2, -10], [-7, -22], [-15, -14], [4, 6], [-5, -9], [-10, -26],
    [-2, -5], [8, -12], [-18, -20], [-4, -14], [0, 12], [-8, -6]];
  const mk = (i) => ({ xFt: pts[i][0], yFt: pts[i][1], onGreen: Math.hypot(...pts[i]) < 24, source: i % 3 ? 'manual' : 'photo' });
  const round = (id, date, courseId, courseName, status, from, to) => ({
    id, date, courseId, teeId: 'white-m', status, pcc: 0, courseHandicap: 20, holesPlayed: '18', updatedAt: `${date}T18:00:00.000Z`,
    snapshot: { courseName, teeName: 'White', rating: 70.1, slope: 125, par: 72, holes },
    scores: holes.map((h, i) => ({ hole: h.number, strokes: h.par + 1, putts: 2, ...(i >= 0 && from + i < to ? { approach: mk(from + i) } : {}) })),
  });
  const rounds = [
    round('r-a', '2026-10-04', 'rancho-solano', 'Rancho Solano', 'posted', 0, 6),
    round('r-b', '2026-10-18', 'rancho-solano', 'Rancho Solano', 'posted', 6, 11),
    round('r-c', '2026-11-08', 'other-course', 'Green Valley', 'posted', 11, 14),
    round('r-d', '2026-11-27', 'rancho-solano', 'Rancho Solano', 'active', 14, 16),
  ];
  return { data: { profile: { gender: 'M', updatedAt: '2026-10-01T00:00:00.000Z' }, rounds: Object.fromEntries(rounds.map((r) => [r.id, r])), courses: {}, imports: {} }, tombstones: {} };
}

async function heatmap(browser, baseURL) {
  const { page, context, errors } = await newPage(browser, baseURL);
  try {
    await page.click('#tab-shots');
    assert(await page.isVisible('#heatmap-empty'), 'empty line with no marks');
    await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [KEY, seedRounds()]);
    await page.reload();
    await page.waitForSelector('.app');
    await page.click('#tab-shots');
    await page.waitForSelector('#heatmap-canvas');
    const marks = () => page.getAttribute('#heatmap-canvas', 'data-marks');
    eq(await marks(), '16', 'all marks from posted and active rounds');
    eq(await page.getAttribute('#heatmap-canvas', 'data-heat'), 'true', 'heat layer from 5 marks');
    assert(await page.isVisible('#heatmap-summary'), 'summary shown');
    const pattern = await text(page, '#heatmap-pattern');
    assert(pattern.includes('finish short of the pin'), `pattern in words: ${pattern}`);
    await noHorizontalScroll(page, 'shots');

    // The heat is a density rendering: the dense short-left area is coloured, a far corner is plain surface.
    const px = await page.evaluate(() => {
      const c = document.getElementById('heatmap-canvas');
      const x = c.getContext('2d');
      const at = (fx, fy) => Array.from(x.getImageData(Math.round(c.width * (0.5 + fx / 80)), Math.round(c.height * (0.5 - fy / 80)), 1, 1).data);
      return { hot: at(-8, -17), corner: at(37, 37), between: at(-12, -30) };
    });
    assert(px.hot.join() !== px.corner.join(), `heat differs from the plain corner ${px.hot} vs ${px.corner}`);

    await page.click('#heat-filter-par3');
    const par3 = Number(await marks());
    const expectedPar3 = rancho.holes.filter((h, i) => h.par === 3 && i < 16).length;
    assert(par3 > 0 && par3 < 16, `par 3 filter narrows the set (${par3}, expected about ${expectedPar3})`);
    if (par3 < 5) {
      assert(await page.isVisible('#heatmap-unlock'), 'unlock line under 5 marks');
      eq(await page.locator('#heatmap-summary').count(), 0, 'no summary under 5 marks');
      eq(await page.getAttribute('#heatmap-canvas', 'data-heat'), 'false', 'dots only under 5 marks');
    }
    await page.click('#heat-filter-course');
    eq(await marks(), '13', 'this course: Rancho Solano (active round) only');
    await page.click('#heat-filter-last5');
    eq(await marks(), '16', 'last 5 rounds: all four');
    await page.click('#heat-filter-all');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

export default async function ({ browser, baseURL }) {
  await manual(browser, baseURL);
  await photo(browser, baseURL);
  await fallback(browser, baseURL, 'null', null, "Photo reading isn't available here.", true);
  await fallback(browser, baseURL, 'declined', null, "Claude wasn't allowed to read photos.", true);
  await fallback(browser, baseURL, 'reject', null, 'Too many photo reads just now.', false);
  await fallback(browser, baseURL, 'ok', { found: false, xFt: 0, yFt: 0, onGreen: false, confidence: 0, note: 'No ball.' },
    "Couldn't see both the flagstick and your ball.", false);
  await fallback(browser, baseURL, 'ok', 'not an object', "Couldn't read a position from that photo.", false);
  await heatmap(browser, baseURL);
}

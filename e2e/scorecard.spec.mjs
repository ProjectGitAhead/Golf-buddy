// Scorecard scan: with a mocked `sample` capability the editor opens pre-filled and marked "Check against the
// card", flagged values block Save until retyped, nothing is saved before Save; with `sample` missing, refusing
// images, failing or finding no card, one plain line explains it and the hand editor opens empty.
import { mkdirSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { assert, eq, noHorizontalScroll, text } from './lib.mjs';

const SHOTS = process.env.SHOTS_DIR;

/** A plain PNG of `w` x `h` (a stand-in photo big enough to need downscaling). */
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3, 200); row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PHOTO = { name: 'card.png', mimeType: 'image/png', buffer: png(2400, 1200) };

const PARS = [6, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];           // hole 1 misread as 6 (really 5)
const SI = [7, 7, 15, 1, 11, 9, 17, 5, 13, 8, 4, 16, 2, 12, 10, 18, 6, 14];       // hole 2 misread (really 3)
const YARDS = [380, 410, 165, 250, 395, 370, 180, 540, 400, 385, 420, 150, 530, 405, 360, 175, 515, 390]; // hole 4 really 520
const NAME = 'Paradise <b>Valley</b>';
const ANSWER = {
  found: true, name: NAME, city: 'Fairfield', state: 'CA',
  holes: PARS.map((p, i) => ({ number: i + 1, par: p, strokeIndex: SI[i], strokeIndexW: null })),
  tees: [
    { name: 'Blue', gender: 'M', rating: 71.8, slope: null, yardages: YARDS, out: 3360, in: 3330, total: 6690 },
    { name: 'Blue', gender: 'W', rating: 77.0, slope: 138, yardages: YARDS, out: null, in: null, total: null },
  ],
};

/** `window.claude` with only `sample`, answering per `mode`; records what each call sent. */
function installSample({ mode, answer }) {
  window.__calls = [];
  const sample = async () => ({ text: '', truncated: false, modelTierApplied: 'default' });
  sample.json = async (input, opts) => {
    const imgs = Array.from(opts?.images ?? []);
    const dims = [];
    for (const b of imgs) { const bmp = await createImageBitmap(b); dims.push([bmp.width, bmp.height, b.type]); }
    window.__calls.push({ input, dims });
    if (mode === 'fail') throw { code: 'upstream_error', message: 'mock failure' };
    await new Promise((r) => setTimeout(r, 400));
    opts?.onText?.({ text: '{', delta: '{' });
    await new Promise((r) => setTimeout(r, 200));
    return mode === 'notfound' ? { found: false } : answer;
  };
  sample.limits = async () => (mode === 'noimages' ? { maxPromptBytes: 262144 }
    : { maxPromptBytes: 262144, images: { maxCount: 2, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } });
  window.claude = { use: async (n) => (n === 'sample' ? sample : null) };
}

async function open(browser, baseURL, { mode, dark = false, width = 390 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
    colorScheme: dark ? 'dark' : 'light' });
  if (mode) await context.addInitScript(installSample, { mode, answer: ANSWER });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${baseURL}/preview.html`);
  await page.waitForSelector('.app');
  await page.click('#tab-courses');
  return { page, context, errors };
}

const stored = (page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem('golf-buddy:v1') ?? 'null')?.data?.courses ?? {});
const invalid = (page, sel) => page.getAttribute(sel, 'aria-invalid');

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

async function scan(page) {
  await page.click('#scan-card');
  await page.waitForSelector('#scan-panel');
  await page.setInputFiles('#scan-photo-choose', PHOTO);
  await page.waitForSelector('#scan-photos li');
  await page.click('#scan-read');
}

export default async function ({ browser, baseURL }) {
  // 1. A scan that reads the card, with misreads the checks catch.
  const { page, context, errors } = await open(browser, baseURL, { mode: 'ok' });
  try {
    await page.click('#scan-card');
    await page.waitForSelector('#scan-panel');
    await noHorizontalScroll(page, 'scan panel');
    await shot(page, 'scan-panel-light');
    eq(await page.isDisabled('#scan-read'), true, 'Read the card waits for a photo');
    await page.setInputFiles('#scan-photo-choose', PHOTO);
    await page.waitForSelector('#scan-photos li');
    await page.click('#scan-read');
    await page.waitForSelector('#scan-status');
    await page.waitForSelector('#course-editor');

    const calls = await page.evaluate(() => window.__calls);
    eq(calls.length, 1, 'one call to sample.json');
    assert(calls[0].input.includes('never guess a number'), 'prompt carries the no-guessing rule');
    const [w, h, type] = calls[0].dims[0];
    assert(w <= 1600 && h <= 1600 && w === 1600, `photo downscaled to 1600 px on the long side: ${w}x${h}`);
    eq(type, 'image/jpeg', 'photo re-encoded as JPEG');

    eq(await text(page, '#scan-check .badge'), 'Check against the card', 'editor marked "Check against the card"');
    eq(await page.inputValue('#course-name-input'), NAME, 'name pre-filled as plain text');
    eq(await page.inputValue('#tee-0-rating'), '71.8', 'rating pre-filled');
    eq(await page.inputValue('#yards-0-9'), '400', 'yards pre-filled');
    eq(await page.inputValue('#tee-1-gender'), 'W', 'women\'s tee kept');
    eq(await page.isChecked('#course-verified'), false, 'a scanned course is not marked verified');
    // Each check is highlighted with its reason next to the field.
    for (const [sel, why] of [
      ['#par-1', /Read as 6/], ['#si-1', /Read as 7, same as hole 2/], ['#si-2', /Missing: 3\./],
      ['#tee-0-slope', /Not read from the photo/],
    ]) {
      eq(await invalid(page, sel), 'true', `${sel} highlighted`);
      const id = (await page.getAttribute(sel, 'aria-describedby')) ?? '';
      assert(why.test(await text(page, `#${id}`)), `${sel} reason: ${await text(page, `#${id}`)}`);
    }
    eq(await page.getAttribute('#yards-0-out', 'data-bad'), 'true', 'OUT total highlighted');
    assert(/add up to 3,090 yards; the card's OUT reads 3,360/.test(await text(page, '#yards-0-out-why')), `OUT mismatch reason: ${await text(page, '#yards-0-out-why')}`);
    assert((await text(page, '#yards-tee-0')).includes('Blue M3 to check'), 'tee chip counts its flags');
    eq(await invalid(page, '#par-3'), null, 'a clean value is not highlighted');
    assert((await text(page, '#scan-open')).startsWith('6 values need you'), `open count: ${await text(page, '#scan-open')}`);
    await noHorizontalScroll(page, 'scanned editor');
    await shot(page, 'scan-result-light');
    await page.locator('#par-1').scrollIntoViewIfNeeded();
    await shot(page, 'scan-result-holes-light');
    eq(Object.keys(await stored(page)).length, 0, 'nothing saved before Save');

    // Save is blocked while flags remain.
    await page.click('#save-course');
    assert(await page.isVisible('#editor-errors'), 'Save blocked: problems listed');
    assert((await text(page, '#editor-errors')).includes('Blue: slope must be'), `the list says where: ${await text(page, '#editor-errors')}`);
    eq(Object.keys(await stored(page)).length, 0, 'nothing saved while flags remain');

    // Retype each flagged value from the card.
    await page.fill('#par-1', '5');
    eq(await invalid(page, '#par-1'), null, 'retyped par clears its flag');
    await page.fill('#si-2', '3');
    await page.fill('#si-1', '7');
    await page.fill('#tee-0-slope', '133');
    await page.fill('#yards-0-4', '520');
    eq(await page.getAttribute('#yards-0-out', 'data-bad'), null, 'OUT flag cleared by retyping a front-nine hole');
    eq(await text(page, '#yards-0-out'), '3,360', 'OUT sum updates');
    await page.click('#save-course');
    await page.waitForSelector('#course-detail');
    eq(await text(page, '#course-name'), NAME, 'course name rendered as text');
    eq(await page.locator('#course-name b').count(), 0, 'no markup from the answer');
    assert(await page.isVisible('#course-unverified'), 'saved scan shows the check-the-card note');
    const saved = Object.values(await stored(page));
    eq(saved.length, 1, 'one course saved after Save');
    eq(saved[0].holes[0].par, 5, 'retyped par saved');
    eq(saved[0].tees[0].slope, 133, 'retyped slope saved');
    eq(saved[0].tees[1].gender, 'W', 'women\'s tee saved');
    eq(saved[0].verified, false, 'saved unverified');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }

  // 2. Dark theme at 390 and 360 px: the scanned editor fits.
  for (const width of [390, 360]) {
    const d = await open(browser, baseURL, { mode: 'ok', dark: true, width });
    try {
      await scan(d.page);
      await d.page.waitForSelector('#course-editor');
      await noHorizontalScroll(d.page, `dark scanned editor ${width}`);
      if (width === 390) {
        await shot(d.page, 'scan-result-dark');
        await d.page.locator('#yards-0-out').scrollIntoViewIfNeeded();
        await shot(d.page, 'scan-result-holes-dark');
      }
    } finally {
      await d.context.close();
    }
  }

  // 3. Every fallback: one plain line, and the hand editor opens empty.
  const cases = [
    [null, 'Scanning needs Claude, which is not available here. Copy the numbers from the card instead.'],
    ['noimages', 'This view cannot send photos to Claude. Copy the numbers from the card instead.'],
    ['fail', 'The scan did not finish. Copy the numbers from the card, or scan again.'],
    ['notfound', 'No scorecard was found in the photo. Copy the numbers from the card, or scan again closer and flat.'],
  ];
  for (const [mode, line] of cases) {
    const f = await open(browser, baseURL, { mode });
    try {
      if (mode === 'fail' || mode === 'notfound') await scan(f.page);
      else await f.page.click('#scan-card');
      await f.page.waitForSelector('#scan-notice');
      eq(await text(f.page, '#scan-notice'), line, `fallback line (${mode ?? 'no claude'})`);
      eq(await f.page.locator('#scan-notice').count(), 1, 'one line');
      eq(await f.page.inputValue('#course-name-input'), '', 'hand editor opens empty');
      eq(await f.page.inputValue('#par-1'), '', 'hand editor holes empty');
      eq(await f.page.locator('#scan-check').count(), 0, 'not marked as a scan');
      eq(await f.page.locator('[aria-invalid="true"]').count(), 0, 'nothing highlighted before Save');
      if (mode === null) await shot(f.page, 'scan-fallback-light');
      eq(f.errors.length, 0, `page errors: ${f.errors.join(' | ')}`);
    } finally {
      await f.context.close();
    }
  }
}

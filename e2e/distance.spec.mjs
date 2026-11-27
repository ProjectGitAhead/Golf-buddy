// T5.1: the distance sheet on the hole screen. Rangefinder with generated JPEGs (big- and little-endian EXIF, digital
// zoom and its toggle, no EXIF, an unreadable file), zoom / pan / pinch / drag with the loupe, the flagstick setting; GPS with a
// mocked position (save a green, move, measure a shot) and with location refused. 390 px phone, light and dark.
import { mkdirSync } from 'node:fs';
import { assert, eq, noHorizontalScroll, startRound, text } from './lib.mjs';

const KEY = 'golf-buddy:v1';
const SHOTS = process.env.REVIEW_DIR
  || '/tmp/claude-0/-home-user/24fc6364-1d94-5479-9217-f29e60caeeeb/scratchpad/review/T5.1';
const W = 4032, H = 3024, STICK_X = 2016;

/** Same maths as src/core/rangefinder.ts, written out independently. */
const yardsFor = (flagFt, f35, w, h, px) => (flagFt * ((f35 * Math.hypot(w, h)) / 43.27)) / px / 3;

/** Counts every geolocation call, file-picker opening and bitmap release, before any page script runs. */
function spies() {
  window.__geo = { get: 0, watch: 0, clear: 0 };
  window.__picker = 0;
  window.__closed = 0;
  const g = navigator.geolocation;
  if (g) {
    const { getCurrentPosition, watchPosition, clearWatch } = g;
    g.getCurrentPosition = function (...a) { window.__geo.get++; return getCurrentPosition.apply(g, a); };
    g.watchPosition = function (...a) { window.__geo.watch++; return watchPosition.apply(g, a); };
    g.clearWatch = function (...a) { window.__geo.clear++; return clearWatch.apply(g, a); };
  }
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === 'file') window.__picker++; return click.call(this); };
  const close = ImageBitmap.prototype.close;
  ImageBitmap.prototype.close = function () { window.__closed++; return close.call(this); };
}

async function phone(browser, baseURL, { dark = false, geo = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
    colorScheme: dark ? 'dark' : 'light', ...(geo ? { permissions: ['geolocation'], geolocation: geo } : {}) });
  await context.addInitScript(spies);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${baseURL}/preview.html`);
  await page.waitForSelector('.app');
  return { page, context, errors };
}

/** A W x H JPEG with sky, fairway and a flagstick at STICK_X from y = top to y = top + px (made in the page). */
async function stickJpeg(page, px) {
  const top = Math.round(H / 2 - px / 2);
  const b64 = await page.evaluate(([w, h, x, t, len]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#9cc7e8'; g.fillRect(0, 0, w, h * 0.5);
    g.fillStyle = '#3f8a3a'; g.fillRect(0, h * 0.5, w, h * 0.5);
    g.fillStyle = '#2d6d2b'; g.fillRect(0, t + len - 4, w, 30);
    g.fillStyle = '#fafafa'; g.fillRect(x - 1, t, 2, len);
    g.fillStyle = '#e03a1e'; g.fillRect(x + 1, t, Math.max(6, len * 0.35), Math.max(4, len * 0.22));
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, [W, H, STICK_X, top, px]);
  return { buf: Buffer.from(b64, 'base64'), top, bottom: top + px };
}

/** Splices an APP1 EXIF segment (FocalLengthIn35mmFilm, optional DigitalZoomRatio) in after the JPEG's SOI. */
function withExif(jpg, { le, f35, zoom }) {
  const u16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const exifEntries = zoom ? 2 : 1;
  const exifAt = 8 + 2 + 2 * 12 + 4;                     // IFD0 holds Orientation and the Exif IFD pointer
  const ratAt = exifAt + 2 + exifEntries * 12 + 4;
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8),
    ...u16(2), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(1), 0, 0, ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifAt), ...u32(0),
    ...u16(exifEntries),
    ...(zoom ? [...u16(0xa404), ...u16(5), ...u32(1), ...u32(ratAt)] : []),
    ...u16(0xa405), ...u16(3), ...u32(1), ...u16(f35), 0, 0, ...u32(0),
    ...(zoom ? [...u32(zoom * 100), ...u32(100)] : [])];
  const app1 = Buffer.from([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
  const head = Buffer.from([0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255]);
  return Buffer.concat([jpg.subarray(0, 2), head, app1, jpg.subarray(2)]);
}

const file = (buf, name = 'flag.jpg') => ({ name, mimeType: 'image/jpeg', buffer: buf });

async function openSheet(page) {
  await page.click('#distance-open');
  await page.waitForSelector('#distance-sheet');
}

async function choose(page, f, trigger = '#rf-photo') {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }), page.click(trigger)]);
  await chooser.setFiles(f);
}

async function viewOf(page) {
  const box = await page.locator('#rf-stage').boundingBox();
  const a = await page.locator('#rf-stage').evaluate((el) => ({ s: +el.dataset.scale, x0: +el.dataset.x0, y0: +el.dataset.y0 }));
  // The canvas sits inside the stage's 1 px border.
  return { ...a, left: box.x + 1, top: box.y + 1 };
}
const toScreen = (v, ix, iy) => ({ x: v.left + (ix - v.x0) * v.s, y: v.top + (iy - v.y0) * v.s });
async function markAt(page, which) {
  const g = page.locator(`#rf-mark-${which}`);
  return { x: Number(await g.getAttribute('data-ix')), y: Number(await g.getAttribute('data-iy')) };
}
async function zoomTo(page, minScale) {
  for (let i = 0; i < 8 && (await viewOf(page)).s < minScale; i++) await page.click('#rf-zoom-in');
}
async function placeBoth(page, top, bottom) {
  const v = await viewOf(page);
  const a = toScreen(v, STICK_X, top), b = toScreen(v, STICK_X, bottom);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.waitForSelector('#rf-mark-base', { state: 'attached', timeout: 3000 });
}
async function readYards(page) {
  return Number(await text(page, '#rf-yards'));
}

async function rangefinder(browser, baseURL) {
  const { page, context, errors } = await phone(browser, baseURL);
  try {
    await startRound(page, {});
    await openSheet(page);
    let s = await page.evaluate(() => ({ geo: window.__geo, picker: window.__picker }));
    eq(s.geo.get + s.geo.watch, 0, 'no geolocation call on opening');
    eq(s.picker, 0, 'no camera / picker on opening');
    await noHorizontalScroll(page, 'distance sheet');
    eq(await text(page, '#rf-flag-value'), '7 ft', 'default flagstick height');
    await page.screenshot({ path: `${SHOTS}/distance-rangefinder-empty-light.png` });

    // Big-endian EXIF, 26 mm, 42 px stick in a 4032 x 3024 photo: the plan's worked example, 168 yd.
    const shot = await stickJpeg(page, 42);
    await choose(page, file(withExif(shot.buf, { le: false, f35: 26 })));
    await page.waitForSelector('#rf-stage[data-scale]');
    eq(await page.inputValue('#rf-photo-input'), '', 'file input cleared');
    eq(await page.locator('#rf-lens-1x').count(), 0, 'no lens picker when EXIF has the lens');
    const fit = await viewOf(page);
    assert(Math.abs(fit.s - Math.min(354 / W, 440 / H)) < 0.01, `fits the photo first (scale ${fit.s})`);

    // Button zoom, then a one-finger pan and a two-finger pinch.
    await zoomTo(page, 2.5);
    const z = await viewOf(page);
    assert(z.s >= 2.5, `zoomed in to ${z.s}`);
    const c = { x: z.left + 120, y: z.top + 300 };
    await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 40, c.y + 30, { steps: 4 }); await page.mouse.up();
    const panned = await viewOf(page);
    assert(Math.abs((z.x0 - panned.x0) * z.s - 40) < 1 && Math.abs((z.y0 - panned.y0) * z.s - 30) < 1, 'pan follows the finger');
    eq(await page.locator('#rf-mark-top').count(), 0, 'a pan places no mark');
    await page.locator('#rf-canvas').evaluate((el) => {
      const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const ev = (type, id, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: cy, bubbles: true, pointerType: 'touch', isPrimary: id === 11 }));
      ev('pointerdown', 11, cx - 30); ev('pointerdown', 12, cx + 30);
      ev('pointermove', 11, cx - 45); ev('pointermove', 12, cx + 45);
      ev('pointerup', 11, cx - 45); ev('pointerup', 12, cx + 45);
    });
    const pinched = await viewOf(page);
    assert(Math.abs(pinched.s / panned.s - 1.5) < 0.02, `pinch zooms 1.5x (${panned.s} -> ${pinched.s})`);
    eq(await page.locator('#rf-mark-top').count(), 0, 'a pinch places no mark');
    // Back to the stick: zoom out to fit, then in again around the centre.
    for (let i = 0; i < 8; i++) await page.click('#rf-zoom-out');
    await zoomTo(page, 2.5);

    eq(await text(page, '#rf-hint'), 'Zoom in on the flag, then tap the very top of the flagstick.', 'first hint');
    await placeBoth(page, shot.top, shot.bottom);
    const t = await markAt(page, 'top'), b = await markAt(page, 'base');
    assert(Math.abs(t.y - shot.top) < 0.5 && Math.abs(b.y - shot.bottom) < 0.5, `marks at ${t.y} / ${b.y}`);
    eq(await readYards(page), 168, 'worked example yards');
    eq(await text(page, '#rf-pm'), '± 8 yd', 'plus/minus from 2 px');
    eq(await text(page, '#rf-lens'), 'Lens 26 mm, read from the photo · 7 ft flagstick', 'lens source line');
    await page.screenshot({ path: `${SHOTS}/distance-rangefinder-light.png` });

    // Drag the top knob up 2 image px; the loupe shows while dragging and the knob sits off the stick.
    const v = await viewOf(page);
    const kb = await page.locator('#rf-knob-top').boundingBox();
    const k = { x: kb.x + kb.width / 2, y: kb.y + kb.height / 2 };
    const markScreen = toScreen(v, t.x, t.y);
    assert(Math.abs(k.x - markScreen.x) >= 50, 'knob is offset sideways from the mark');
    assert(kb.width >= 48 && kb.height >= 48, 'knob is a large touch target');
    await page.mouse.move(k.x, k.y); await page.mouse.down();
    await page.mouse.move(k.x, k.y - v.s, { steps: 3 });
    assert(await page.locator('#rf-loupe').isVisible(), 'loupe shows while dragging');
    const loupeBox = await page.locator('#rf-loupe').boundingBox();
    assert(loupeBox.x + loupeBox.width < markScreen.x || loupeBox.x > markScreen.x, 'loupe is beside the mark, not on it');
    await page.mouse.move(k.x, k.y - 2 * v.s, { steps: 3 });
    await page.screenshot({ path: `${SHOTS}/distance-rangefinder-drag-light.png` });
    // The loupe really shows the photo's pixels: its centre column above the cross hair is the white stick.
    const px = await page.locator('#rf-loupe canvas').evaluate((cv) => {
      const g = cv.getContext('2d'); const m = cv.width / 2;
      return [...g.getImageData(m, m + 80, 1, 1).data].slice(0, 3);
    });
    assert(px.every((x) => x > 180), `loupe shows the stick under the mark (${px})`);
    await page.mouse.up();
    eq(await page.locator('#rf-loupe').count(), 0, 'loupe goes when the drag ends');
    const t2 = await markAt(page, 'top');
    assert(Math.abs(t2.y - (shot.top - 2)) < 0.2, `drag moved the top 2 px (${t2.y})`);
    const expect2 = yardsFor(7, 26, W, H, (await markAt(page, 'base')).y - t2.y);
    assert(Math.abs((await readYards(page)) - expect2) <= 1, `after the drag: ${await readYards(page)} vs ${expect2.toFixed(1)}`);

    // Keyboard nudges move the focused handle.
    await page.focus('#rf-knob-top');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    const t3 = await markAt(page, 'top');
    assert(Math.abs(t3.y - (t2.y + 2 / v.s)) < 0.01, `two arrow presses move it two screen px (${t2.y} -> ${t3.y})`);

    // Flagstick height is a remembered setting.
    await page.click('#rf-flag-plus');
    eq(await text(page, '#rf-flag-value'), '7.5 ft', 'flagstick 7.5 ft');
    eq(await readYards(page), Math.round(yardsFor(7.5, 26, W, H, (await markAt(page, 'base')).y - t3.y)), 'yards follow the stick height');
    const stored = await page.evaluate((k2) => JSON.parse(localStorage.getItem(k2)).data.profile?.flagHeightFt, KEY);
    eq(stored, 7.5, 'flagstick height saved in the profile');
    await page.click('#rf-flag-minus');

    // Little-endian EXIF, 26 mm written, DigitalZoomRatio 2, 84 px stick: used as written, 84 yd and approximate;
    // the toggle applies the zoom (52 mm, 168 yd).
    const zoomed = await stickJpeg(page, 84);
    await choose(page, file(withExif(zoomed.buf, { le: true, f35: 26, zoom: 2 })));
    await page.waitForFunction(() => !document.querySelector('#rf-mark-top') && document.querySelector('#rf-stage[data-scale]'));
    await zoomTo(page, 2.5);
    await placeBoth(page, zoomed.top, zoomed.bottom);
    eq(await readYards(page), 84, 'focal length used as written');
    eq(await text(page, '#rf-pm'), '± 2 yd', 'plus/minus at 84 px');
    eq(await page.getAttribute('#rf-lens', 'data-source'), 'zoom', 'zoomed photo marked approximate');
    eq(await text(page, '#rf-lens'), 'Approximate: lens 26 mm as the photo states it, zoomed 2x · 7 ft flagstick', 'zoom line, off');
    eq(await page.getAttribute('#rf-apply-zoom', 'aria-pressed'), 'false', 'zoom toggle off by default');
    assert((await text(page, '#rf-zoom-note')).startsWith('This photo was zoomed 2x.'), 'zoom note');
    await page.click('#rf-apply-zoom');
    eq(await readYards(page), 168, 'zoom applied');
    eq(await text(page, '#rf-lens'), 'Approximate: lens 52 mm (26 mm from the photo x 2 zoom) · 7 ft flagstick', 'zoom line, on');
    await page.locator('#rf-zoom-note').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/distance-rangefinder-zoom-light.png` });
    s = await page.evaluate(() => window.__closed);
    assert(s >= 1, 'the previous photo was released when a new one was chosen');

    // No EXIF: the lens picker appears and the result is labelled approximate.
    await choose(page, file(shot.buf));
    await page.waitForSelector('#rf-lens-1x');
    await zoomTo(page, 2.5);
    await placeBoth(page, shot.top, shot.bottom);
    eq(await text(page, '#rf-wait'), 'Pick the lens to read the distance', 'asks for the lens');
    await page.click('#rf-lens-1x');
    eq(await readYards(page), 168, 'guessed 1x gives the same yards');
    eq(await page.getAttribute('#rf-lens', 'data-source'), 'guess', 'marked as a guess');
    eq(await text(page, '#rf-lens'), 'Approximate: lens guessed (1x, 26 mm) · 7 ft flagstick', 'approximate label');
    await page.click('#rf-lens-3x');
    eq(await readYards(page), Math.round(yardsFor(7, 77, W, H, 42)), '3x lens');
    await page.click('#rf-lens-1x');
    await noHorizontalScroll(page, 'rangefinder with a photo');
    await page.locator('#distance-sheet').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.screenshot({ path: `${SHOTS}/distance-rangefinder-guess-light.png` });

    // Mark again clears the marks.
    await page.click('#rf-reset');
    eq(await page.locator('#rf-mark-top').count(), 0, 'marks cleared');

    // An unreadable file: one plain line.
    await choose(page, file(Buffer.from('not a picture at all'), 'broken.jpg'));
    await page.waitForSelector('#rf-error');
    eq(await text(page, '#rf-error'), "This photo can't be read. Try another one, or take a new photo.", 'unreadable photo line');

    // Close: the photo is released and stored nowhere; no location was ever asked for.
    await choose(page, file(withExif(shot.buf, { le: false, f35: 26 })), '#rf-photo');
    await page.waitForSelector('#rf-stage[data-scale]');
    const before = await page.evaluate(() => window.__closed);
    await page.click('#distance-close');
    await page.waitForSelector('#distance-sheet', { state: 'detached' });
    await page.waitForFunction((n) => window.__closed === n, before + 1, { timeout: 3000 })
      .catch(() => { throw new Error('bitmap not released when the sheet closes'); });
    const dump = await page.evaluate(() => Object.keys(localStorage).map((k2) => localStorage.getItem(k2)).join('\n'));
    assert(!/data:image|base64|\/9j\//.test(dump) && dump.length < 20000, 'no image data in localStorage');
    s = await page.evaluate(() => window.__geo);
    eq(s.get + s.watch, 0, 'no geolocation call in the rangefinder');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

async function darkShots(browser, baseURL) {
  const { page, context, errors } = await phone(browser, baseURL, { dark: true });
  try {
    await startRound(page, {});
    await page.locator('#distance-open').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${SHOTS}/hole-screen-distance-button-dark.png` });
    await openSheet(page);
    await page.screenshot({ path: `${SHOTS}/distance-rangefinder-empty-dark.png` });
    const shot = await stickJpeg(page, 42);
    await choose(page, file(withExif(shot.buf, { le: false, f35: 26 })));
    await page.waitForSelector('#rf-stage[data-scale]');
    await zoomTo(page, 2.5);
    await placeBoth(page, shot.top, shot.bottom);
    await page.screenshot({ path: `${SHOTS}/distance-rangefinder-dark.png` });
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

const START = { latitude: 38.25, longitude: -122.04 };
const courseHole = (page, n) => page.evaluate(([k, h]) => {
  const d = JSON.parse(localStorage.getItem(k)).data;
  const r = Object.values(d.rounds).find((x) => x.status === 'active');
  return { green: d.courses['rancho-solano']?.holes.find((x) => x.number === h)?.green ?? null,
    snapshotGreen: r.snapshot.holes.find((x) => x.number === h)?.green ?? null };
}, [KEY, n]);

async function gps(browser, baseURL, dark) {
  const { page, context, errors } = await phone(browser, baseURL, { geo: { ...START, accuracy: 4 }, dark });
  try {
    await startRound(page, {});
    await openSheet(page);
    await page.click('#distance-mode-gps');
    eq((await page.evaluate(() => window.__geo)).watch, 0, 'no geolocation call before the tap');
    await page.click('#gps-start');
    await page.waitForSelector('#gps-no-green');
    eq(await text(page, '#gps-acc'), 'Your location: ± 4 yd. Location stops when you close this.', 'accuracy shown');
    await page.click('#gps-save-green');
    await page.waitForSelector('#gps-yards');
    eq(await text(page, '#gps-saved'), 'Green saved for hole 1.', 'saved line');
    let h = await courseHole(page, 1);
    eq(JSON.stringify(h.green), JSON.stringify({ lat: START.latitude, lon: START.longitude }), 'green on the user copy of the course');
    eq(h.snapshotGreen, null, "the round's snapshot is untouched");
    eq(await text(page, '#gps-yards'), '0', 'at the pin: 0 yd');

    // Walk back 0.001 degrees of latitude (121.6 yd).
    await context.setGeolocation({ latitude: START.latitude - 0.001, longitude: START.longitude, accuracy: 6 });
    await page.waitForFunction(() => document.querySelector('#gps-yards')?.textContent === '122', null, { timeout: 4000 })
    eq(await text(page, '#gps-pm'), '± 7 yd', 'accuracy as plus/minus');

    // Shot measure: mark, walk 0.0005 degrees towards the green (60.8 yd).
    await page.click('#gps-mark-ball');
    eq(await text(page, '#gps-walked'), '0', 'nothing walked yet');
    await context.setGeolocation({ latitude: START.latitude - 0.0005, longitude: START.longitude, accuracy: 6 });
    await page.waitForFunction(() => document.querySelector('#gps-walked')?.textContent === '61');
    eq(await text(page, '#gps-yards'), '61', 'green distance follows');
    await noHorizontalScroll(page, 'gps');
    await page.screenshot({ path: `${SHOTS}/distance-gps-${dark ? 'dark' : 'light'}.png` });

    // Replacing a saved green asks first.
    await page.click('#gps-save-green');
    await page.waitForSelector('#gps-replace-confirm');
    await page.click('#gps-replace-no');
    h = await courseHole(page, 1);
    eq(h.green.lat, START.latitude, 'kept the green');

    // Closing stops the watch; the green is still there next time.
    const geo = await page.evaluate(() => window.__geo);
    eq(geo.watch, 1, 'one watch for the whole session');
    await page.click('#distance-close');
    await page.waitForFunction(() => window.__geo.clear >= 1, null, { timeout: 3000 })
      .catch(() => { throw new Error('watch not cleared when the sheet closes'); });
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

async function refused(browser, baseURL) {
  const { page, context, errors } = await phone(browser, baseURL);
  try {
    await context.clearPermissions();
    await startRound(page, {});
    await openSheet(page);
    await page.click('#distance-mode-gps');
    await page.click('#gps-start');
    await page.waitForSelector('#gps-blocked', { timeout: 5000 });
    eq(await text(page, '#gps-blocked'),
      "This page cannot use your phone's location here. The flagstick rangefinder works everywhere.", 'refused line');
    await page.screenshot({ path: `${SHOTS}/distance-gps-refused-light.png` });
    await page.waitForTimeout(1500);
    const g = await page.evaluate(() => window.__geo);
    eq(g.watch + g.get, 1, 'one call, no loop');
    await page.click('#gps-use-photo');
    assert(await page.locator('#rf-photo').isVisible(), 'back on the rangefinder');
    await page.click('#distance-close');
    await openSheet(page);
    eq(await page.locator('#distance-mode-gps').count(), 0, 'GPS hidden for the rest of the visit');
    assert(await page.locator('#rf-photo').isVisible(), 'rangefinder still there');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

export default async function ({ browser, baseURL }) {
  mkdirSync(SHOTS, { recursive: true });
  await rangefinder(browser, baseURL);
  await darkShots(browser, baseURL);
  await gps(browser, baseURL, false);
  await gps(browser, baseURL, true);
  await refused(browser, baseURL);
}

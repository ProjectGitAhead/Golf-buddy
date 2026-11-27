// T5.2: the hosted copy (dist/site/, GitHub Pages) served from the /Golf-buddy/ sub-path. Checks the files, then in
// a 390 px phone: the page loads, registers its service worker, opens again with the network cut and with a network
// that hangs, refreshes a stale cached page when the network answers, puts GPS first, and tells the truth about
// where scores are kept. The artifact preview never registers a worker.
import { readFileSync, readdirSync } from 'node:fs';
import { assert, eq, startRound, text } from './lib.mjs';

const dir = new URL('../dist/site/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir));

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (buf) => (buf.subarray(1, 4).toString() === 'PNG' ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null);

function files() {
  const names = readdirSync(dir).sort();
  eq(names.join(','), 'apple-touch-icon.png,icon-192.png,icon-512.png,index.html,manifest.webmanifest,sw.js', 'site files');
  eq(String(pngSize(read('icon-192.png'))), '192,192', 'icon-192.png size');
  eq(String(pngSize(read('icon-512.png'))), '512,512', 'icon-512.png size');
  eq(String(pngSize(read('apple-touch-icon.png'))), '180,180', 'apple-touch-icon.png size');

  const page = read('index.html').toString();
  const fragment = readFileSync(new URL('../dist/golf-buddy.html', import.meta.url), 'utf8');
  const style = fragment.match(/<style>([\s\S]*?)<\/style>/)[1];
  const script = fragment.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert(page.startsWith('<!doctype html>'), 'index.html is a full page');
  assert(page.includes(`<style>${style}</style>`) && page.includes(`<script>${script}</script>`), 'same style and script as the artifact');
  for (const tag of [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style"',
    '<meta name="theme-color" media="(prefers-color-scheme: light)"',
    '<meta name="theme-color" media="(prefers-color-scheme: dark)"',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
  ]) assert(page.includes(tag), `index.html has ${tag}`);
  assert(/:root\{padding-top:env\(safe-area-inset-top[^}]*padding-bottom:env\(safe-area-inset-bottom/.test(page), 'safe-area padding on :root');
  assert(page.includes('[hidden]{display:none!important}') && page.includes('img{max-width:100%}'), 'skeleton reset');

  const manifest = JSON.parse(read('manifest.webmanifest').toString());
  eq(manifest.name, 'Golf Buddy', 'manifest name');
  eq(manifest.display, 'standalone', 'manifest display');
  eq(manifest.start_url, './', 'relative start_url');
  eq(manifest.scope, './', 'relative scope');
  for (const i of manifest.icons) assert(names.includes(i.src), `manifest icon ${i.src} exists`);

  const sw = read('sw.js').toString();
  assert(/const CACHE = 'golf-buddy-[0-9a-f]{12}';/.test(sw), 'versioned cache name');

  for (const name of ['index.html', 'manifest.webmanifest', 'sw.js']) {
    const t = read(name).toString();
    assert(!/https?:\/\//i.test(t), `${name}: no absolute URL (works under any sub-path)`);
    assert(!/(href|src)="\//.test(t) && !t.includes('/Golf-buddy'), `${name}: no root-relative path`);
    assert(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(t), `${name}: no email address`);
  }
  assert(!fragment.includes('serviceWorker'), 'no service worker in the artifact fragment');
  return sw.match(/golf-buddy-[0-9a-f]{12}/)[0];
}

export default async function ({ browser, baseURL, siteNetwork }) {
  const cacheName = files();
  // Service workers need a secure context: localhost is one, and the worker registers only there or on https.
  const origin = baseURL.replace('127.0.0.1', 'localhost');
  const url = `${origin}/Golf-buddy/`;

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    // First visit: the app loads from the network and the worker takes control.
    await page.goto(url);
    await page.waitForSelector('.app');
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10_000 });
    eq(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL.endsWith('/Golf-buddy/sw.js')), true, 'worker under the sub-path');
    eq(await page.evaluate(() => typeof window.claude), 'undefined', 'no window.claude in the hosted copy');
    eq((await page.evaluate(() => caches.keys())).join(','), cacheName, 'one cache, named by the build hash');
    const manifest = await page.evaluate(async () => {
      const href = document.querySelector('link[rel="manifest"]').href;
      const res = await fetch(href);
      return { href, type: res.headers.get('content-type'), ok: res.ok };
    });
    assert(manifest.ok && manifest.href.endsWith('/Golf-buddy/manifest.webmanifest'), 'manifest resolves under the sub-path');

    // Storage note: no db here, so the browser on this phone.
    await page.click('#tab-handicap');
    eq(await page.getAttribute('#storage-note', 'data-where'), 'browser', 'storage note context');
    eq(await text(page, '#storage-note'),
      "Your scores are kept in this browser on this phone only. Clearing the browser's data for this site deletes them.",
      'storage note text');

    // GPS is the first tab of the Distance sheet here, and selected.
    await startRound(page, {});
    await page.click('#distance-open');
    await page.waitForSelector('#distance-sheet');
    eq(await page.locator('.ds-modes .chip').first().getAttribute('id'), 'distance-mode-gps', 'GPS is the first tab');
    eq(await page.getAttribute('#distance-mode-gps', 'aria-pressed'), 'true', 'GPS selected on open');
    assert(await page.isVisible('#gps-panel'), 'GPS panel shown');
    await page.click('#distance-close');

    // No signal at all: the page still opens, from the worker's cache, with the round in progress.
    siteNetwork('down');
    await context.setOffline(true);
    const offline = await page.reload();
    await page.waitForSelector('.app');
    assert(offline?.fromServiceWorker(), 'offline load came from the worker');
    await page.waitForSelector('#hole-screen');

    // One bar: requests hang. The cached page shows after the short wait instead of never.
    await context.setOffline(false);
    siteNetwork('slow');
    const t0 = Date.now();
    await page.reload({ timeout: 15_000 });
    await page.waitForSelector('.app');
    const waited = Date.now() - t0;
    assert(waited >= 2500 && waited < 8000, `slow network: cached page after the wait (${waited} ms)`);

    // Never stale for good: with the network back, a stale cached page is replaced by the fresh one.
    siteNetwork('up');
    await page.evaluate(async ([name]) => {
      const c = await caches.open(name);
      await c.put(navigator.serviceWorker.controller.scriptURL.replace(/sw\.js$/, ''), new Response('<p id="stale">old</p>',
        { headers: { 'content-type': 'text/html' } }));
    }, [cacheName]);
    await page.reload();
    await page.waitForSelector('.app');
    await page.waitForFunction(async ([name]) => {
      const c = await caches.open(name);
      const hit = await c.match(location.href);
      return hit ? !(await hit.text()).includes('id="stale"') : false;
    }, [cacheName], { timeout: 5000 });
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    siteNetwork('up');
    await context.close();
  }

  // The artifact preview never registers a worker.
  const plain = await browser.newContext();
  try {
    const p = await plain.newPage();
    await p.goto(`${origin}/preview.html`);
    await p.waitForSelector('.app');
    await p.waitForTimeout(500);
    eq(await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0, 'no worker in the artifact preview');
  } finally {
    await plain.close();
  }
}

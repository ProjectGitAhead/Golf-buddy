// Shared helpers for the e2e specs. Playwright is installed globally (not a dependency of this project).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  try { return require('playwright'); } catch { /* fall through to the global install */ }
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return require(join(root, 'playwright'));
}

export const rancho = JSON.parse(readFileSync(new URL('../src/data/courses/rancho-solano.json', import.meta.url), 'utf8'));

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** WHS rounding used by the app: nearest tenth / whole, .5 up. */
export const tenth = (x) => Math.round(Number((x * 10).toFixed(6))) / 10;
export const whole = (x) => Math.round(Number(x.toFixed(6)));

/** An in-page stand-in for `window.claude` with `db` and `user`, persisted in localStorage under `__mockdb` so it
 *  survives reloads like the real store. Enforces the document / collection path parity of the real capability. */
function installMockClaude({ uid }) {
  const KEY = '__mockdb';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  const save = (m) => localStorage.setItem(KEY, JSON.stringify(m));
  const parts = (p) => p.split('/').length;
  const docRef = (path) => {
    if (parts(path) % 2 !== 0) throw new TypeError(`document path needs an even number of segments: ${path}`);
    return {
      id: path.split('/').pop(), path,
      get: async () => { const m = load(); return { id: path.split('/').pop(), exists: path in m, data: () => m[path], metadata: {} }; },
      set: async (d) => { const m = load(); m[path] = JSON.parse(JSON.stringify(d)); save(m); },
      update: async (d) => { const m = load(); m[path] = { ...m[path], ...d }; save(m); },
      delete: async () => { const m = load(); delete m[path]; save(m); },
    };
  };
  const collRef = (path) => {
    if (parts(path) % 2 !== 1) throw new TypeError(`collection path needs an odd number of segments: ${path}`);
    return {
      path,
      doc: (id) => docRef(`${path}/${id}`),
      get: async () => {
        const m = load();
        const docs = Object.keys(m).filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
          .map((p) => ({ id: p.split('/').pop(), exists: true, data: () => m[p], metadata: {} }));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  };
  const db = Object.freeze({ doc: docRef, collection: collRef });
  const user = Object.freeze({ id: async () => uid });
  window.claude = { use: async (name) => (name === 'db' ? db : name === 'user' ? user : null) };
}

/** A fresh phone-sized page. `mock: true` installs the mocked capabilities before any page script runs. */
export async function newPage(browser, baseURL, { width = 390, height = 844, mock = false, dark = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true,
    colorScheme: dark ? 'dark' : 'light' });
  if (mock) await context.addInitScript(installMockClaude, { uid: 'u-test' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${baseURL}/preview.html`);
  await page.waitForSelector('.app');
  return { page, context, errors };
}

export async function text(page, sel) {
  return (await page.locator(sel).first().textContent())?.trim() ?? '';
}

/** Starts a round from the Play tab. */
export async function startRound(page, { courseId = 'rancho-solano', teeId = 'white-m', holes = '18', index } = {}) {
  await page.click('#tab-play');
  await page.waitForSelector('#start-round');
  await page.selectOption('#course-select', courseId);
  await page.click(`#tee-${teeId}`);
  await page.click(`#holes-${holes}`);
  if (index !== undefined) {
    await page.fill('#starting-index', String(index));
    await page.locator('#starting-index').blur();
  }
  await page.click('#start-round-btn');
  await page.waitForSelector('#hole-screen');
}

/** Sets the current hole's strokes with the stepper (starting from the par preset) and moves on. */
export async function setStrokes(page, strokes, par) {
  if (strokes === par) await page.click('#stroke-value');
  else {
    const btn = strokes > par ? '#stroke-plus' : '#stroke-minus';
    for (let i = 0; i < Math.abs(strokes - par); i++) await page.click(btn);
  }
}

/** No horizontal page scroll. */
export async function noHorizontalScroll(page, where) {
  const over = await page.evaluate(() => {
    const d = document.documentElement;
    const main = document.getElementById('main');
    return Math.max(d.scrollWidth - d.clientWidth, main ? main.scrollWidth - main.clientWidth : 0);
  });
  assert(over <= 0, `${where}: content is ${over}px wider than the screen`);
}

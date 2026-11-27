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
  const listeners = [];
  const list = (path, m) => Object.keys(m).filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
    .map((p) => ({ id: p.split('/').pop(), exists: true, data: () => m[p], metadata: {} }));
  const snapOf = (path) => { const docs = list(path, load()); return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false } }; };
  const save = (m) => {
    localStorage.setItem(KEY, JSON.stringify(m));
    setTimeout(() => { for (const l of listeners) l.next(snapOf(l.path)); }, 0);
  };
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
      get: async () => snapOf(path),
      onSnapshot: (next) => {
        const l = { path, next };
        listeners.push(l);
        setTimeout(() => next(snapOf(path)), 0);
        return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
      },
    };
  };
  const db = Object.freeze({ doc: docRef, collection: collRef });
  const user = Object.freeze({ id: async () => uid });
  window.claude = { use: async (name) => (name === 'db' ? db : name === 'user' ? user : null) };
}

/** In-page half of the shared mock db: every call goes to the Node side through the `__sharedDb` binding, and
 *  snapshots come back through `window.__sharedDbDeliver`. */
function installSharedClaude({ uid }) {
  const listeners = new Map();   // collection path -> Set of next callbacks
  const snap = (docs) => ({
    docs: docs.map((d) => ({ id: d.id, exists: true, data: () => d.data, metadata: { fromCache: false, hasPendingWrites: false } })),
    size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [],
  });
  window.__sharedDbDeliver = (path, docs) => { for (const fn of listeners.get(path) ?? []) fn(snap(docs)); };
  const call = (...args) => window.__sharedDb(...args);
  const parts = (p) => p.split('/').length;
  const docRef = (path) => {
    if (parts(path) % 2 !== 0) throw new TypeError(`document path needs an even number of segments: ${path}`);
    return {
      id: path.split('/').pop(), path,
      get: async () => { const d = await call('get', path); return { id: path.split('/').pop(), exists: d !== null, data: () => d ?? undefined, metadata: {} }; },
      set: async (d) => { await call('set', path, JSON.parse(JSON.stringify(d))); },
      delete: async () => { await call('delete', path); },
    };
  };
  const collRef = (path) => {
    if (parts(path) % 2 !== 1) throw new TypeError(`collection path needs an odd number of segments: ${path}`);
    return {
      path,
      doc: (id) => docRef(`${path}/${id}`),
      get: async () => snap(await call('list', path)),
      onSnapshot: (next) => {
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(next);
        void call('listen', path);
        return () => listeners.get(path)?.delete(next);
      },
    };
  };
  const db = Object.freeze({ doc: docRef, collection: collRef });
  const user = Object.freeze({ id: async () => uid });
  window.claude = { use: async (name) => (name === 'db' ? db : name === 'user' ? user : null) };
}

/**
 * One mocked db shared by several browser contexts (two devices of one player). `device()` opens a context on it;
 * `pause()` stops that device hearing live updates (a view that missed them), `resume()` delivers what it missed.
 */
export function sharedDb() {
  const docs = new Map();
  const devices = new Set();
  const list = (path) => [...docs.entries()]
    .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
    .map(([p, data]) => ({ id: p.split('/').pop(), data }));
  const deliver = async (dev, path) => {
    for (const page of dev.context.pages()) {
      try { await page.evaluate(([p, d]) => window.__sharedDbDeliver?.(p, d), [path, list(path)]); } catch { /* closed */ }
    }
  };
  const changed = (docPath) => {
    const coll = docPath.slice(0, docPath.lastIndexOf('/'));
    for (const dev of devices) if (!dev.paused && dev.listening.has(coll)) void deliver(dev, coll);
  };
  return {
    docs,
    get: (path) => docs.get(path),
    async device(browser, baseURL) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
      const dev = { context, paused: false, listening: new Set() };
      devices.add(dev);
      await context.exposeBinding('__sharedDb', async (_src, op, path, body) => {
        if (op === 'get') return docs.has(path) ? structuredClone(docs.get(path)) : null;
        if (op === 'list') return list(path);
        if (op === 'set') { docs.set(path, structuredClone(body)); changed(path); return null; }
        if (op === 'delete') { docs.delete(path); changed(path); return null; }
        if (op === 'listen') { dev.listening.add(path); if (!dev.paused) setTimeout(() => void deliver(dev, path), 0); return null; }
        throw new Error(`unknown op ${op}`);
      });
      await context.addInitScript(installSharedClaude, { uid: 'u-test' });
      const errors = [];
      const open = async () => {
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        await page.goto(`${baseURL}/preview.html`);
        await page.waitForSelector('.app');
        return page;
      };
      return {
        context, errors, open,
        pause() { dev.paused = true; },
        async resume() { dev.paused = false; for (const p of dev.listening) await deliver(dev, p); },
      };
    },
  };
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

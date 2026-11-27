// npm run e2e: builds, serves dist/ on port 4610 (E2E_PORT to change), runs every e2e/*.spec.mjs against
// dist/preview.html, prints one PASS / FAIL line per spec, and exits non-zero on any failure.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');
const port = Number(process.env.E2E_PORT) || 4610;
const only = process.argv[2];

const built = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
if (built.status !== 0) { console.log('FAIL build'); process.exit(1); }

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = normalize(join(dist, path === '/' ? 'preview.html' : path));
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
const baseURL = `http://127.0.0.1:${port}`;

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const specs = readdirSync(here).filter((f) => f.endsWith('.spec.mjs') && (!only || f.includes(only))).sort();
let failed = 0;
for (const f of specs) {
  const name = f.replace('.spec.mjs', '');
  const t0 = Date.now();
  try {
    const mod = await import(join(here, f));
    await mod.default({ browser, baseURL });
    console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    const lines = (e instanceof Error ? e.message : String(e)).replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    const where = lines.find((l) => l.includes('locator(') || l.includes('waiting for')) ?? '';
    console.log(`FAIL ${name}: ${lines[0]}${where ? ` (${where.trim()})` : ''}`);
  }
}
await browser.close();
server.close();
console.log(failed ? `${failed} of ${specs.length} specs failed` : `All ${specs.length} specs passed`);
process.exit(failed ? 1 : 0);

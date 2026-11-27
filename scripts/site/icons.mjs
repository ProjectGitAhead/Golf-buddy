// Rasterises scripts/site/icon.svg into the three PNG icons of the hosted copy (npm run icons). The PNGs are
// committed and the build only copies them, so the build needs no browser (GitHub Actions has no Playwright).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../../e2e/lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, 'icon.svg'), 'utf8');
const SIZES = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180 };

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
try {
  for (const [name, size] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block}</style>${sized}`);
    writeFileSync(join(here, name), await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } }));
    await page.close();
    console.log(`scripts/site/${name} ${size}x${size}`);
  }
} finally {
  await browser.close();
}

// Builds the app into one self-contained HTML fragment (dist/golf-buddy.html, published as the Artifact), a
// full page around it for local use (dist/preview.html), and the hosted copy for GitHub Pages (dist/site/: the same
// style and script as a full page, with manifest, icons and service worker; see plan section 13).
//   node scripts/build.mjs            build
//   node scripts/build.mjs --serve    build, then serve dist/ on $PORT (default 4610)
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const siteSrc = join(root, 'scripts/site');
const ICONS = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const MAX_BYTES = 1024 * 1024;

// Used until src/ui/styles.css exists. Follows the page contract: tokens on :root, dark mode twice, explicit body bg.
const BASE_CSS = `
:root{--bg:#f6f7f4;--surface:#ffffff;--text:#16211a;--muted:#5b675f;--accent:#1f7a45;
font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0f1511;--surface:#18211b;--text:#e8efe9;
--muted:#9fb0a4;--accent:#5cc488;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0f1511;--surface:#18211b;--text:#e8efe9;--muted:#9fb0a4;--accent:#5cc488;color-scheme:dark}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text)}
.gb-app{padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));
padding-block:16px}
.gb-title{margin:0;font-size:1.5rem;color:var(--accent)}
`;

async function bundle() {
  const result = await build({
    entryPoints: [join(root, 'src/main.tsx')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020', 'safari15'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  });
  let js = result.outputFiles[0].text;
  // Namespace strings such as the SVG namespace contain "://" but are never fetched. Escape the slashes inside the
  // script so the fragment holds no URL text at all; the runtime string is unchanged ("\/" is "/").
  js = js.replaceAll('://', ':\\/\\/');
  // Keep the inline script from closing its own tag.
  return js.replaceAll('</script', '<\\/script');
}

function css() {
  const file = join(root, 'src/ui/styles.css');
  return existsSync(file) ? readFileSync(file, 'utf8') : BASE_CSS;
}

export async function buildAll() {
  const js = await bundle();
  const fragment = [
    '<title>Golf Buddy</title>',
    '<meta name="claude:viewport-fit-sides" content="cover">',
    `<style>${css().trim()}</style>`,
    '<div id="golf-buddy"></div>',
    `<script>${js.trim()}</script>`,
    '',
  ].join('\n');

  const problems = [];
  if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(fragment)) problems.push('document tags in the fragment');
  if (/https?:\/\//i.test(fragment)) problems.push('a URL in the fragment');
  if (/serviceWorker/.test(fragment)) problems.push('service worker code in the fragment');
  const bytes = Buffer.byteLength(fragment);
  if (bytes > MAX_BYTES) problems.push(`fragment is ${bytes} bytes (limit ${MAX_BYTES})`);
  if (problems.length) throw new Error(`Build refused: ${problems.join('; ')}`);

  const preview = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '</head>',
    '<body>',
    fragment,
    '</body>',
    '</html>',
    '',
  ].join('\n');

  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'golf-buddy.html'), fragment);
  writeFileSync(join(dist, 'preview.html'), preview);
  buildSite(css().trim(), js.trim());
  console.log(`dist/golf-buddy.html ${(bytes / 1024).toFixed(1)} KB · dist/preview.html · dist/site/`);
}

/** dist/site/: index.html, manifest.webmanifest, the three icons (committed PNGs, made by `npm run icons`) and
 *  sw.js. Every URL in it is relative, so it works under any sub-path (GitHub Pages serves it at /Golf-buddy/). */
function buildSite(style, script) {
  const out = join(dist, 'site');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const fill = (text, marker, value) => {
    if (!text.includes(marker)) throw new Error(`Build refused: ${marker} missing from the site template`);
    return text.replace(marker, () => value);
  };
  let page = readFileSync(join(siteSrc, 'index.html'), 'utf8');
  page = fill(page, '/*APP_STYLE*/', style);
  page = fill(page, '/*APP_SCRIPT*/', script);
  const manifest = JSON.stringify({
    name: 'Golf Buddy',
    short_name: 'Golf Buddy',
    description: 'Score your rounds, track your handicap index and measure distances on the course.',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#f1efe6',
    theme_color: '#f1efe6',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2) + '\n';

  const hash = createHash('sha256').update(page).update(manifest);
  for (const icon of ICONS) {
    const file = join(siteSrc, icon);
    if (!existsSync(file)) throw new Error(`Build refused: scripts/site/${icon} is missing (run npm run icons)`);
    hash.update(readFileSync(file));
    copyFileSync(file, join(out, icon));
  }
  const sw = fill(readFileSync(join(siteSrc, 'sw.js'), 'utf8'), '__VERSION__', hash.digest('hex').slice(0, 12));

  writeFileSync(join(out, 'index.html'), page);
  writeFileSync(join(out, 'manifest.webmanifest'), manifest);
  writeFileSync(join(out, 'sw.js'), sw);
  for (const [name, text] of [['index.html', page], ['manifest.webmanifest', manifest], ['sw.js', sw]]) {
    if (/https?:\/\//i.test(text)) throw new Error(`Build refused: a URL in dist/site/${name}`);
  }
}

export const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

/** Maps a request path to a file in dist/: `/` is the preview page, `/Golf-buddy/…` is dist/site/ (the sub-path
 *  GitHub Pages uses). Returns null for anything outside dist/ or missing. */
export function resolveDist(urlPath) {
  const path = decodeURIComponent(urlPath.split('?')[0]);
  const site = path.match(/^\/Golf-buddy(\/.*)?$/);
  const file = site
    ? normalize(join(dist, 'site', !site[1] || site[1] === '/' ? 'index.html' : site[1]))
    : normalize(join(dist, path === '/' ? 'preview.html' : path));
  return file.startsWith(dist) && existsSync(file) && statSync(file).isFile() ? file : null;
}

export const typeOf = (file) => TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';

function serve(port) {
  createServer((req, res) => {
    const file = resolveDist(req.url ?? '/');
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': typeOf(file), 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  }).listen(port, '127.0.0.1', () => console.log(`Serving dist/ on port ${port} (hosted copy at /Golf-buddy/)`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAll();
  if (process.argv.includes('--serve')) serve(Number(process.env.PORT) || 4610);
}

// Builds the app into one self-contained HTML fragment (dist/golf-buddy.html, published as the Artifact) and a
// full page around it for local use (dist/preview.html).
//   node scripts/build.mjs            build
//   node scripts/build.mjs --serve    build, then serve dist/ on $PORT (default 4610)
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
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
  console.log(`dist/golf-buddy.html ${(bytes / 1024).toFixed(1)} KB · dist/preview.html`);
}

function serve(port) {
  createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = normalize(join(dist, path === '/' ? 'preview.html' : path));
    if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  }).listen(port, '127.0.0.1', () => console.log(`Serving dist/ on port ${port}`));
}

await buildAll();
if (process.argv.includes('--serve')) serve(Number(process.env.PORT) || 4610);

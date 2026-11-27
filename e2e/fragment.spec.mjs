// The published fragment obeys the page contract (plan section 2).
import { readFileSync } from 'node:fs';
import { assert, eq } from './lib.mjs';
import { ALLOWED_URLS, strayUrls } from '../scripts/build.mjs';

export default async function () {
  const html = readFileSync(new URL('../dist/golf-buddy.html', import.meta.url), 'utf8');
  assert(html.startsWith('<title>Golf Buddy</title>\n<meta name="claude:viewport-fit-sides" content="cover">'),
    'starts with the title and viewport-fit meta');
  assert(!/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html), 'no document tags');
  assert(!/https?:\/\//i.test(html), 'no URL text');
  // T6.1: the only addresses the app can contact are the two OpenStreetMap Overpass servers and the attribution link.
  eq(strayUrls(html).join(', '), '', 'addresses outside the allowed list');
  for (const u of ALLOWED_URLS) assert(html.includes(u.replace('://', ':\\/\\/')), `${u} is the one allowed form`);
  assert(strayUrls('fetch("https:\\/\\/example.com/x")').length === 1, 'the address check catches an escaped URL');
  assert((html.match(/<style>/g) ?? []).length === 1 && (html.match(/<script>/g) ?? []).length === 1, 'one style, one script');
  assert(Buffer.byteLength(html) < 1024 * 1024, 'under 1 MB');
  for (const banned of ['window.print', 'mailto:', 'serviceWorker', ' download=', '100vh']) {
    assert(!html.includes(banned), `fragment uses ${banned}`);
  }
}

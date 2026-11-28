// Checks deploy/nginx.conf with a real nginx binary (plan section 16.2), so a mistake shows before the Docker build.
//   node scripts/check-nginx.mjs            (needs `nginx` on PATH; says so and exits 0 when there is none)
// 1. `nginx -t` on the file as it ships, inside a minimal main config like the image's.
// 2. A working copy on a free local port, with the four Overpass servers replaced by local stand-ins (plain http,
//    127.0.0.1): fail-over on 429 / 5xx / 406 with the POST body forwarded, the answer cached by request body,
//    POST only, the body size limit, the per-client rate limit (Fly-Client-IP) and the static site.
// The stand-ins cannot show TLS, SNI, DNS or the real servers' answers: those are only exercised on Fly.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONF = join(root, 'deploy/nginx.conf');
const HOSTS = ['overpass-api.de', 'overpass.private.coffee', 'overpass.kumi.systems', 'maps.mail.ru'];

function main(dir, site, extra = '') {
  // Run as root (as in this container), workers would switch to an unprivileged user that can't read the temp folder.
  const user = process.getuid?.() === 0 ? 'user root;\n' : '';
  return `${user}pid ${dir}/nginx.pid;\nerror_log ${dir}/error.log warn;\nevents { worker_connections 64; }\n`
    + `http {\n  access_log off;\n  default_type application/octet-stream;\n  client_body_temp_path ${dir}/body;\n`
    + `  proxy_temp_path ${dir}/proxy;\n  fastcgi_temp_path ${dir}/fcgi;\n  uwsgi_temp_path ${dir}/uwsgi;\n  scgi_temp_path ${dir}/scgi;\n`
    + `${extra}  include ${site};\n}\n`;
}

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));

/** A stand-in Overpass server. `plan` is a queue of statuses (200 answers with JSON naming the server). */
function standIn(name) {
  const s = { name, plan: [], seen: [] };
  s.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      s.seen.push({ method: req.method, url: req.url, body, ua: req.headers['user-agent'], cookie: req.headers.cookie });
      const status = s.plan.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': 'x=1', 'cache-control': 'no-store' });
      res.end(status === 200 ? JSON.stringify({ elements: [], from: name }) : 'busy');
    });
  });
  return s;
}

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };

async function run() {
  if (spawnSync('nginx', ['-v']).error) { console.log('No nginx binary on this machine: nothing checked. The Docker build runs `nginx -t`.'); return; }
  console.log(spawnSync('nginx', ['-v'], { encoding: 'utf8' }).stderr.trim());
  const dir = mkdtempSync(join(tmpdir(), 'gb-nginx-'));
  try {
    for (const d of ['body', 'proxy', 'fcgi', 'uwsgi', 'scgi', 'cache', 'html']) mkdirSync(join(dir, d));
    const text = readFileSync(CONF, 'utf8');

    // 1. The file as it ships. Only the cache folder moves (no write access to /var/cache needed), and the IPv6
    //    listen goes when this machine has no IPv6 (`nginx -t` opens the sockets).
    const v6 = spawnSync(process.execPath, ['-e', "require('net').createServer().listen(0,'::1').on('listening',function(){this.close()}).on('error',()=>process.exit(1))"]).status === 0;
    if (!v6) console.log('(no IPv6 here: the [::]:8080 listen line is left out of the test)');
    writeFileSync(join(dir, 'as-shipped.conf'), text.replace('/var/cache/nginx/osm', `${dir}/cache`)
      .replace(v6 ? '\0' : 'listen [::]:8080;', ''));
    writeFileSync(join(dir, 'test.conf'), main(dir, join(dir, 'as-shipped.conf')));
    const t = spawnSync('nginx', ['-t', '-q', '-p', dir, '-c', join(dir, 'test.conf')], { encoding: 'utf8' });
    check(t.status === 0, `nginx -t on deploy/nginx.conf${t.status === 0 ? '' : `: ${t.stderr.trim()}`}`);
    if (t.status !== 0) return;

    // 2. A working copy against local stand-ins.
    const ups = HOSTS.map(standIn);
    const ports = await Promise.all(ups.map((u) => listen(u.server)));
    const probe = createServer(); const port = await listen(probe); await new Promise((ok) => probe.close(ok));
    let local = text.replace('/var/cache/nginx/osm', `${dir}/cache`)
      .replace('listen 8080;', `listen 127.0.0.1:${port};`).replace('listen [::]:8080;', '')
      .replace('root /usr/share/nginx/html;', `root ${dir}/html;`)
      .replaceAll('proxy_pass https://', 'proxy_pass http://');
    HOSTS.forEach((h, i) => { local = local.replace(`set $osm_host ${h};`, `set $osm_host 127.0.0.1:${ports[i]};`); });
    check(HOSTS.every((_, i) => local.includes(`127.0.0.1:${ports[i]}`)), 'the four servers found in the file, in order');
    writeFileSync(join(dir, 'html/index.html'), '<p>site</p>');
    writeFileSync(join(dir, 'local.conf'), local);
    writeFileSync(join(dir, 'run.conf'), main(dir, join(dir, 'local.conf')));
    const ng = spawn('nginx', ['-p', dir, '-c', join(dir, 'run.conf'), '-g', 'daemon off;'], { stdio: 'inherit' });
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 50; i++) {
        try { await fetch(base); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); }
      }
      const reset = () => ups.forEach((u) => { u.plan = []; u.seen = []; });
      const ask = (body, ip, init = {}) => fetch(`${base}/api/osm`, { method: 'POST', body,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'fly-client-ip': ip, cookie: 'session=1' }, ...init });
      const hits = () => ups.map((u) => u.seen.length).join(',');

      reset(); ups[0].plan = [429];
      let r = await ask('data=one', '198.51.100.1');
      let j = await r.json().catch(() => null);
      check(r.status === 200 && j?.from === HOSTS[1], `first server busy (429): the second answers (status ${r.status}, from ${j?.from})`);
      check(hits() === '1,1,0,0', `each asked once (${hits()})`);
      check(ups[1].seen[0]?.method === 'POST' && ups[1].seen[0]?.body === 'data=one', 'the POST body is forwarded on fail-over');
      check(ups[1].seen[0]?.url === '/api/interpreter', `path on the server (${ups[1].seen[0]?.url})`);
      check(/^GolfBuddy\/.*Golf-buddy\)$/.test(ups[0].seen[0]?.ua ?? ''), `User-Agent names the app (${ups[0].seen[0]?.ua})`);
      check(!ups[0].seen[0]?.cookie, 'no cookie forwarded');
      check(r.headers.get('x-cache-status') === 'MISS' && !r.headers.get('set-cookie'), `MISS, no Set-Cookie (${r.headers.get('x-cache-status')})`);

      reset();
      r = await ask('data=one', '198.51.100.2');
      j = await r.json().catch(() => null);
      check(r.status === 200 && j?.from === HOSTS[1] && hits() === '0,0,0,0' && r.headers.get('x-cache-status') === 'HIT',
        `the same query again comes from the cache (${r.headers.get('x-cache-status')}, servers ${hits()})`);
      r = await ask('data=two', '198.51.100.2');
      check(r.status === 200 && hits() === '1,0,0,0', `a different query is not a cache hit (servers ${hits()})`);

      reset(); ups[0].plan = [503]; ups[1].plan = [502]; ups[2].plan = [406];
      r = await ask('data=three', '198.51.100.3');
      j = await r.json().catch(() => null);
      check(r.status === 200 && j?.from === HOSTS[3] && hits() === '1,1,1,1', `503, 502, 406: the fourth answers (${r.status}, ${hits()})`);
      check(ups[3].seen[0]?.url === '/osm/tools/overpass/api/interpreter' && ups[3].seen[0]?.body === 'data=three', `fourth server path and body (${ups[3].seen[0]?.url})`);

      // The first server not listening at all (nginx's own 502): the next one is asked.
      reset();
      await new Promise((ok) => ups[0].server.close(ok));
      r = await ask('data=closed', '198.51.100.8');
      j = await r.json().catch(() => null);
      check(r.status === 200 && j?.from === HOSTS[1], `first server unreachable: the second answers (${r.status}, from ${j?.from})`);
      await new Promise((ok) => ups[0].server.listen(ports[0], '127.0.0.1', ok));

      reset(); ups.forEach((u) => { u.plan = [429, 429]; });
      r = await ask('data=four', '198.51.100.4');
      check(r.status === 429 && hits() === '1,1,1,1', `every server busy: the last status comes back (${r.status}, ${hits()})`);
      r = await ask('data=four', '198.51.100.4');
      check(hits() === '2,2,2,2', 'a failed answer is not cached');

      reset();
      r = await fetch(`${base}/api/osm`);
      check(r.status === 405 && hits() === '0,0,0,0', `GET is refused (${r.status})`);
      r = await ask(`data=${'x'.repeat(17 * 1024)}`, '198.51.100.5');
      check(r.status === 413 && hits() === '0,0,0,0', `a body over 16 KB is refused (${r.status})`);

      reset();
      const statuses = [];
      for (let i = 0; i < 8; i++) statuses.push((await ask(`data=rate${i}`, '198.51.100.6')).status);
      check(statuses.slice(0, 6).every((s) => s === 200) && statuses.slice(6).every((s) => s === 429),
        `one client: 6 at once pass, then 429 (${statuses.join(' ')})`);
      check(hits() === '6,0,0,0', `the rate limit's 429 is not passed to the next server (${hits()})`);
      r = await ask('data=other-client', '198.51.100.7');
      check(r.status === 200, 'another client is not limited');

      r = await fetch(`${base}/`);
      check(r.status === 200 && (await r.text()).includes('site') && r.headers.get('cache-control') === 'no-cache', 'the site is still served');
      r = await fetch(`${base}/nope.js`);
      check(r.status === 404, 'unknown paths are 404');
    } finally {
      ng.kill('SIGQUIT');
      await new Promise((ok) => ng.once('exit', ok));
      ups.forEach((u) => u.server.close());
    }
  } catch (e) {
    failures++;
    console.log(`FAIL the local test stopped: ${e instanceof Error ? e.message : e}`);
  } finally {
    if (failures) { try { console.log(readFileSync(join(dir, 'error.log'), 'utf8').trim().split('\n').slice(-8).join('\n')); } catch { /* none */ } }
    rmSync(dir, { recursive: true, force: true });
  }
}

await run();
console.log(failures ? `${failures} nginx checks failed` : 'nginx checks done');
process.exitCode = failures ? 1 : 0;

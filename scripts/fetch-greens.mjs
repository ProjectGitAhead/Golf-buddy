// Bakes a bundled course's green positions into the build (plan section 15.3), so live yardage works on the course
// with no lookup from the phone.
//   node scripts/fetch-greens.mjs <courseId>
// Reads src/data/courses/<courseId>.json (it needs `location`), asks the OpenStreetMap Overpass servers in order
// (2,500 m around the course, 25 s each), matches greens to holes with the app's own src/core/greens.ts, and writes
// src/data/courses/<courseId>.greens.json. The log says what each server answered, what came back, which holes
// matched and where each green is. It never fails the build: on any problem it keeps the existing greens file and
// exits 0. Plain node 22 (global fetch); the app's TypeScript is bundled with esbuild when the script starts.
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD_RADIUS_M = 2500;
export const BUILD_TIMEOUT_MS = 25_000;

/** The app's matcher and Overpass client, bundled from src/ for node. */
export async function loadLib() {
  const r = await build({
    stdin: {
      contents: "export { matchGreens } from './src/core/greens.ts';\n"
        + "export { runQuery, overpassQuery, host } from './src/net/overpass.ts';\n",
      resolveDir: root, loader: 'ts', sourcefile: 'fetch-greens-lib.ts',
    },
    bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false, logLevel: 'warning',
  });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}

/** The files the script touches (a test passes an in-memory stand-in). */
const disk = {
  exists: (f) => existsSync(f),
  read: (f) => readFileSync(f, 'utf8'),
  write: (f, text) => writeFileSync(f, text),
};

/**
 * Looks up and writes one course's greens. `lib` is { matchGreens, runQuery, overpassQuery, host } (loadLib(), or
 * the TypeScript modules in a test). Returns { written, matched, missing }.
 */
export async function fetchGreens({ course, lib, outFile, fetchImpl, log = console.log, now = () => new Date(), io = disk }) {
  const countHoles = (f) => {
    try { return Object.keys(JSON.parse(io.read(f)).holes ?? {}).length; } catch { return 0; }
  };
  const keep = () => (io.exists(outFile) ? `Keeping the existing greens file (${countHoles(outFile)} holes).` : 'No greens file written.');
  if (!course.location) {
    log(`${course.id}: the course file has no location, so there is nothing to look up. ${keep()}`);
    return { written: false, matched: 0, missing: course.holes.map((h) => h.number) };
  }
  const { lat, lon } = course.location;
  log(`Greens for ${course.name}: asking OpenStreetMap within ${BUILD_RADIUS_M} m of ${lat}, ${lon}`);
  let answer;
  try {
    answer = await lib.runQuery(lib.overpassQuery(lat, lon, BUILD_RADIUS_M), {
      fetchImpl, timeoutMs: BUILD_TIMEOUT_MS,
      onAttempt: (a) => log(`  ${lib.host(a.url)}: ${a.detail ?? 'failed'} (${(a.ms / 1000).toFixed(1)} s)`),
    });
  } catch {
    log(`No server gave a usable answer. ${keep()}`);
    return { written: false, matched: 0, missing: course.holes.map((h) => h.number) };
  }
  const els = answer.elements;
  const holeWays = els.filter((e) => e.type === 'way' && e.tags?.golf === 'hole').length;
  const greenWays = els.filter((e) => e.type === 'way' && e.tags?.golf === 'green').length;
  const greenRels = els.filter((e) => e.type === 'relation' && e.tags?.golf === 'green').length;
  log(`Answer: ${holeWays} golf=hole ways, ${greenWays + greenRels} golf=green polygons (${greenWays} ways, ${greenRels} relations)`);

  const numbers = course.holes.map((h) => h.number);
  const r = lib.matchGreens(els, { lat, lon }, numbers);
  log(`Matched ${r.greens.size} of ${numbers.length}`);
  log(`Missing holes: ${r.missing.length ? r.missing.join(', ') : 'none'}`);
  const found = [...r.greens].sort((a, b) => a[0] - b[0]);
  for (const [n, g] of found) {
    log(`  hole ${n}: green centre ${g.centre.lat.toFixed(6)}, ${g.centre.lon.toFixed(6)} (${g.outline.length} outline points)`);
  }
  const before = io.exists(outFile) ? countHoles(outFile) : 0;
  if (!found.length || found.length < before) {
    log(`${found.length ? 'Fewer holes than the file already has.' : 'Nothing matched.'} ${keep()}`);
    return { written: false, matched: found.length, missing: r.missing };
  }
  const file = {
    fetchedAt: now().toISOString(),
    source: `OpenStreetMap contributors, via ${lib.host(answer.attempts[answer.attempts.length - 1].url)}`,
    holes: Object.fromEntries(found.map(([n, g]) => [String(n), { green: g.centre, greenShape: g.outline }])),
  };
  io.write(outFile, JSON.stringify(file, null, 1) + '\n');
  log(`Wrote ${outFile.startsWith(root) ? outFile.slice(root.length + 1) : outFile} (${found.length} holes)`);
  return { written: true, matched: found.length, missing: r.missing };
}

async function main(courseId) {
  if (!courseId || !/^[a-z0-9-]+$/.test(courseId)) { console.log('Usage: node scripts/fetch-greens.mjs <courseId>'); return; }
  const dir = join(root, 'src/data/courses');
  const courseFile = join(dir, `${courseId}.json`);
  if (!existsSync(courseFile)) { console.log(`No course file src/data/courses/${courseId}.json`); return; }
  const course = JSON.parse(readFileSync(courseFile, 'utf8'));
  await fetchGreens({ course, lib: await loadLib(), outFile: join(dir, `${courseId}.greens.json`) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv[2]);
  } catch (e) {
    console.log(`Green lookup stopped: ${e instanceof Error ? e.message : e}. The build goes on with the existing greens file.`);
  }
  process.exitCode = 0;
}

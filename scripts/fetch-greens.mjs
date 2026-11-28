// Bakes a bundled course's green positions and its bunkers and water into the build (plan sections 15.3 and 16.1),
// so live yardage works on the course with no lookup from the phone.
//   node scripts/fetch-greens.mjs <courseId>
// Reads src/data/courses/<courseId>.json (it needs `location`), asks the OpenStreetMap Overpass servers in order
// (2,500 m around the course, 25 s each), matches greens to holes with the app's own src/core/greens.ts, and writes
// src/data/courses/<courseId>.greens.json. The log says what each server answered, what came back, which holes
// matched, where each green is and how many hazards each hole has. It never fails the build: on any problem it keeps the existing greens file and
// exits 0. Plain node 22 (global fetch); the app's TypeScript is bundled with esbuild when the script starts.
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD_RADIUS_M = 2500;
export const BUILD_TIMEOUT_MS = 25_000;
/** The greens file stays under this size; hazard outlines are simplified further until it does. */
export const MAX_FILE_BYTES = 200 * 1024;

/** The app's matcher and Overpass client, bundled from src/ for node. */
export async function loadLib() {
  const r = await build({
    stdin: {
      contents: "export { matchGreens, simplifyRing } from './src/core/greens.ts';\n"
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

/** The file as JSON, one point per line (a point on 4 lines would make a file with hazards several times larger). */
export function formatGreensFile(file) {
  return JSON.stringify(file, null, 1).replace(/\[\s*(-?[\d.e+-]+),\s*(-?[\d.e+-]+)\s*\]/g, '[$1, $2]') + '\n';
}

/** Hazards with every outline cut to at most `max` points (the matcher already keeps 30 at most). */
function thinHazards(lib, hazards, max) {
  return hazards.map((h) => ({ kind: h.kind, shape: h.shape.length <= max ? h.shape
    : lib.simplifyRing(h.shape.map(([lat, lon]) => ({ lat, lon })), max).map((p) => [p.lat, p.lon]) }));
}

/**
 * Looks up and writes one course's greens. `lib` is { matchGreens, simplifyRing, runQuery, overpassQuery, host } (loadLib(), or
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
  const bunkers = els.filter((e) => e.tags?.golf === 'bunker').length;
  const water = els.filter((e) => e.tags?.natural === 'water' || e.tags?.golf === 'water_hazard' || e.tags?.golf === 'lateral_water_hazard').length;
  log(`Hazards in the answer: ${bunkers} bunkers, ${water} water`);

  const numbers = course.holes.map((h) => h.number);
  const r = lib.matchGreens(els, { lat, lon }, numbers);
  log(`Matched ${r.greens.size} of ${numbers.length}`);
  log(`Missing holes: ${r.missing.length ? r.missing.join(', ') : 'none'}`);
  const found = [...r.greens].sort((a, b) => a[0] - b[0]);
  for (const [n, g] of found) {
    const hz = g.hazards ?? [];
    const b = hz.filter((h) => h.kind === 'bunker').length;
    log(`  hole ${n}: green centre ${g.centre.lat.toFixed(6)}, ${g.centre.lon.toFixed(6)} (${g.outline.length} outline points)`
      + `; hazards: ${hz.length ? `${b} bunker${b === 1 ? '' : 's'}, ${hz.length - b} water` : 'none'}`);
  }
  const before = io.exists(outFile) ? countHoles(outFile) : 0;
  if (!found.length || found.length < before) {
    log(`${found.length ? 'Fewer holes than the file already has.' : 'Nothing matched.'} ${keep()}`);
    return { written: false, matched: found.length, missing: r.missing };
  }
  const make = (max) => ({
    fetchedAt: now().toISOString(),
    source: `OpenStreetMap contributors, via ${lib.host(answer.attempts[answer.attempts.length - 1].url)}`,
    holes: Object.fromEntries(found.map(([n, g]) => [String(n), {
      green: g.centre, greenShape: g.outline,
      ...(g.hazards?.length && max >= 0 ? { hazards: max ? thinHazards(lib, g.hazards, max) : g.hazards } : {}),
    }])),
  });
  let text = formatGreensFile(make(0));
  for (const max of [20, 12, 6]) {
    if (text.length < MAX_FILE_BYTES) break;
    log(`The file would be ${Math.round(text.length / 1024)} KB: hazard outlines cut to ${max} points`);
    text = formatGreensFile(make(max));
  }
  let withHazards = true;
  if (text.length >= MAX_FILE_BYTES) {
    log(`The file would still be ${Math.round(text.length / 1024)} KB: written without hazards`);
    text = formatGreensFile(make(-1));
    withHazards = false;
  }
  io.write(outFile, text);
  const hazardCount = withHazards ? found.reduce((s, [, g]) => s + (g.hazards?.length ?? 0), 0) : 0;
  log(`Wrote ${outFile.startsWith(root) ? outFile.slice(root.length + 1) : outFile} (${found.length} holes, ${hazardCount} hazards on them, ${Math.round(text.length / 1024)} KB)`);
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

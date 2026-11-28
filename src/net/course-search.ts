// "Find a course" (plan section 16.2): course search, scorecard and tees from OpenGolfAPI (api.opengolfapi.org: no key,
// open CORS, 1,000 requests a day per address; data under the ODbL, shown with "Course data © OpenGolfAPI
// contributors"). Hosted copy only, and only from a tap. A result becomes a course editor draft through the same
// parsing and flagging as a scorecard scan (src/vision/scorecard.ts), with the reasons reworded for course data:
// nothing is ever filled in that the data does not hold, so a missing rating, slope or yardage is flagged for him to
// type from the card.
//
// The response shapes below come from the API's own source (github.com/opengolfapi/api, src/index.ts, v2.0.1) and the
// published data's schema and CSV header (github.com/opengolfapi/data), not from a live answer, which this project
// has not been able to fetch. So every field is optional and checked, and a few likely spellings are read:
//   GET /v1/courses/search?q=<name>&limit=<n>   { count, courses: Row[] }   (q matches course_name, case-insensitive)
//   GET /v1/courses/state/:code?limit=<n>       { state, count, courses: Row[] }   (limit at most 500)
//   GET /v1/courses/:id                         { ...Row, scorecard: { hole_number, par, handicap_index }[] }
//   GET /v1/courses/:id/tees                    { tees: TeeRow[] }   (table golf_course_tees, every column)
//   GET /v1/courses/:id/holes                   { holes: { hole_number, par, handicap_index, yardages, meters }[] }
// Row: id, course_name (or name), city, state, address, latitude / longitude, par_total (or par), holes, total_yardage.
// The API has no "near a point" search: near me asks for the courses of the state(s) around the point and sorts them
// by distance, so in a state with more than 500 listed courses a near one can be missing (the screen says so).
import { haversineM, type LatLon } from '../core/geo';
import type { CourseForm } from '../ui/screens/courses-editor';
import { NOT_READ, parseScorecard } from '../vision/scorecard';

export const OGA_BASE = 'https://api.opengolfapi.org';
export const OGA_TIMEOUT_MS = 15_000;
/** Results asked for by name. */
export const NAME_LIMIT = 25;
/** Courses asked for per state for near me (the API's own maximum). */
export const STATE_LIMIT = 500;
/** Near me lists courses within this distance, nearest first, at most NEAR_MAX_RESULTS. */
export const NEAR_MAX_M = 60_000;
export const NEAR_MAX_RESULTS = 12;
export const ATTRIBUTION = 'Course data © OpenGolfAPI contributors';

/** One course in a result list. */
export interface FoundCourse {
  id: string; name: string; city?: string; state?: string; address?: string;
  location?: LatLon; par?: number;
  /** Near me only: metres from where he stands. */
  distanceM?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A finite number, or a numeric string ("6,795", "71.8"); otherwise undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().replace(/(\d),(\d{3})\b/g, '$1$2');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined;
}
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, max);
  return s || undefined;
}
/** The first of `keys` that `o` has a usable value for. */
function pick<T>(o: Obj, keys: string[], read: (v: unknown) => T | undefined): T | undefined {
  for (const k of keys) { const v = read(o[k]); if (v !== undefined) return v; }
  return undefined;
}

function location(o: Obj): LatLon | undefined {
  let lat = pick(o, ['latitude', 'lat'], num);
  let lon = pick(o, ['longitude', 'lon', 'lng'], num);
  const g = isObj(o.geometry) ? o.geometry : isObj(o.location) ? o.location : null;
  if ((lat === undefined || lon === undefined) && g && Array.isArray(g.coordinates)) {
    lon = num(g.coordinates[0]); lat = num(g.coordinates[1]);   // GeoJSON order
  }
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return undefined;
  return { lat, lon };
}

/** One course row, or null without an id and a name. A GeoJSON feature's `properties` are read the same way. */
export function parseCourseRow(raw: unknown): FoundCourse | null {
  if (!isObj(raw)) return null;
  const o: Obj = isObj(raw.properties) ? { ...raw.properties, geometry: raw.geometry } : raw;
  const id = text(o.id, 80);
  const name = pick(o, ['course_name', 'name'], (v) => text(v, 100));
  if (!id || !name || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const c: FoundCourse = { id, name };
  const city = text(o.city, 60); if (city) c.city = city;
  const state = text(o.state, 40); if (state) c.state = state;
  const address = text(o.address, 120); if (address) c.address = address;
  const loc = location(o); if (loc) c.location = loc;
  const par = pick(o, ['par_total', 'par'], num); if (par !== undefined && par >= 27 && par <= 80) c.par = par;
  return c;
}

/** A search or state answer: `{ courses: [...] }`, or a bare array. Rows that do not read are dropped. */
export function parseCourseList(raw: unknown): FoundCourse[] {
  const rows = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.courses) ? raw.courses
    : isObj(raw) && Array.isArray(raw.features) ? raw.features : [];
  const seen = new Set<string>();
  return rows.map(parseCourseRow).filter((c): c is FoundCourse => !!c && !seen.has(c.id) && !!seen.add(c.id));
}

// ----- the network -----------------------------------------------------------------------------------------------

/** Why a request gave nothing usable: no connection, the daily limit (429), another status, too slow, or not JSON. */
export type SearchFailure = { kind: 'connect' } | { kind: 'limit' } | { kind: 'status'; status: number } | { kind: 'slow' } | { kind: 'unreadable' };

export class CourseSearchError extends Error {
  constructor(readonly failure: SearchFailure) { super(failure.kind); }
}

export interface SearchOptions { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }

/** GET one API path as JSON. `query` values are set with URLSearchParams. Throws CourseSearchError. */
export async function getJson(path: string, query: Record<string, string> = {}, opts: SearchOptions = {}): Promise<unknown> {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const url = new URL(path, OGA_BASE);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, opts.timeoutMs ?? OGA_TIMEOUT_MS);
  const stop = () => ctl.abort();
  opts.signal?.addEventListener('abort', stop);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url.href, { method: 'GET', signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch {
      throw new CourseSearchError(timedOut ? { kind: 'slow' } : { kind: 'connect' });
    }
    if (res.status === 429) throw new CourseSearchError({ kind: 'limit' });
    if (!res.ok) throw new CourseSearchError({ kind: 'status', status: res.status });
    try { return await res.json(); } catch { throw new CourseSearchError(timedOut ? { kind: 'slow' } : { kind: 'unreadable' }); }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
}

/** Courses whose name contains `q` (at least 2 characters), as the API orders them. */
export async function searchByName(q: string, opts: SearchOptions = {}): Promise<FoundCourse[]> {
  const term = q.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (term.length < 2) return [];
  const raw = await getJson('/v1/courses/search', { q: term, limit: String(NAME_LIMIT) }, opts);
  if (!isObj(raw) && !Array.isArray(raw)) throw new CourseSearchError({ kind: 'unreadable' });
  return parseCourseList(raw);
}

// Rough bounding boxes of US states and DC: [south, west, north, east], degrees. Only used to choose which state lists
// to ask for near me; a margin of NEAR_BOX_MARGIN is added so a course over a border is still found.
export const STATE_BOXES: Record<string, [number, number, number, number]> = {
  AL: [30.1, -88.5, 35.0, -84.9], AK: [51.2, -179.2, 71.4, -129.9], AZ: [31.3, -114.8, 37.0, -109.0],
  AR: [33.0, -94.6, 36.5, -89.6], CA: [32.5, -124.5, 42.0, -114.1], CO: [37.0, -109.1, 41.0, -102.0],
  CT: [40.9, -73.7, 42.1, -71.8], DE: [38.4, -75.8, 39.8, -75.0], DC: [38.79, -77.12, 38.99, -76.91],
  FL: [24.4, -87.6, 31.0, -80.0], GA: [30.4, -85.6, 35.0, -80.8], HI: [18.9, -160.3, 22.3, -154.8],
  ID: [42.0, -117.2, 49.0, -111.0], IL: [37.0, -91.5, 42.5, -87.0], IN: [37.8, -88.1, 41.8, -84.8],
  IA: [40.4, -96.6, 43.5, -90.1], KS: [37.0, -102.1, 40.0, -94.6], KY: [36.5, -89.6, 39.1, -82.0],
  LA: [28.9, -94.0, 33.0, -88.8], ME: [43.1, -71.1, 47.5, -66.9], MD: [37.9, -79.5, 39.7, -75.0],
  MA: [41.2, -73.5, 42.9, -69.9], MI: [41.7, -90.4, 48.3, -82.4], MN: [43.5, -97.2, 49.4, -89.5],
  MS: [30.2, -91.7, 35.0, -88.1], MO: [36.0, -95.8, 40.6, -89.1], MT: [44.4, -116.1, 49.0, -104.0],
  NE: [40.0, -104.1, 43.0, -95.3], NV: [35.0, -120.0, 42.0, -114.0], NH: [42.7, -72.6, 45.3, -70.6],
  NJ: [38.9, -75.6, 41.4, -73.9], NM: [31.3, -109.1, 37.0, -103.0], NY: [40.5, -79.8, 45.0, -71.9],
  NC: [33.8, -84.3, 36.6, -75.5], ND: [45.9, -104.1, 49.0, -96.6], OH: [38.4, -84.8, 42.0, -80.5],
  OK: [33.6, -103.0, 37.0, -94.4], OR: [42.0, -124.6, 46.3, -116.5], PA: [39.7, -80.5, 42.3, -74.7],
  RI: [41.1, -71.9, 42.0, -71.1], SC: [32.0, -83.4, 35.2, -78.5], SD: [42.5, -104.1, 45.9, -96.4],
  TN: [35.0, -90.3, 36.7, -81.6], TX: [25.8, -106.6, 36.5, -93.5], UT: [37.0, -114.1, 42.0, -109.0],
  VT: [42.7, -73.4, 45.0, -71.5], VA: [36.5, -83.7, 39.5, -75.2], WA: [45.5, -124.8, 49.0, -116.9],
  WV: [37.2, -82.6, 40.6, -77.7], WI: [42.5, -92.9, 47.1, -86.8], WY: [41.0, -111.1, 45.0, -104.1],
};
export const NEAR_BOX_MARGIN = 0.4;
export const NEAR_MAX_STATES = 3;

/** The states whose box (with the margin) holds the point: inside first, then nearest the box edge, then smallest. */
export function statesNear(p: LatLon): string[] {
  const m = NEAR_BOX_MARGIN;
  const scored: { code: string; out: number; area: number }[] = [];
  for (const [code, [s, w, n, e]] of Object.entries(STATE_BOXES)) {
    if (p.lat < s - m || p.lat > n + m || p.lon < w - m || p.lon > e + m) continue;
    const out = Math.max(0, s - p.lat, p.lat - n) + Math.max(0, w - p.lon, p.lon - e);
    scored.push({ code, out, area: (n - s) * (e - w) });
  }
  return scored.sort((a, b) => (a.out > 0 ? 1 : 0) - (b.out > 0 ? 1 : 0) || a.out - b.out || a.area - b.area)
    .slice(0, NEAR_MAX_STATES).map((x) => x.code);
}

export interface NearResult { courses: FoundCourse[]; states: string[]; capped: string[] }

/** Courses near `p`, nearest first: the state lists around the point, sorted by distance. A state that fails is
 *  skipped while another answers; when none answers, the first failure is thrown. `capped`: states whose list came
 *  back full (STATE_LIMIT rows), so a near course may be missing from it. */
export async function searchNear(p: LatLon, opts: SearchOptions = {}): Promise<NearResult> {
  const states = statesNear(p);
  if (!states.length) return { courses: [], states, capped: [] };
  const answers = await Promise.allSettled(states.map((s) => getJson(`/v1/courses/state/${s}`, { limit: String(STATE_LIMIT) }, opts)));
  const ok = answers.flatMap((a, i) => (a.status === 'fulfilled' ? [{ state: states[i], rows: parseCourseList(a.value) }] : []));
  if (!ok.length) {
    const first = answers.find((a): a is PromiseRejectedResult => a.status === 'rejected');
    throw first?.reason instanceof CourseSearchError ? first.reason : new CourseSearchError({ kind: 'connect' });
  }
  const seen = new Set<string>();
  const courses = ok.flatMap((x) => x.rows)
    .filter((c) => c.location && !seen.has(c.id) && !!seen.add(c.id))
    .map((c) => ({ ...c, distanceM: Math.round(haversineM(p, c.location!)) }))
    .filter((c) => c.distanceM <= NEAR_MAX_M)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, NEAR_MAX_RESULTS);
  return { courses, states: ok.map((x) => x.state), capped: ok.filter((x) => x.rows.length >= STATE_LIMIT).map((x) => x.state) };
}

// ----- one course: scorecard and tees ----------------------------------------------------------------------------

export interface CourseData { course: FoundCourse; holes: Obj[]; tees: Obj[]; holeYards: Obj[] }

/** The course row with its scorecard, then its tees and per-hole yardages. Only the course row is required: when the
 *  tees or holes request fails, the draft simply has those values flagged. */
export async function loadCourse(id: string, opts: SearchOptions = {}): Promise<CourseData> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new CourseSearchError({ kind: 'unreadable' });
  const path = `/v1/courses/${encodeURIComponent(id)}`;
  const [main, tees, holes] = await Promise.allSettled([getJson(path, {}, opts), getJson(`${path}/tees`, {}, opts), getJson(`${path}/holes`, {}, opts)]);
  if (main.status === 'rejected') throw main.reason;
  const course = parseCourseRow(main.value);
  if (!course || !isObj(main.value)) throw new CourseSearchError({ kind: 'unreadable' });
  const list = (v: unknown, key: string): Obj[] => {
    const a = Array.isArray(v) ? v : isObj(v) && Array.isArray(v[key]) ? v[key] : [];
    return (a as unknown[]).filter(isObj);
  };
  const row = main.value;
  const card = list(row.scorecard, 'scorecard');
  return {
    course,
    holes: card.length ? card : csvHoles(row),
    tees: tees.status === 'fulfilled' ? list(tees.value, 'tees') : [],
    holeYards: holes.status === 'fulfilled' ? list(holes.value, 'holes') : [],
  };
}

/** The data download's flat form (hole_1_par … hole_18_hcp), in case a row carries it instead of a scorecard. */
function csvHoles(row: Obj): Obj[] {
  const out: Obj[] = [];
  for (let n = 1; n <= 18; n++) {
    const par = num(row[`hole_${n}_par`]), hcp = num(row[`hole_${n}_hcp`]);
    if (par !== undefined || hcp !== undefined) out.push({ hole_number: n, par, handicap_index: hcp });
  }
  return out;
}

const holeNo = (h: Obj) => pick(h, ['hole_number', 'hole', 'number'], num);

function gender(v: unknown): 'M' | 'W' | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (/^(m|male|men|mens|men's|man)$/.test(s)) return 'M';
  if (/^(w|f|female|women|womens|women's|ladies|lady|l)$/.test(s)) return 'W';
  return undefined;
}

/** A tee's 18 hole yardages from its own row (an array, or hole_N / hole_N_yardage / hole_N_yards columns). */
function teeRowYards(t: Obj): (number | null)[] {
  const arr = pick(t, ['yardages', 'hole_yardages', 'holes_yardage'], (v) => (Array.isArray(v) ? v : undefined));
  return Array.from({ length: 18 }, (_, i) => {
    const v = arr ? num(arr[i]) : pick(t, [`hole_${i + 1}_yardage`, `hole_${i + 1}_yards`, `hole_${i + 1}`], num);
    return v ?? null;
  });
}

/** A tee's yardage on one hole from the holes endpoint's `yardages`, matched by tee name only: an object keyed by tee
 *  name, or a list of { tee | tee_name | name, yards | yardage }. Anything else is not used. */
function holeYardFor(h: Obj, teeName: string): number | undefined {
  const y = h.yardages;
  const same = (k: unknown) => typeof k === 'string' && k.trim().toLowerCase() === teeName.trim().toLowerCase();
  if (isObj(y)) { for (const [k, v] of Object.entries(y)) if (same(k)) return num(v); return undefined; }
  if (Array.isArray(y)) {
    for (const e of y) if (isObj(e) && same(pick(e, ['tee', 'tee_name', 'name', 'color'], (v) => text(v, 40)))) return pick(e, ['yards', 'yardage'], num);
  }
  return undefined;
}

/** What the course data says, in the scorecard-scan answer shape, so the scan's parser and checks apply unchanged. */
export function asScorecardAnswer(d: CourseData): Obj {
  const holes = d.holes.map((h) => ({ number: holeNo(h), par: num(h.par),
    strokeIndex: pick(h, ['handicap_index', 'handicap', 'hcp', 'stroke_index'], num) }))
    .filter((h) => h.number !== undefined);
  const tees = d.tees.slice(0, 10).map((t) => {
    const name = pick(t, ['tee_name', 'name', 'tee', 'tee_color', 'color'], (v) => text(v, 30)) ?? null;
    const yards = teeRowYards(t);
    if (name) {
      for (const h of d.holeYards) {
        const n = holeNo(h);
        if (n && n >= 1 && n <= 18 && yards[n - 1] === null) yards[n - 1] = holeYardFor(h, name) ?? null;
      }
    }
    return {
      name, gender: gender(pick(t, ['gender', 'sex', 'tee_gender'], (v) => v)) ?? null,
      rating: pick(t, ['course_rating', 'rating', 'cr'], num) ?? null,
      slope: pick(t, ['slope_rating', 'slope', 'sr'], num) ?? null,
      yardages: yards, total: pick(t, ['total_yardage', 'total_yards', 'yardage', 'yards'], num) ?? null,
    };
  });
  return { found: true, name: d.course.name, city: d.course.city ?? null, state: d.course.state ?? null, holes, tees };
}

export const NOT_LISTED = 'Not in the course data. Copy it from the card.';
export const NO_TEES = 'No tees in the course data. Type yours from the card.';

/** The scan's reasons, said for course data instead of a photo. */
export function rewordFlag(msg: string): string {
  if (msg === NOT_READ) return NOT_LISTED;
  return msg
    .replace('Course name not read from the photo. Type it in.', 'The course data has no name. Type it in.')
    .replace('Tee name not read from the photo.', 'The course data has no name for this tee.')
    .replace('The card does not say whether this rating is for men or women: check it.',
      'The course data does not say whether this tee is rated for men or women: check the card.')
    .replace('No tee read from the photo. Add one with its rating and slope.',
      'The course data lists no tees. Add the one you play, with its rating and slope from the card.')
    .replace(/^Read as /, 'Listed as ')
    .replace(/the card's total reads/, 'the listed total is')
    .replace('One hole was misread: check each against the card.', 'Check each hole against the card.');
}

export interface FoundDraft { form: CourseForm; flags: Record<string, string> }

/** The editor draft for a course from the data: values present are filled, everything else flagged. Unrated tees stay
 *  in the draft (named, with any yardages) with rating and slope flagged, never guessed. */
export function draftFromCourse(d: CourseData): FoundDraft {
  const r = parseScorecard(asScorecardAnswer(d));
  const flags = Object.fromEntries(Object.entries(r.flags).map(([k, v]) => [k, rewordFlag(v)]));
  // No tees in the data: the scan's one blank tee stays, and its own boxes carry the flags (so typing them settles
  // them), instead of a flag on "Add a tee".
  if (flags['add-tee']) {
    delete flags['add-tee'];
    flags['tee-0-name'] = NO_TEES;
    flags['tee-0-rating'] = NOT_LISTED;
    flags['tee-0-slope'] = NOT_LISTED;
    for (let h = 1; h <= 18; h++) flags[`yards-0-${h}`] = NOT_LISTED;
  }
  const form: CourseForm = {
    ...r.form,
    name: r.form.name || d.course.name,
    sources: [`OpenGolfAPI (opengolfapi.org, ODbL), course ${d.course.id}`],
  };
  if (d.course.location) form.location = { ...d.course.location };
  return { form, flags };
}

/** One plain line for a failed search or course request. */
export function searchFailureLine(e: unknown): string {
  const f = e instanceof CourseSearchError ? e.failure : { kind: 'connect' as const };
  switch (f.kind) {
    case 'limit': return 'The course list has had too many searches from this connection today. Try again tomorrow, or add the course by hand.';
    case 'status': return `The course list could not answer (status ${f.status}). Try again in a minute, or add the course by hand.`;
    case 'slow': return 'The course list took too long to answer. Try again, or add the course by hand.';
    case 'unreadable': return "The course list's answer could not be read. Try again, or add the course by hand.";
    default: return "Couldn't reach the course list. Check that this phone is online and try again.";
  }
}

/** Distance for a result line: "800 yd" under a mile, else miles to one decimal. */
export function distanceText(m: number): string {
  const yd = m / 0.9144;
  return yd < 1760 ? `${Math.round(yd / 10) * 10} yd` : `${(yd / 1760).toFixed(yd < 17600 ? 1 : 0)} mi`;
}

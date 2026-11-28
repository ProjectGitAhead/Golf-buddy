// The app's map lookup (plan sections 15.1, 15.3, 16.1 and 16.2): golf greens, hole lines, bunkers and water around a
// point from OpenStreetMap's Overpass service. Only ever called from a tap, only in the hosted copy. The position is
// rounded to about 100 m first, so only the course's rough location leaves the phone. The app asks the hosted copy's
// own /api/osm first (nginx on the Fly app forwards it to the four servers in turn and caches good answers, plan
// 16.2), then the four public servers one after another, stopping at the first good answer; nothing else retries.
// Where /api/osm does not exist (GitHub Pages, local preview) it answers 404 and the public servers are asked as
// before. The request is a plain form-encoded POST with no custom headers, so the browser sends it without a CORS
// preflight. scripts/fetch-greens.mjs uses the same code at build time (public servers only).
import { simplifyRing, type OsmElement } from '../core/greens';
import type { Course } from '../core/types';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
] as const;
/** The hosted copy's own forwarding endpoint (deploy/nginx.conf). Same origin, so it is a path, not an address. */
export const PROXY_ENDPOINT = '/api/osm';
/** What the app asks, in order. */
export const APP_ENDPOINTS = [PROXY_ENDPOINT, ...OVERPASS_ENDPOINTS] as const;
/** /api/osm may try several servers itself (nginx gives each 25 s), so it gets longer than one server. */
export const PROXY_TIMEOUT_MS = 55_000;
/** Around a course's own coordinates (a found course, or "Load green positions" on its page), as the build does. */
export const COURSE_RADIUS_M = 2500;
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
export const SEARCH_RADIUS_M = 1500;
/** How long one server gets before the next is asked. */
export const TIMEOUT_MS = 25_000;
/** The time budget the query asks the server for: shorter than TIMEOUT_MS, so the server answers (or says it ran out
 *  of time) before the phone gives up on it. */
export const SERVER_TIMEOUT_S = 20;

/** The areas asked for as ways and as relations: greens, bunkers and water (any of the three water tags). */
const AREAS = ['"golf"="green"', '"golf"="bunker"', '"natural"="water"', '"golf"="water_hazard"', '"golf"="lateral_water_hazard"'];

export function overpassQuery(lat: number, lon: number, radiusM = SEARCH_RADIUS_M): string {
  const at = `${radiusM},${lat.toFixed(3)},${lon.toFixed(3)}`;
  return `[out:json][timeout:${SERVER_TIMEOUT_S}];(`
    + AREAS.map((t) => `way[${t}](around:${at});relation[${t}](around:${at});`).join('')
    + `way["golf"="hole"](around:${at}););out tags geom;`;
}

/** Why one server gave no usable answer. `connect`: the request never got an answer the page may read (no
 *  connection, the server unreachable, or an error page without CORS headers). `status`: an HTTP error status.
 *  `slow`: no answer within TIMEOUT_MS, or the server says the query ran out of time. `unreadable`: not Overpass JSON.
 *  `absent`: /api/osm is not there (404 or 405: GitHub Pages, local preview); not a reason worth telling him. */
export type Failure = { kind: 'connect' } | { kind: 'status'; status: number } | { kind: 'slow' } | { kind: 'unreadable' } | { kind: 'absent'; status: number };

export interface Attempt { url: string; ms: number; status?: number; failure?: Failure; detail?: string; elements?: number }

export class OverpassError extends Error {
  constructor(readonly attempts: Attempt[]) {
    super(attempts.map((a) => `${host(a.url)}: ${a.detail ?? 'failed'}`).join('; '));
  }
}

/** An error's message, with node's underlying cause (such as ENOTFOUND) when there is one. */
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const c = (e as { cause?: { code?: string; message?: string } }).cause;
  const why = c?.code ?? c?.message;
  return why ? `${e.message} (${why})` : e.message;
}

export const host = (url: string) => (url.startsWith('/') ? `this site ${url}` : url.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, ''));

async function ask(url: string, body: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ attempt: Attempt; elements?: OsmElement[] }> {
  const t0 = Date.now();
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const done = (a: Omit<Attempt, 'url' | 'ms'>, elements?: OsmElement[]) => ({ attempt: { url, ms: Date.now() - t0, ...a }, elements });
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST', body, signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (e) {
      return timedOut ? done({ failure: { kind: 'slow' }, detail: `no answer in ${Math.round(timeoutMs / 1000)} s` })
        : done({ failure: { kind: 'connect' }, detail: errorText(e) });
    }
    if (url === PROXY_ENDPOINT && (res.status === 404 || res.status === 405)) {
      return done({ status: res.status, failure: { kind: 'absent', status: res.status }, detail: `HTTP ${res.status}, not on this site` });
    }
    if (!res.ok) return done({ status: res.status, failure: { kind: 'status', status: res.status }, detail: `HTTP ${res.status}` });
    let json: { elements?: unknown; remark?: unknown };
    try {
      json = await res.json();
    } catch {
      return timedOut ? done({ status: res.status, failure: { kind: 'slow' }, detail: `HTTP ${res.status}, answer cut off at ${Math.round(timeoutMs / 1000)} s` })
        : done({ status: res.status, failure: { kind: 'unreadable' }, detail: `HTTP ${res.status}, not JSON` });
    }
    // Overpass answers 200 with a "runtime error" remark (and partial data) when the query ran out of time or memory.
    if (typeof json?.remark === 'string' && /error/i.test(json.remark)) {
      return done({ status: res.status, failure: { kind: 'slow' }, detail: `HTTP ${res.status}, ${json.remark.slice(0, 120)}` });
    }
    if (!json || !Array.isArray(json.elements)) return done({ status: res.status, failure: { kind: 'unreadable' }, detail: `HTTP ${res.status}, no elements` });
    const elements = json.elements as OsmElement[];
    return done({ status: res.status, detail: `HTTP ${res.status}, ${elements.length} elements`, elements: elements.length }, elements);
  } finally {
    clearTimeout(timer);
  }
}

export interface AskOptions {
  fetchImpl?: typeof fetch;
  endpoints?: readonly string[];
  timeoutMs?: number;
  /** Called after each server is asked (the build script logs these). */
  onAttempt?: (a: Attempt) => void;
}

/** Runs an Overpass query on each server in turn until one gives a good answer. Throws `OverpassError` when none does. */
export async function runQuery(query: string, opts: AskOptions = {}): Promise<{ elements: OsmElement[]; attempts: Attempt[] }> {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const body = `data=${encodeURIComponent(query)}`;
  const attempts: Attempt[] = [];
  for (const url of opts.endpoints ?? OVERPASS_ENDPOINTS) {
    const ms = url === PROXY_ENDPOINT ? Math.max(PROXY_TIMEOUT_MS, opts.timeoutMs ?? 0) : opts.timeoutMs ?? TIMEOUT_MS;
    const { attempt, elements } = await ask(url, body, fetchImpl, ms);
    attempts.push(attempt);
    opts.onAttempt?.(attempt);
    if (elements) return { elements, attempts };
  }
  throw new OverpassError(attempts);
}

/** Golf greens, hole lines, bunkers and water within `radiusM` (1,500 m: around the player) of a point: /api/osm, then
 *  the four public servers. Throws `OverpassError` when none gives a good answer. */
export async function loadGolfFeatures(lat: number, lon: number, fetchImpl?: typeof fetch, radiusM = SEARCH_RADIUS_M): Promise<OsmElement[]> {
  return (await runQuery(overpassQuery(lat, lon, radiusM), { fetchImpl, endpoints: APP_ENDPOINTS })).elements;
}

/** A stored course document stays under this (the db's per-document limit is 256 KB). */
export const MAX_COURSE_BYTES = 200 * 1024;

/**
 * The course as stored, small enough: when its JSON is over `max` bytes, hazard outlines are cut to 20, 12, then 6
 * points, and as a last step dropped, as scripts/fetch-greens.mjs does for a greens file. Greens are never cut.
 * `trimmed` says what was given up.
 */
export function fitCourse(course: Course, max = MAX_COURSE_BYTES): { course: Course; trimmed: 'none' | 'outlines' | 'hazards' } {
  const size = (c: Course) => new TextEncoder().encode(JSON.stringify(c)).length;
  if (size(course) <= max) return { course, trimmed: 'none' };
  for (const pts of [20, 12, 6]) {
    const c: Course = { ...course, holes: course.holes.map((h) => (h.hazards ? { ...h, hazards: h.hazards.map((z) => ({ kind: z.kind,
      shape: z.shape.length <= pts ? z.shape : simplifyRing(z.shape.map(([lat, lon]) => ({ lat, lon })), pts).map((p) => [p.lat, p.lon] as [number, number]) })) } : h)) };
    if (size(c) <= max) return { course: c, trimmed: 'outlines' };
  }
  return { course: { ...course, holes: course.holes.map(({ hazards: _drop, ...h }) => h) }, trimmed: 'hazards' };
}

/**
 * One plain line saying why the lookup failed. With different reasons from different servers, an HTTP status wins
 * (it is the server's own word), then running out of time, then an unreadable answer, then no connection.
 */
export function failureLine(attempts: Attempt[]): string {
  const f = attempts.map((a) => a.failure).filter((x): x is Exclude<Failure, { kind: 'absent' }> => !!x && x.kind !== 'absent');
  const statuses = [...new Set(f.flatMap((x) => (x.kind === 'status' ? [x.status] : [])))];
  if (statuses.length) {
    const busy = statuses.every((s) => s === 429 || s >= 500);
    const list = `status ${statuses.join(', ')}`;
    return busy ? `The map service is busy (${list}). Try again in a minute.`
      : `The map service turned the request down (${list}). Try again in a minute.`;
  }
  if (f.some((x) => x.kind === 'slow')) return 'The map service took too long to answer. Try again in a minute.';
  if (f.some((x) => x.kind === 'unreadable')) return "The map service's answer could not be read. Try again in a minute.";
  return "Couldn't connect to the map service. Check that this phone is online and try again.";
}

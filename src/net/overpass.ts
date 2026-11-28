// The app's one network call (plan sections 15.1, 15.3 and 16.1): golf greens, hole lines, bunkers and water around the player from
// OpenStreetMap's Overpass service. Only ever called from a tap, only in the hosted copy. The position is rounded to
// about 100 m first, so only the course's rough location leaves the phone. The four public servers are asked one
// after another, 25 s each, stopping at the first good answer; nothing else retries. The request is a plain
// form-encoded POST with no custom headers, so the browser sends it without a CORS preflight.
// scripts/fetch-greens.mjs uses the same code at build time.
import type { OsmElement } from '../core/greens';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
] as const;
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
 *  `slow`: no answer within TIMEOUT_MS, or the server says the query ran out of time. `unreadable`: not Overpass JSON. */
export type Failure = { kind: 'connect' } | { kind: 'status'; status: number } | { kind: 'slow' } | { kind: 'unreadable' };

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

export const host = (url: string) => url.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');

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
    const { attempt, elements } = await ask(url, body, fetchImpl, opts.timeoutMs ?? TIMEOUT_MS);
    attempts.push(attempt);
    opts.onAttempt?.(attempt);
    if (elements) return { elements, attempts };
  }
  throw new OverpassError(attempts);
}

/** Golf greens, hole lines, bunkers and water within 1,500 m of the player. Throws `OverpassError` when every server fails. */
export async function loadGolfFeatures(lat: number, lon: number, fetchImpl?: typeof fetch): Promise<OsmElement[]> {
  return (await runQuery(overpassQuery(lat, lon), { fetchImpl })).elements;
}

/**
 * One plain line saying why the lookup failed. With different reasons from different servers, an HTTP status wins
 * (it is the server's own word), then running out of time, then an unreadable answer, then no connection.
 */
export function failureLine(attempts: Attempt[]): string {
  const f = attempts.map((a) => a.failure).filter((x): x is Failure => !!x);
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

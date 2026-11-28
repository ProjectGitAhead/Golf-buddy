// The app's one network call (plan section 15.1): golf greens and hole lines around the player from OpenStreetMap's
// Overpass service. Only ever called from a tap, only in the hosted copy. The position is rounded to about 100 m
// first, so only the course's rough location leaves the phone. One request to the first server, then one to the
// second if that fails; nothing else retries.
import type { OsmElement } from '../core/greens';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const;
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
export const SEARCH_RADIUS_M = 1500;
const TIMEOUT_MS = 15_000;

export function overpassQuery(lat: number, lon: number): string {
  const at = `${SEARCH_RADIUS_M},${lat.toFixed(3)},${lon.toFixed(3)}`;
  return `[out:json][timeout:15];(way["golf"="green"](around:${at});relation["golf"="green"](around:${at});`
    + `way["golf"="hole"](around:${at}););out tags geom;`;
}

export class OverpassError extends Error {}

async function ask(url: string, body: string, fetchImpl: typeof fetch): Promise<OsmElement[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST', body, signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) throw new OverpassError(`status ${res.status}`);
    const json = await res.json() as { elements?: unknown };
    if (!json || !Array.isArray(json.elements)) throw new OverpassError('no elements');
    return json.elements as OsmElement[];
  } finally {
    clearTimeout(timer);
  }
}

/** Golf greens and hole lines within 1,500 m. Throws `OverpassError` when both servers fail. */
export async function loadGolfFeatures(lat: number, lon: number, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<OsmElement[]> {
  const body = `data=${encodeURIComponent(overpassQuery(lat, lon))}`;
  try {
    return await ask(OVERPASS_ENDPOINTS[0], body, fetchImpl);
  } catch {
    try {
      return await ask(OVERPASS_ENDPOINTS[1], body, fetchImpl);
    } catch (e) {
      throw new OverpassError(e instanceof Error ? e.message : 'failed');
    }
  }
}

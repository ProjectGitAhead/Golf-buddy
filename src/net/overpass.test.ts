import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../core/greens.fixture.json';
import type { Course } from '../core/types';
import {
  APP_ENDPOINTS, failureLine, fitCourse, loadGolfFeatures, OVERPASS_ENDPOINTS, OverpassError, PROXY_ENDPOINT, PROXY_TIMEOUT_MS, runQuery,
  TIMEOUT_MS, type Attempt,
} from './overpass';

const FIXTURE = JSON.stringify(fixture);
type Answer = 'ok' | 'empty' | 'offline' | 'hang' | 'remark' | 'html' | number;

/** A fake fetch answering each public server in turn as `plan` says, recording every call. The hosted copy's own
 *  /api/osm is answered by `proxy` (default 404: not there, as on GitHub Pages and in local preview) and recorded in
 *  `proxyCalls`, so `calls` is the public servers only. */
function fake(plan: Answer[], proxy: Answer = 404) {
  const calls: { url: string; init: RequestInit }[] = [];
  const proxyCalls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    const toProxy = url === PROXY_ENDPOINT;
    (toProxy ? proxyCalls : calls).push({ url, init });
    const how = toProxy ? proxy : plan[calls.length - 1];
    if (how === 'offline') return Promise.reject(new TypeError('Load failed'));
    if (how === 'hang') {
      return new Promise((_, fail) => init.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError'))));
    }
    if (typeof how === 'number') return Promise.resolve(new Response('busy', { status: how }));
    if (how === 'html') return Promise.resolve(new Response('<html>oops</html>', { status: 200 }));
    if (how === 'remark') return Promise.resolve(new Response('{"elements":[],"remark":"runtime error: Query timed out in \\"query\\" at line 1"}'));
    return Promise.resolve(new Response(how === 'empty' ? '{"elements":[]}' : FIXTURE, { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, calls, proxyCalls };
}

async function failsWith(plan: Answer[]): Promise<{ line: string; attempts: Attempt[] }> {
  const { impl } = fake(plan);
  try {
    await loadGolfFeatures(38.26, -122.03, impl);
  } catch (e) {
    expect(e).toBeInstanceOf(OverpassError);
    const all = (e as OverpassError).attempts;
    return { line: failureLine(all), attempts: all.filter((a) => a.url !== PROXY_ENDPOINT) };
  }
  throw new Error('did not fail');
}

afterEach(() => { vi.useRealTimers(); });

describe('the green lookup request', () => {
  it('is a simple form POST (no preflight): no custom headers, no credentials, the query as data=', async () => {
    const { impl, calls } = fake(['ok']);
    await loadGolfFeatures(38.2604, -122.0301, impl);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://overpass-api.de/api/interpreter');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Content-Type']);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = String(init.body);
    expect(body.startsWith('data=')).toBe(true);
    const q = decodeURIComponent(body.slice(5));
    expect(q).toContain('[timeout:20]');
    expect(q).toContain('way["golf"="green"](around:1500,38.260,-122.030)');
  });

  it('asks the four servers in order and stops at the first good answer', async () => {
    const { impl, calls } = fake(['offline', 503, 'ok', 'ok']);
    const r = await runQuery('q', { fetchImpl: impl });
    expect(calls.map((c) => c.url)).toEqual(OVERPASS_ENDPOINTS.slice(0, 3));
    expect(r.elements.length).toBe(fixture.elements.length);
    expect(r.attempts.map((a) => a.detail)).toEqual(['Load failed', 'HTTP 503', `HTTP 200, ${fixture.elements.length} elements`]);
  });

  it('an empty answer is a good answer (the course is just not mapped)', async () => {
    const { impl, calls } = fake(['empty']);
    expect(await loadGolfFeatures(1, 2, impl)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('gives each server 25 s, then moves on', async () => {
    vi.useFakeTimers();
    const { impl, calls } = fake(['hang', 'ok']);
    const p = runQuery('q', { fetchImpl: impl });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(calls).toHaveLength(2);
    expect(r.attempts[0].failure).toEqual({ kind: 'slow' });
  });
});

describe('the failure line names the reason', () => {
  it('no connection', async () => {
    const { line, attempts } = await failsWith(['offline', 'offline', 'offline', 'offline']);
    expect(attempts).toHaveLength(4);
    expect(line).toBe("Couldn't connect to the map service. Check that this phone is online and try again.");
  });
  it('busy, with the status', async () => {
    expect((await failsWith([429, 504, 'offline', 504])).line).toBe('The map service is busy (status 429, 504). Try again in a minute.');
  });
  it('a status that is not "busy"', async () => {
    expect((await failsWith([400, 400, 400, 400])).line).toBe('The map service turned the request down (status 400). Try again in a minute.');
  });
  it('too slow: no answer in time, or the server ran out of time', async () => {
    vi.useFakeTimers();
    const p = failsWith(['hang', 'remark', 'offline', 'hang']);
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT_MS);
    expect((await p).line).toBe('The map service took too long to answer. Try again in a minute.');
  });
  it('an answer that is not Overpass JSON', async () => {
    expect((await failsWith(['html', 'offline', 'offline', 'offline'])).line).toBe("The map service's answer could not be read. Try again in a minute.");
  });
});

describe('the hosted copy\'s own /api/osm (plan 16.2)', () => {
  it('is asked first, with the same request; a good answer there means no public server is asked', async () => {
    const { impl, calls, proxyCalls } = fake([], 'ok');
    const els = await loadGolfFeatures(38.2604, -122.0301, impl);
    expect(els.length).toBe(fixture.elements.length);
    expect(proxyCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
    const { init } = proxyCalls[0];
    expect(init.method).toBe('POST');
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Content-Type']);
    expect(decodeURIComponent(String(init.body).slice(5))).toContain('way["golf"="green"](around:1500,38.260,-122.030)');
    expect(APP_ENDPOINTS).toEqual([PROXY_ENDPOINT, ...OVERPASS_ENDPOINTS]);
  });

  it('where it does not exist (404 or 405) the public servers are asked, and the failure line never mentions it', async () => {
    for (const absent of [404, 405] as const) {
      const { impl, calls } = fake(['ok'], absent);
      await loadGolfFeatures(1, 2, impl);
      expect(calls.map((c) => c.url)).toEqual([OVERPASS_ENDPOINTS[0]]);
    }
    const { impl } = fake([429, 429, 429, 429], 404);
    const e = await loadGolfFeatures(1, 2, impl).catch((x) => x as OverpassError);
    expect(e).toBeInstanceOf(OverpassError);
    expect((e as OverpassError).attempts[0].failure).toEqual({ kind: 'absent', status: 404 });
    expect(failureLine((e as OverpassError).attempts)).toBe('The map service is busy (status 429). Try again in a minute.');
  });

  it('when it is busy (its own rate limit, or every server behind it busy) the public servers are asked', async () => {
    const { impl, calls } = fake(['offline', 'ok'], 429);
    await loadGolfFeatures(1, 2, impl);
    expect(calls.map((c) => c.url)).toEqual(OVERPASS_ENDPOINTS.slice(0, 2));
  });

  it(`gets ${PROXY_TIMEOUT_MS / 1000} s (it may try several servers itself), the public servers 25 s each`, async () => {
    vi.useFakeTimers();
    const { impl, calls, proxyCalls } = fake(['ok'], 'hang');
    const p = loadGolfFeatures(1, 2, impl);
    await vi.advanceTimersByTimeAsync(PROXY_TIMEOUT_MS - 1);
    expect(proxyCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(calls).toHaveLength(1);
  });

  it('a runtime-error remark from it (a cached or partial answer) is not used: the public servers are asked', async () => {
    const { impl, calls } = fake(['ok'], 'remark');
    expect((await loadGolfFeatures(1, 2, impl)).length).toBe(fixture.elements.length);
    expect(calls).toHaveLength(1);
  });

  it('the build script\'s default (runQuery without endpoints) is the public servers only', async () => {
    const { impl, calls, proxyCalls } = fake(['ok']);
    await runQuery('q', { fetchImpl: impl });
    expect(proxyCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('a course\'s own lookup asks 2,500 m around the given point', async () => {
    const { impl, proxyCalls } = fake([], 'ok');
    await loadGolfFeatures(38.29107, -122.07324, impl, 2500);
    expect(decodeURIComponent(String(proxyCalls[0].init.body).slice(5))).toContain('(around:2500,38.291,-122.073)');
  });
});

describe('fitCourse keeps a stored course under the size limit', () => {
  const ring = (n: number, lat: number, lon: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [lat + 0.0004 * Math.sin((2 * Math.PI * i) / n), lon + 0.0005 * Math.cos((2 * Math.PI * i) / n)]);
  const course = (hazardsPerHole: number, pts: number): Course => ({
    id: 'c', name: 'C', verified: false, updatedAt: '', tees: [],
    holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1, green: { lat: 38 + i * 0.001, lon: -122 },
      greenShape: ring(40, 38 + i * 0.001, -122),
      hazards: Array.from({ length: hazardsPerHole }, (_, k) => ({ kind: 'bunker' as const, shape: ring(pts, 38 + i * 0.001 + k * 0.0001, -122.001) })) })),
  });
  const bytes = (c: Course) => new TextEncoder().encode(JSON.stringify(c)).length;

  it('leaves a course that fits alone', () => {
    const c = course(2, 30);
    expect(fitCourse(c)).toEqual({ course: c, trimmed: 'none' });
  });
  it('simplifies hazard outlines first, and never touches the greens', () => {
    const c = course(12, 30);
    const max = Math.round(bytes(c) * 0.8);
    const r = fitCourse(c, max);
    expect(r.trimmed).toBe('outlines');
    expect(bytes(r.course)).toBeLessThanOrEqual(max);
    expect(r.course.holes.map((h) => h.greenShape)).toEqual(c.holes.map((h) => h.greenShape));
    expect(r.course.holes.every((h) => h.hazards!.length === 12 && h.hazards!.every((z) => z.shape.length <= 20))).toBe(true);
  });
  it('drops hazards as a last step', () => {
    const c = course(12, 30);
    const r = fitCourse(c, Math.round(bytes(course(0, 30)) * 1.05));
    expect(r.trimmed).toBe('hazards');
    expect(r.course.holes.every((h) => h.hazards === undefined && h.greenShape!.length === 40)).toBe(true);
  });
});

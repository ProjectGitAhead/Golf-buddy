import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../core/greens.fixture.json';
import { failureLine, loadGolfFeatures, OVERPASS_ENDPOINTS, OverpassError, runQuery, TIMEOUT_MS, type Attempt } from './overpass';

const FIXTURE = JSON.stringify(fixture);
type Answer = 'ok' | 'empty' | 'offline' | 'hang' | 'remark' | 'html' | number;

/** A fake fetch answering each endpoint in turn as `plan` says, recording every call. */
function fake(plan: Answer[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const how = plan[calls.length - 1];
    if (how === 'offline') return Promise.reject(new TypeError('Load failed'));
    if (how === 'hang') {
      return new Promise((_, fail) => init.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError'))));
    }
    if (typeof how === 'number') return Promise.resolve(new Response('busy', { status: how }));
    if (how === 'html') return Promise.resolve(new Response('<html>oops</html>', { status: 200 }));
    if (how === 'remark') return Promise.resolve(new Response('{"elements":[],"remark":"runtime error: Query timed out in \\"query\\" at line 1"}'));
    return Promise.resolve(new Response(how === 'empty' ? '{"elements":[]}' : FIXTURE, { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function failsWith(plan: Answer[]): Promise<{ line: string; attempts: Attempt[] }> {
  const { impl } = fake(plan);
  try {
    await loadGolfFeatures(38.26, -122.03, impl);
  } catch (e) {
    expect(e).toBeInstanceOf(OverpassError);
    return { line: failureLine((e as OverpassError).attempts), attempts: (e as OverpassError).attempts };
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

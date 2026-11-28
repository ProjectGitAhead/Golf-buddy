import { describe, expect, it } from 'vitest';
import { fetchGreens, formatGreensFile, MAX_FILE_BYTES } from '../../../scripts/fetch-greens.mjs';
import fixture from '../../core/greens.fixture.json';
import * as greens from '../../core/greens';
import * as overpass from '../../net/overpass';
import type { Course } from '../../core/types';
import ranchoSolano from './rancho-solano.json';
import shippedGreens from './rancho-solano.greens.json';
import { bundledCourses, findCourse, mergeGreens, toGreensFile, type GreensFile } from '.';

const lib = { matchGreens: greens.matchGreens, simplifyRing: greens.simplifyRing, runQuery: overpass.runQuery, overpassQuery: overpass.overpassQuery, host: overpass.host };
const FIXTURE = JSON.stringify(fixture);
const course = (): Course => JSON.parse(JSON.stringify(ranchoSolano)) as Course;
const file: GreensFile = {
  fetchedAt: '2026-11-28T00:00:00.000Z', source: 'test',
  holes: {
    1: { green: { lat: 1, lon: 2 }, greenShape: [[1, 2], [1, 3], [2, 3]] },
    2: { green: { lat: 3, lon: 4 }, greenShape: [[3, 4], [3, 5], [4, 5]] },
  },
};

describe('bundled greens merge', () => {
  it('fills holes with no green, from the file, and changes nothing else', () => {
    const c = course();
    const m = mergeGreens(c, file);
    expect(m.holes[0]).toEqual({ ...c.holes[0], green: { lat: 1, lon: 2 }, greenShape: [[1, 2], [1, 3], [2, 3]] });
    expect(m.holes[1].green).toEqual({ lat: 3, lon: 4 });
    expect(m.holes.slice(2)).toEqual(c.holes.slice(2));
    expect({ ...m, holes: [] }).toEqual({ ...c, holes: [] });
    expect(c.holes[0].green).toBeUndefined();          // the input is not changed
  });

  it('a hand-saved green, or one loaded on the phone, wins over the bundled one', () => {
    const c = course();
    c.holes[0] = { ...c.holes[0], green: { lat: 9, lon: 9 } };                             // saved by hand
    c.holes[1] = { ...c.holes[1], green: { lat: 8, lon: 8 }, greenShape: [[8, 8], [8, 9], [9, 9]] }; // loaded
    const m = mergeGreens(c, file);
    expect(m.holes[0]).toEqual(c.holes[0]);
    expect(m.holes[1]).toEqual(c.holes[1]);
  });

  it('hazards in the file fill every hole with none of its own, whoever saved its green', () => {
    const bunker = { kind: 'bunker' as const, shape: [[1, 2], [1, 2.1], [1.1, 2]] as [number, number][] };
    const mine = { kind: 'water' as const, shape: [[5, 5], [5, 6], [6, 6]] as [number, number][] };
    const f: GreensFile = { ...file, holes: { ...file.holes, 1: { ...file.holes[1], hazards: [bunker] }, 2: { ...file.holes[2], hazards: [bunker] }, 3: { ...file.holes[2], hazards: [bunker] } } };
    const c = course();
    c.holes[1] = { ...c.holes[1], green: { lat: 9, lon: 9 } };                             // saved by hand
    c.holes[2] = { ...c.holes[2], hazards: [mine] };                                      // already has its own
    const m = mergeGreens(c, f);
    expect(m.holes[0].hazards).toEqual([bunker]);
    expect(m.holes[1]).toEqual({ ...c.holes[1], hazards: [bunker] });
    expect(m.holes[2].hazards).toEqual([mine]);
    expect(m.holes[3].hazards).toBeUndefined();
    m.holes[0].hazards![0].shape[0][0] = 7;
    expect(bunker.shape[0][0]).toBe(1);                 // copied, not shared
  });

  it('an empty or missing file leaves the course as it is', () => {
    const c = course();
    expect(mergeGreens(c, undefined)).toBe(c);
    expect(mergeGreens(c, { fetchedAt: null, source: null, holes: {} })).toBe(c);
  });

  it('the shipped Rancho Solano has a location for the build-time lookup', () => {
    expect(bundledCourses[0].location).toEqual({ lat: 38.288, lon: -122.078 });
  });

  it("the user's own copy of a bundled course gets the bundled greens through findCourse", () => {
    const shipped = toGreensFile(shippedGreens);
    const mine = course();
    mine.holes[0] = { ...mine.holes[0], par: 4 };
    expect(findCourse('rancho-solano', { 'rancho-solano': mine })).toEqual(mergeGreens(mine, shipped));
  });
});

describe('toGreensFile', () => {
  it('keeps a well-formed file as it is', () => {
    expect(toGreensFile(JSON.parse(JSON.stringify(file)))).toEqual({ ...file, holes: { '1': file.holes[1], '2': file.holes[2] } });
  });

  it('drops points that are not two finite numbers, and holes with no usable centre', () => {
    const raw = {
      fetchedAt: 5, source: 'x',
      holes: {
        1: { green: { lat: 1, lon: 2 }, greenShape: [[1, 2], [1], [1, 2, 3], ['1', 2], [null, 2], [1, 3], 'p', [2, 3]] },
        2: { green: { lat: 'a', lon: 4 }, greenShape: [[3, 4]] },
        3: { green: { lat: 5, lon: 6 } },
        4: null,
      },
    };
    raw.holes[1].greenShape.push([Number.NaN, 1], [1, Infinity]);
    expect(toGreensFile(raw)).toEqual({
      fetchedAt: null, source: 'x',
      holes: { 1: { green: { lat: 1, lon: 2 }, greenShape: [[1, 2], [1, 3], [2, 3]] }, 3: { green: { lat: 5, lon: 6 }, greenShape: [] } },
    });
  });

  it('reads the newer shape with hazards, dropping bad ones, and the older shape without them', () => {
    const raw = {
      fetchedAt: 'x', source: 'y',
      holes: {
        1: { green: { lat: 1, lon: 2 }, greenShape: [[1, 2], [1, 3], [2, 3]], hazards: [
          { kind: 'bunker', shape: [[1, 2], [1, 3], [2, 3], ['a', 1]] },
          { kind: 'water', shape: [[1, 2], [1, 3], [2, 3]] },
          { kind: 'tree', shape: [[1, 2], [1, 3], [2, 3]] },
          { kind: 'water', shape: [[1, 2], [1, 3]] },
          null, 'x',
        ] },
        2: { green: { lat: 3, lon: 4 }, greenShape: [[3, 4], [3, 5], [4, 5]], hazards: 'none' },
        3: { green: { lat: 3, lon: 4 }, greenShape: [[3, 4], [3, 5], [4, 5]], hazards: [] },
      },
    };
    const t = toGreensFile(raw);
    expect(t.holes[1].hazards).toEqual([
      { kind: 'bunker', shape: [[1, 2], [1, 3], [2, 3]] }, { kind: 'water', shape: [[1, 2], [1, 3], [2, 3]] },
    ]);
    expect('hazards' in t.holes[2]).toBe(false);
    expect('hazards' in t.holes[3]).toBe(false);
  });

  it('anything that is not a greens file reads as an empty one', () => {
    for (const raw of [undefined, null, 3, 'x', [], { holes: 'no' }]) {
      expect(toGreensFile(raw)).toEqual({ fetchedAt: null, source: null, holes: {} });
    }
  });

  it('the shipped file reads with every point kept (however many holes it has)', () => {
    const t = toGreensFile(shippedGreens);
    expect(Object.keys(t.holes)).toEqual(Object.keys(shippedGreens.holes));
    for (const [n, h] of Object.entries(t.holes)) {
      expect(h.greenShape).toHaveLength((shippedGreens.holes as Record<string, { greenShape: unknown[] }>)[n].greenShape.length);
    }
  });
});

describe('scripts/fetch-greens.mjs on the fixture', () => {
  const at = { ...course(), location: { lat: 38.26, lon: -122.03 } };
  const files = new Map<string, string>();
  const io = { exists: (f: string) => files.has(f), read: (f: string) => files.get(f)!, write: (f: string, t: string) => { files.set(f, t); } };
  const run = async (plan: ('ok' | 'down' | 'empty')[], outFile: string) => {
    const log: string[] = [];
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const how = plan[urls.length - 1];
      if (how === 'down') return new Response('busy', { status: 504 });
      return new Response(how === 'empty' ? '{"elements":[]}' : FIXTURE);
    }) as unknown as typeof fetch;
    const r = await fetchGreens({ course: at, lib, outFile, fetchImpl, log: (l) => log.push(l), io, now: () => new Date('2026-11-28T12:00:00Z') });
    return { r, log, urls };
  };

  it('matches with the app’s matcher, logs what a CI reader needs, and writes the greens file', async () => {
    const out = 'a.greens.json';
    const { r, log, urls } = await run(['down', 'ok'], out);
    expect(urls).toEqual(overpass.OVERPASS_ENDPOINTS.slice(0, 2));
    expect(r).toEqual({ written: true, matched: 18, missing: [] });
    const text = log.join('\n');
    expect(text).toContain('overpass-api.de: HTTP 504');
    expect(text).toContain('overpass.private.coffee: HTTP 200, 44 elements');
    expect(text).toContain('Answer: 22 golf=hole ways, 22 golf=green polygons (21 ways, 1 relations)');
    expect(text).toContain('Matched 18 of 18');
    expect(text).toContain('Missing holes: none');
    const want = greens.matchGreens(fixture.elements as unknown as greens.OsmElement[], at.location, at.holes.map((h) => h.number));
    const g1 = want.greens.get(1)!;
    expect(text).toContain(`hole 1: green centre ${g1.centre.lat.toFixed(6)}, ${g1.centre.lon.toFixed(6)}`);
    const written = JSON.parse(files.get(out)!) as GreensFile;
    expect(written.fetchedAt).toBe('2026-11-28T12:00:00.000Z');
    expect(written.source).toBe('OpenStreetMap contributors, via overpass.private.coffee');
    expect(Object.keys(written.holes)).toHaveLength(18);
    expect(written.holes['1']).toEqual({ green: g1.centre, greenShape: g1.outline });
  });

  it('writes the hazards of each hole, one point per line, and logs them', async () => {
    // The fixture plus a bunker 30 m east of the bend in hole 1's line and a pond on hole 2's tee.
    const dn = 8 / 111_195, de = 8 / 87_500;
    const box = (id: number, lat: number, lon: number, tags: Record<string, string>) => ({ type: 'way', id, tags,
      geometry: [[-1, -1], [-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => ({ lat: lat + a * dn, lon: lon + b * de })) });
    const withHazards = JSON.stringify({ ...fixture, elements: [...fixture.elements,
      box(9001, 38.2623468, -122.0295197, { golf: 'bunker' }), box(9002, 38.26427, -122.02945, { natural: 'water' })] });
    const log: string[] = [];
    const out = 'h.greens.json';
    const r = await fetchGreens({ course: at, lib, outFile: out, log: (l: string) => log.push(l), io,
      fetchImpl: (async () => new Response(withHazards)) as unknown as typeof fetch, now: () => new Date('2026-11-28T12:00:00Z') });
    expect(r.written).toBe(true);
    const text = files.get(out)!;
    const written = toGreensFile(JSON.parse(text));
    expect(written.holes['1'].hazards!.map((h) => h.kind).sort()).toEqual(['bunker', 'water']);
    expect(written.holes['2'].hazards!.map((h) => h.kind)).toEqual(['water']);
    expect(written.holes['5'].hazards).toBeUndefined();
    expect(text).toMatch(/\n +\[38\.\d+, -122\.\d+\],?\n/);   // a point on one line
    expect(text.length).toBeLessThan(MAX_FILE_BYTES);
    expect(log).toContain('Hazards in the answer: 1 bunkers, 1 water');
    expect(log.join('\n')).toMatch(/hole 1: green centre .*; hazards: 1 bunker, 1 water/);
    expect(log.join('\n')).toMatch(/hole 5: green centre .*; hazards: none/);
    expect(formatGreensFile({ a: [[1.5, -2]] })).toBe('{\n "a": [\n  [1.5, -2]\n ]\n}\n');
  });

  it('the shipped file is under 200 KB', () => {
    expect(JSON.stringify(shippedGreens, null, 1).length).toBeLessThan(MAX_FILE_BYTES);
  });

  it('when every server fails, or nothing matches, the existing file is kept', async () => {
    const out = 'b.greens.json';
    files.set(out, JSON.stringify(file));
    const a = await run(['down', 'down', 'down', 'down'], out);
    expect(a.r.written).toBe(false);
    expect(a.log.at(-1)).toBe('No server gave a usable answer. Keeping the existing greens file (2 holes).');
    const b = await run(['empty'], out);
    expect(b.r.written).toBe(false);
    expect(b.log).toContain('Matched 0 of 18');
    expect(JSON.parse(files.get(out)!)).toEqual(file);
  });
});

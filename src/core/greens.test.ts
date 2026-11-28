import { describe, expect, it } from 'vitest';
import fixture from './greens.fixture.json';
import { haversineM, metresToYards, type LatLon } from './geo';
import {
  applyGreens, assembleRings, centroid, distanceLineToRingM, distanceToRingM, greenPolygons, holeLines, matchGreens, simplifyRing, yardage,
  type OsmElement,
} from './greens';
import type { Course } from './types';

// The fixture is a hand-built Overpass `out tags geom` answer: an 18-hole layout whose first tee is at 38.26, -122.03
// (hole 7's ref written "07", green 9 a two-way multipolygon, green 4 long with 64 points), a practice green tied to
// no hole, a hole line with ref "A", and a neighbouring course 1.1 km east with its own holes 1-3.
const elements = fixture.elements as unknown as OsmElement[];
const TEE1: LatLon = { lat: 38.26, lon: -122.03 };
const yd = (a: LatLon, b: LatLon) => metresToYards(haversineM(a, b));

describe('matching greens to holes', () => {
  it('finds all 18 greens on the course the player is on', () => {
    const r = matchGreens(elements, TEE1);
    expect(r.missing).toEqual([]);
    expect([...r.greens.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  it('reads "07" as hole 7 and ignores refs that are not hole numbers', () => {
    const refs = holeLines(elements).map((l) => l.ref);
    expect(refs).toContain(7);
    expect(refs.length).toBe(21);                       // 18 + the neighbour's 3; "A" dropped
  });

  it('a duplicated ref goes to the course whose tees are nearest the player', () => {
    const home = matchGreens(elements, TEE1).greens.get(1)!;
    expect(yd(TEE1, home.centre)).toBeLessThan(560);     // hole 1 of this course, ~517 yd from its tee
    // Standing on the neighbour's first tee, its holes 1-3 win.
    const east = holeLines(elements).filter((l) => l.ref === 1).find((l) => l.tee.lon > -122.02)!;
    const there = matchGreens(elements, east.tee);
    const g1 = there.greens.get(1)!;
    expect(yd(east.tee, g1.centre)).toBeGreaterThan(320);
    expect(yd(east.tee, g1.centre)).toBeLessThan(345);   // the neighbour's 300 m hole, not this course's hole 1
  });

  it('a hole whose green is more than 60 m from the end of its line is reported missing', () => {
    const lines = holeLines(elements);
    const h5 = lines.find((l) => l.ref === 5 && l.tee.lon < -122.02)!;
    // Remove every green within 60 m of hole 5's end, then put one back 70 m away.
    const near = (e: OsmElement) => e.tags?.golf === 'green' && greenPolygons([e]).some((p) => distanceToRingM(h5.end, p) <= 60);
    const kept = elements.filter((e) => !near(e));
    const r1 = matchGreens(kept, TEE1);
    expect(r1.missing).toEqual([5]);
    expect(r1.greens.size).toBe(17);
    const dLat = 70 / 111_195 + 10 / 111_195;           // ring of radius 10 m centred 80 m north: nearest edge at 70 m
    const ring = Array.from({ length: 12 }, (_, i) => {
      const t = (2 * Math.PI * i) / 12;
      return { lat: h5.end.lat + dLat + (10 * Math.sin(t)) / 111_195,
        lon: h5.end.lon + (10 * Math.cos(t)) / (111_195 * Math.cos((h5.end.lat * Math.PI) / 180)) };
    });
    const far: OsmElement = { type: 'way', id: 1, tags: { golf: 'green' }, geometry: [...ring, ring[0]] };
    expect(distanceToRingM(h5.end, greenPolygons([far])[0])).toBeCloseTo(70, 0);
    expect(matchGreens([...kept, far], TEE1).missing).toEqual([5]);
  });

  it('only asks for the holes the course has', () => {
    const r = matchGreens(elements, TEE1, [10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(r.greens.size).toBe(9);
    expect(r.missing).toEqual([]);
  });

  it('an answer with no golf features finds nothing', () => {
    const r = matchGreens([{ type: 'node', id: 1 }], TEE1);
    expect(r.greens.size).toBe(0);
    expect(r.missing.length).toBe(18);
  });
});

describe('polygons', () => {
  it('joins a multipolygon made of two outer ways into one ring', () => {
    const polys = greenPolygons(elements.filter((e) => e.type === 'relation'));
    expect(polys.length).toBe(1);
    expect(polys[0].length).toBe(48);                    // green 9: 48 points, closing point dropped
  });

  it('assembleRings reverses a piece that runs the wrong way', () => {
    const a = { lat: 0, lon: 0 }, b = { lat: 0, lon: 1 }, c = { lat: 1, lon: 1 };
    const rings = assembleRings([[a, b], [a, c], [c, b]]);
    expect(rings.length).toBe(1);
    expect(rings[0][0]).toEqual(a);
    expect(rings[0][rings[0].length - 1]).toEqual(a);
  });

  it('centroid of a square is its middle; of a lopsided L-shape is pulled toward the heavy arm', () => {
    const sq = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }, { lat: 0.001, lon: 0.001 }, { lat: 0.001, lon: 0 }];
    const c = centroid(sq);
    expect(c.lat).toBeCloseTo(0.0005, 9);
    expect(c.lon).toBeCloseTo(0.0005, 9);
    // L: 3x1 bottom bar plus 1x2 column on the left (area 5). Centroid x = (3*1.5 + 2*0.5)/5 = 1.1, y = (3*0.5 + 2*2)/5 = 1.1
    const u = 0.0001;
    const L = [[0, 0], [0, 3], [1, 3], [1, 1], [3, 1], [3, 0]].map(([y, x]) => ({ lat: y * u, lon: x * u }));
    const cl = centroid(L);
    expect(cl.lon / u).toBeCloseTo(1.1, 3);
    expect(cl.lat / u).toBeCloseTo(1.1, 3);
  });

  it('outlines are simplified to at most 40 points and stay true to the shape', () => {
    const r = matchGreens(elements, TEE1);
    for (const g of r.greens.values()) expect(g.outline.length).toBeLessThanOrEqual(40);
    const four = r.greens.get(4)!;                       // drawn with 64 points
    expect(four.outline.length).toBeLessThanOrEqual(40);
    expect(four.outline.length).toBeGreaterThanOrEqual(12);
    const full = greenPolygons(elements).find((p) => p.length === 64)!;
    // Every original point is within half a yard of the simplified outline.
    const ring = four.outline.map(([lat, lon]) => ({ lat, lon }));
    const worst = Math.max(...full.map((p) => {
      const d = distanceToRingM(p, ring);
      return d;
    }));
    expect(metresToYards(worst)).toBeLessThan(0.5);
    // A small ring is left alone.
    const small = full.slice(0, 20);
    expect(simplifyRing(small)).toEqual(small);
  });
});

describe('front, centre and back', () => {
  // A 20 m x 20 m square green whose south edge is 100 m north of the player.
  const m = 1 / 111_195;
  const P: LatLon = { lat: 38.25, lon: -122.04 };
  const kx = 1 / (111_195 * Math.cos((38.25 * Math.PI) / 180));
  const sq: [number, number][] = [[100, -10], [100, 10], [120, 10], [120, -10]].map(([n, e]) => [P.lat + n * m, P.lon + e * kx]);
  const centre = { lat: P.lat + 110 * m, lon: P.lon };

  it('front is the nearest point of the outline (on an edge), back the farthest corner', () => {
    const y = yardage(P, centre, sq);
    expect(y.centre).toBe(Math.round(110 / 0.9144));    // 120
    expect(y.front).toBe(Math.round(100 / 0.9144));      // 109
    expect(y.back).toBe(Math.round(Math.hypot(120, 10) / 0.9144)); // 132
  });

  it('with no outline only the centre is given', () => {
    expect(yardage(P, centre)).toEqual({ centre: 120 });
  });

  it('standing on the green: front is 0', () => {
    const on = { lat: P.lat + 105 * m, lon: P.lon };
    expect(yardage(on, centre, sq).front).toBe(0);
  });

  it('on the fixture: centre matches the haversine distance to the centroid', () => {
    const g = matchGreens(elements, TEE1).greens.get(1)!;
    const y = yardage(TEE1, g.centre, g.outline);
    expect(y.centre).toBe(Math.round(yd(TEE1, g.centre)));
    expect(y.front!).toBeLessThan(y.centre);
    expect(y.back!).toBeGreaterThan(y.centre);
    expect(y.back! - y.front!).toBeGreaterThan(15);
    expect(y.back! - y.front!).toBeLessThan(35);
  });
});

describe('saving on the course', () => {
  const course: Course = {
    id: 'c', name: 'C', verified: true, updatedAt: '', tees: [],
    holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1 })),
  };
  course.holes[0] = { ...course.holes[0], green: { lat: 1, lon: 2 } };   // saved by hand at the pin
  course.holes[1] = { ...course.holes[1], green: { lat: 3, lon: 4 }, greenShape: [[3, 4], [3, 5], [4, 4]] }; // from an earlier load

  it('keeps a hand-saved green, replaces an earlier map green, and never touches par or stroke index', () => {
    const found = matchGreens(elements, TEE1).greens;
    const next = applyGreens(course, found);
    expect(next.holes[0].green).toEqual({ lat: 1, lon: 2 });
    expect(next.holes[0].greenShape).toBeUndefined();
    expect(next.holes[1].green).toEqual(found.get(2)!.centre);
    expect(next.holes[1].greenShape!.length).toBe(found.get(2)!.outline.length);
    expect(next.holes.map((h) => [h.par, h.strokeIndex])).toEqual(course.holes.map((h) => [h.par, h.strokeIndex]));
    expect(course.holes[2].green).toBeUndefined();       // the input is not changed
  });

  it('"Replace mine" replaces the hand-saved green too', () => {
    const found = matchGreens(elements, TEE1).greens;
    const next = applyGreens(course, found, true);
    expect(next.holes[0].green).toEqual(found.get(1)!.centre);
  });
});

describe('hazards for each hole', () => {
  // Squares of `half` metres either side of a point, as Overpass ways.
  const sq = (id: number, c: LatLon, half: number, tags: Record<string, string>): OsmElement => {
    const dn = half / 111_195, de = half / (111_195 * Math.cos((c.lat * Math.PI) / 180));
    const g = [[-1, -1], [-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => ({ lat: c.lat + a * dn, lon: c.lon + b * de }));
    return { type: 'way', id, tags, geometry: g };
  };
  const east = (p: LatLon, m: number): LatLon => ({ lat: p.lat, lon: p.lon + m / (111_195 * Math.cos((p.lat * Math.PI) / 180)) });
  const MID1 = { lat: 38.2623468, lon: -122.0298626 };     // the bend of hole 1's line
  const extra: OsmElement[] = [
    sq(9001, east(MID1, 30), 8, { golf: 'bunker' }),        // 22 m from the line: hole 1
    sq(9002, east(MID1, 70), 8, { golf: 'bunker' }),        // 62 m from it: no hole
    // Between hole 1's green end and hole 2's tee: both holes.
    sq(9003, { lat: 38.26424, lon: -122.02975 }, 10, { natural: 'water' }),
    sq(9004, { lat: 38.2610, lon: -122.0299 }, 6, { golf: 'lateral_water_hazard' }),
    sq(9005, { lat: 38.2610, lon: -122.0303 }, 6, { golf: 'water_hazard' }),
    sq(9006, east(MID1, -30), 8, { golf: 'fairway' }),      // not a hazard
    {
      type: 'relation', id: 9007, tags: { type: 'multipolygon', golf: 'bunker' }, members: [
        { type: 'way', ref: 1, role: 'outer', geometry: sq(0, east(MID1, -25), 5, {}).geometry!.slice(0, 3) },
        { type: 'way', ref: 2, role: 'outer', geometry: sq(0, east(MID1, -25), 5, {}).geometry!.slice(2) },
      ],
    },
  ];
  const r = matchGreens([...elements, ...extra], TEE1);

  it('a hazard goes to every hole whose line passes within 45 m of it, as bunker or water', () => {
    const h1 = r.greens.get(1)!.hazards!;
    expect(h1.map((h) => h.kind).sort()).toEqual(['bunker', 'bunker', 'water', 'water', 'water']);
    const h2 = r.greens.get(2)!.hazards!;
    expect(h2.map((h) => h.kind)).toEqual(['water']);
    expect(h2[0].shape).toEqual(h1.find((h) => h.kind === 'water' && Math.abs(h.shape[0][0] - 38.26424) < 0.0002)!.shape);
    // Hole 5 is nowhere near any of them, and the fixture alone has no hazards.
    expect(r.greens.get(5)!.hazards).toBeUndefined();
    expect(matchGreens(elements, TEE1).greens.get(1)!.hazards).toBeUndefined();
  });

  it('hazard outlines are open rings of at most 30 points', () => {
    const ring = Array.from({ length: 80 }, (_, i) => ({
      lat: MID1.lat + (20 / 111_195) * Math.sin((i / 80) * 2 * Math.PI),
      lon: MID1.lon + (20 / 87_500) * Math.cos((i / 80) * 2 * Math.PI),
    }));
    const big = matchGreens([...elements, { type: 'way', id: 9100, tags: { natural: 'water' }, geometry: [...ring, ring[0]] }], TEE1);
    const w = big.greens.get(1)!.hazards!.find((h) => h.kind === 'water')!;
    expect(w.shape.length).toBeLessThanOrEqual(30);
    expect(w.shape.length).toBeGreaterThanOrEqual(8);
  });

  it('distance from a line to a ring: 0 where the line crosses it', () => {
    const ring = sq(0, MID1, 10, {}).geometry!.slice(0, 4) as LatLon[];
    expect(distanceLineToRingM([{ lat: 38.262, lon: -122.0298626 }, { lat: 38.2627, lon: -122.0298626 }], ring)).toBe(0);
    expect(distanceLineToRingM([east(MID1, 40), east(MID1, 60)], ring)).toBeCloseTo(30, 0);
  });

  it('applyGreens writes the hazards, also on a hole whose hand-saved green is kept', () => {
    const course: Course = {
      id: 'c', name: 'C', verified: true, updatedAt: '', tees: [],
      holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1 })),
    };
    course.holes[0] = { ...course.holes[0], green: { lat: 1, lon: 2 } };
    const next = applyGreens(course, r.greens);
    expect(next.holes[0].green).toEqual({ lat: 1, lon: 2 });
    expect(next.holes[0].hazards).toEqual(r.greens.get(1)!.hazards);
    expect(next.holes[1].hazards).toHaveLength(1);
    expect(next.holes[4].hazards).toBeUndefined();
  });
});

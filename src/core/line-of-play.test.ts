import { describe, expect, it } from 'vitest';
import { haversineM, type LatLon } from './geo';
import { centroid, yardage } from './greens';
import {
  addFix, aimPoint, greenLine, hazardLine, hazardsOnLine, holeYards, layup, smoothedFix, type HazardShape, type TimedFix,
} from './line-of-play';

// Shapes are drawn in metres north (n) and east (e) of a point P and turned into [lat, lon].
const P: LatLon = { lat: 38.25, lon: -122.04 };
const M_LAT = 1 / 111_195.08;
const M_LON = 1 / (111_195.08 * Math.cos((P.lat * Math.PI) / 180));
const at = (n: number, e: number): LatLon => ({ lat: P.lat + n * M_LAT, lon: P.lon + e * M_LON });
const shape = (pts: [number, number][]): [number, number][] => pts.map(([n, e]) => { const q = at(n, e); return [q.lat, q.lon]; });
const rect = (n0: number, n1: number, e0: number, e1: number) => shape([[n0, e0], [n0, e1], [n1, e1], [n1, e0]]);
const ringLL = (s: [number, number][]) => s.map(([lat, lon]) => ({ lat, lon }));
const close = (got: number | undefined, want: number, tol = 0.05) => {
  expect(got).toBeDefined();
  expect(Math.abs(got! - want)).toBeLessThan(tol);
};

describe('front, middle and back along the line of play', () => {
  // A green 15 m wide (east-west) and 30 m deep (north-south), its middle 115 m north of P.
  const green = rect(100, 130, -7.5, 7.5);
  const middle = at(115, 0);

  it('from the fairway: the crossings of the line with the green', () => {
    const g = greenLine(P, middle, green);
    expect(g.method).toBe('line');
    close(g.front, 100);
    close(g.middle, 115);
    close(g.back, 130);
  });

  it('from beside the green: the spread is the depth on his line (its width here), not nearest to farthest corner', () => {
    const side = at(115, 40);                               // 40 m east of the middle, level with it
    const g = greenLine(side, middle, green);
    close(g.front, 32.5);
    close(g.back, 47.5);
    expect(g.back! - g.front!).toBeCloseTo(15, 1);         // the green is 15 m across on this line
    // The old method gave nearest point to farthest corner: 32.5 to hypot(47.5, 15) = 49.8 m.
    const old = yardage(side, middle, green);
    expect(old.back).toBe(Math.round(Math.hypot(47.5, 15) / 0.9144));
    expect(holeYards(side, { green: middle, greenShape: green }).back).toBe(Math.round(47.5 / 0.9144));
  });

  it('on the green: front 0, back where the line leaves it beyond the middle', () => {
    const on = at(105, 0);
    const g = greenLine(on, middle, green);
    expect(g.front).toBe(0);
    close(g.middle, 10);
    close(g.back, 25);
  });

  it('a crescent green: the centroid falls outside it, so the line aims at a point on the green', () => {
    // A C-shape opening east: a 10 m thick arc of a ring of radius 20 m around (120, 0), from north round to south.
    const pts: [number, number][] = [];
    for (let a = 90; a <= 270; a += 15) pts.push([120 + 25 * Math.sin((a * Math.PI) / 180), 25 * Math.cos((a * Math.PI) / 180)]);
    for (let a = 270; a >= 90; a -= 15) pts.push([120 + 15 * Math.sin((a * Math.PI) / 180), 15 * Math.cos((a * Math.PI) / 180)]);
    const crescent = shape(pts);
    const c = centroid(ringLL(crescent));
    const aim = aimPoint(c, crescent);
    expect(haversineM(aim, c)).toBeGreaterThan(1);         // moved: the centroid is in the hollow
    const from = at(120, -200);                             // west, looking east at the back of the C
    const g = greenLine(from, c, crescent);
    expect(g.method).toBe('line');
    expect(g.front!).toBeLessThan(g.middle);
    expect(g.back!).toBeGreaterThan(g.middle);
    // On the line through the aim point the green is 10 m thick (from 175 to 185 m west to east).
    close(g.front, 175, 0.6);
    close(g.back, 185, 0.6);
  });

  it('a degenerate ring (all points on one line) falls back to nearest and farthest', () => {
    const flat = shape([[100, 0], [110, 0], [120, 0]]);
    const g = greenLine(P, at(110, 0), flat);
    expect(g.method).toBe('nearest-farthest');
    close(g.front, 100, 0.1);
    close(g.back, 120, 0.1);
  });

  it('standing on the aim point falls back too; with no outline only the middle is given', () => {
    expect(greenLine(middle, middle, green).method).toBe('nearest-farthest');
    const pin = greenLine(P, middle);
    expect(pin).toEqual({ middle: haversineM(P, middle), method: 'centre', target: middle });
    expect(holeYards(P, { green: middle })).toEqual({ centre: Math.round(115 / 0.9144), method: 'centre', hazards: [] });
  });

  it('the source library’s own case: a square 0.002 degrees across on the equator, from 0.003 degrees west', () => {
    const sq: [number, number][] = [[-0.001, -0.001], [-0.001, 0.001], [0.001, 0.001], [0.001, -0.001]];
    const g = greenLine({ lat: 0, lon: -0.003 }, { lat: 0, lon: 0 }, sq);
    close(g.front, 222.39, 0.1);
    close(g.back, 444.78, 0.1);
  });
});

describe('hazards on the line', () => {
  const target = at(400, 0);                                // the middle of the green, due north
  const hz = (kind: HazardShape['kind'], s: [number, number][]): HazardShape => ({ kind, shape: s });

  it('reach and carry of a hazard across the line', () => {
    const [w] = hazardsOnLine(P, target, [hz('water', rect(150, 170, -30, 30))]);
    expect(w.side).toBe('in line');
    close(w.reach, 150);
    close(w.carry, 170);
    expect(hazardLine({ kind: 'water', side: 'in line', reach: 164, carry: 186 })).toBe('Water in line: 164 to reach, 186 to carry');
  });

  it('a long lake is clipped to the 40 m corridor around the line', () => {
    // A strip 600 m long at 45 degrees to the line, between the edges e = n - 390 and e = n - 410. Unclipped, its
    // nearest point ahead would be 100 m out; inside |e| <= 20 it runs from n = 370 to n = 430.
    const strip = shape([[100, -290], [700, 310], [700, 290], [100, -310]]);
    const [w] = hazardsOnLine(P, at(600, 0), [hz('water', strip)]);
    close(w.reach, 370, 0.1);
    close(w.carry, 430, 0.1);
    expect(w.side).toBe('in line');
  });

  it('a hazard behind him is dropped; one beyond the back of the green is dropped', () => {
    expect(hazardsOnLine(P, target, [hz('bunker', rect(-50, -20, -5, 5))])).toEqual([]);
    expect(hazardsOnLine(P, target, [hz('bunker', rect(420, 430, -5, 5))], 410)).toEqual([]);
    const y = holeYards(P, { green: target, greenShape: rect(385, 415, -8, 8), hazards: [hz('bunker', rect(420, 430, -5, 5))] });
    expect(y.hazards).toEqual([]);
  });

  it('outside the corridor it is not in play', () => {
    expect(hazardsOnLine(P, target, [hz('bunker', rect(200, 220, 25, 40))])).toEqual([]);
  });

  it('side labels: left, right, in line; nearest first', () => {
    const r = hazardsOnLine(P, target, [
      hz('bunker', rect(300, 310, 8, 30)),                  // east: right of a line heading north
      hz('bunker', rect(250, 260, -30, -6)),                // west: left
      hz('water', rect(200, 210, -3, 3)),
    ]);
    expect(r.map((h) => [h.kind, h.side])).toEqual([['water', 'in line'], ['bunker', 'left'], ['bunker', 'right']]);
    close(r[1].reach, 250);
    close(r[2].carry, 310);
  });

  it('standing in a bunker: reach 0, carry to its far edge', () => {
    const [b] = hazardsOnLine(at(5, 0), target, [hz('bunker', rect(0, 12, -6, 6))]);
    expect(b.reach).toBe(0);
    close(b.carry, 7);
  });

  it('with no hazards there is nothing to list', () => {
    expect(hazardsOnLine(P, target, undefined)).toEqual([]);
    expect(holeYards(P, { green: target, greenShape: rect(385, 415, -8, 8) }).hazards).toEqual([]);
  });
});

describe('lay-up', () => {
  it('on a dogleg the lay-up point is on the playing line, not "middle minus remaining"', () => {
    const tee = at(0, 0), corner = at(0, 300), middle = at(300, 300);
    const l = layup(tee, [tee, corner, middle], middle, 100)!;
    close(haversineM(l.target, middle), 100, 0.1);
    expect(l.shotM).toBeGreaterThan(haversineM(tee, middle) - 100 + 20);
    expect(layup(middle, [tee, corner, middle], middle, 100)).toBeNull();
  });
});

describe('smoothing the fixes', () => {
  const f = (n: number, acc: number, t: number): TimedFix => ({ ...at(n, 0), acc, t });

  it('an accuracy-weighted average (weights 1 / accuracy squared); its accuracy is the weighted mean', () => {
    const s = smoothedFix(addFix([f(0, 5, 0)], f(10, 10, 1000)));
    close(haversineM(s, P), 2, 0.01);                       // (0 x 1/25 + 10 x 1/100) / (1/25 + 1/100)
    close(s.acc, 6, 1e-9);                                  // (5 x 1/25 + 10 x 1/100) / (1/25 + 1/100)
  });

  it('keeps at most 5 fixes, none more than 6 s older than the newest', () => {
    let k: TimedFix[] = [];
    for (let i = 0; i < 8; i++) k = addFix(k, f(i, 5, i * 1000));
    expect(k.map((x) => x.t)).toEqual([3000, 4000, 5000, 6000, 7000]);
    k = addFix(k, f(8, 5, 12_500));
    expect(k.map((x) => x.t)).toEqual([7000, 12_500]);
    k = addFix(k, f(9, 5, 20_000));
    expect(k.map((x) => x.t)).toEqual([20_000]);
  });

  it('a jump of more than 30 m starts afresh; a weak fix next to good ones is outweighed until they age out', () => {
    const k = addFix([f(0, 5, 0), f(1, 5, 1000)], f(40, 5, 2000));
    expect(k).toEqual([f(40, 5, 2000)]);
    const weak = smoothedFix(addFix([f(0, 6, 0)], f(5, 40, 1000)));
    expect(weak.acc).toBeLessThan(7);
    expect(smoothedFix(addFix([f(0, 6, 0)], f(5, 40, 7000))).acc).toBe(40);
  });
});

// Green positions from OpenStreetMap (plan section 15.1), the bunkers and water around each hole (16.1), and the old
// nearest / farthest yardage kept as the fallback of src/core/line-of-play.ts. Pure functions on the JSON an Overpass
// `out tags geom` query returns; no DOM, no network.
import { haversineM, metresToYards, type LatLon } from './geo';
import type { Course, Hole } from './types';

export type Hazard = NonNullable<Hole['hazards']>[number];

/** One element of an Overpass `out tags geom` answer (only the parts used here). */
export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: (LatLon | null)[];
  members?: { type: string; ref: number; role: string; geometry?: (LatLon | null)[] }[];
}

/** A green found for a hole: centre (polygon centroid) and outline as [lat, lon] pairs, at most 40 points; and the
 *  bunkers and water near the hole's line (outlines of at most 30 points), when any are mapped. */
export interface FoundGreen { centre: LatLon; outline: [number, number][]; hazards?: Hazard[] }

export interface GreensResult {
  greens: Map<number, FoundGreen>;   // by hole number
  missing: number[];                 // hole numbers 1-18 (of the asked set) with no green
}

/** A green farther than this from the end of its hole line is not that hole's green. */
export const MATCH_MAX_M = 60;
export const OUTLINE_MAX_POINTS = 40;
/** A hazard belongs to every hole whose golf=hole line passes within this distance of it. */
export const HAZARD_NEAR_M = 45;
export const HAZARD_MAX_POINTS = 30;

// ----- small planar helpers (local equirectangular projection; fine over a few hundred metres) -------------------

interface XY { x: number; y: number }
const RAD = Math.PI / 180;
const R = 6_371_008.8;

function projector(origin: LatLon) {
  const k = Math.cos(origin.lat * RAD);
  return {
    to: (p: LatLon): XY => ({ x: (p.lon - origin.lon) * RAD * R * k, y: (p.lat - origin.lat) * RAD * R }),
    from: (q: XY): LatLon => ({ lat: origin.lat + q.y / (R * RAD), lon: origin.lon + q.x / (R * RAD * k) }),
  };
}

function pointInRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function closestOnSegment(p: XY, a: XY, b: XY): XY {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

// ----- polygons --------------------------------------------------------------------------------------------------

const clean = (g: (LatLon | null)[] | undefined): LatLon[] =>
  (g ?? []).filter((p): p is LatLon => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon));

const same = (a: LatLon, b: LatLon) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;

/** Joins a relation's outer member ways end to end into closed rings. Unjoinable pieces become rings of their own. */
export function assembleRings(parts: LatLon[][]): LatLon[][] {
  const left = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: LatLon[][] = [];
  while (left.length) {
    let ring = left.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < left.length; i++) {
        const w = left[i];
        if (same(w[0], end)) ring = ring.concat(w.slice(1));
        else if (same(w[w.length - 1], end)) ring = ring.concat([...w].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

/** The outlines of a way or a relation (its outer rings), each as an open ring of at least 3 points. */
function ringsOf(e: OsmElement): LatLon[][] {
  const rings = e.type === 'way' ? [clean(e.geometry)]
    : e.type === 'relation' ? assembleRings((e.members ?? []).filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => clean(m.geometry)))
      : [];
  const out: LatLon[][] = [];
  for (const r of rings) {
    const ring = r.length > 1 && same(r[0], r[r.length - 1]) ? r.slice(0, -1) : r;
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

/** Every golf=green outline in the answer (ways, and the outer rings of relations), each as an open ring. */
export function greenPolygons(elements: OsmElement[]): LatLon[][] {
  return elements.filter((e) => e.tags?.golf === 'green').flatMap(ringsOf);
}

/** What kind of hazard an element is: golf=bunker is a bunker; natural=water, golf=water_hazard and
 *  golf=lateral_water_hazard are water. Anything else is not a hazard. */
export function hazardKind(tags: Record<string, string> | undefined): Hazard['kind'] | null {
  if (!tags) return null;
  if (tags.golf === 'bunker') return 'bunker';
  if (tags.natural === 'water' || tags.golf === 'water_hazard' || tags.golf === 'lateral_water_hazard') return 'water';
  return null;
}

/** Every bunker and water outline in the answer. */
export function hazardPolygons(elements: OsmElement[]): { kind: Hazard['kind']; ring: LatLon[] }[] {
  const out: { kind: Hazard['kind']; ring: LatLon[] }[] = [];
  for (const e of elements) {
    const kind = hazardKind(e.tags);
    if (kind) for (const ring of ringsOf(e)) out.push({ kind, ring });
  }
  return out;
}

/** Area centroid of a ring (falls back to the vertex mean for a degenerate one). */
export function centroid(ring: LatLon[]): LatLon {
  const pr = projector(ring[0]);
  const pts = ring.map(pr.to);
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    a += f; cx += (pts[j].x + pts[i].x) * f; cy += (pts[j].y + pts[i].y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    return { lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length, lon: ring.reduce((s, p) => s + p.lon, 0) / ring.length };
  }
  return pr.from({ x: cx / (3 * a), y: cy / (3 * a) });
}

/** Ramer-Douglas-Peucker on a closed ring, tolerance raised until it has at most `max` points. */
export function simplifyRing(ring: LatLon[], max = OUTLINE_MAX_POINTS): LatLon[] {
  if (ring.length <= max) return ring;
  const pr = projector(ring[0]);
  const pts = ring.map(pr.to);
  // Split the ring at its first point and the point farthest from it, then simplify both halves.
  let far = 0;
  for (let i = 1; i < pts.length; i++) if (dist(pts[i], pts[0]) > dist(pts[far], pts[0])) far = i;
  const rdp = (idx: number[], tol: number): number[] => {
    if (idx.length < 3) return idx;
    const a = pts[idx[0]], b = pts[idx[idx.length - 1]];
    let worst = 0, at = 0;
    for (let i = 1; i < idx.length - 1; i++) {
      const d = dist(pts[idx[i]], closestOnSegment(pts[idx[i]], a, b));
      if (d > worst) { worst = d; at = i; }
    }
    if (worst <= tol) return [idx[0], idx[idx.length - 1]];
    const l = rdp(idx.slice(0, at + 1), tol);
    return l.slice(0, -1).concat(rdp(idx.slice(at), tol));
  };
  const first = Array.from({ length: far + 1 }, (_, i) => i);
  const second = Array.from({ length: pts.length - far + 1 }, (_, i) => (far + i) % pts.length);
  for (let tol = 0.05; ; tol *= 1.5) {
    const keep = rdp(first, tol).slice(0, -1).concat(rdp(second, tol).slice(0, -1));
    if (keep.length <= max) return keep.map((i) => ring[i]);
  }
}

/** Metres from a point to a ring: 0 inside it, else to the nearest edge. */
export function distanceToRingM(p: LatLon, ring: LatLon[]): number {
  const pr = projector(p);
  const pts = ring.map(pr.to);
  const o = { x: 0, y: 0 };
  if (pointInRing(o, pts)) return 0;
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) best = Math.min(best, dist(o, closestOnSegment(o, pts[j], pts[i])));
  return best;
}

function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const cr = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cr(c, d, a), d2 = cr(c, d, b), d3 = cr(a, b, c), d4 = cr(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Metres from a line (a hole's path) to a ring: 0 where the line enters it, else the closest approach. */
export function distanceLineToRingM(line: LatLon[], ring: LatLon[]): number {
  const pr = projector(line[0]);
  const l = line.map(pr.to), r = ring.map(pr.to);
  if (l.some((p) => pointInRing(p, r))) return 0;
  let best = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    for (let k = 0; k < l.length; k++) {
      best = Math.min(best, dist(l[k], closestOnSegment(l[k], r[j], r[i])));
      if (k + 1 < l.length) {
        if (segmentsCross(l[k], l[k + 1], r[j], r[i])) return 0;
        best = Math.min(best, dist(r[i], closestOnSegment(r[i], l[k], l[k + 1])));
      }
    }
  }
  return best;
}

// ----- holes -----------------------------------------------------------------------------------------------------

interface HoleLine { ref: number; tee: LatLon; end: LatLon; path: LatLon[] }

/** golf=hole ways with a whole-number `ref` from 1 to 18 ("7" and "07" both mean hole 7; "7A" or "East 7" are ignored). */
export function holeLines(elements: OsmElement[]): HoleLine[] {
  const out: HoleLine[] = [];
  for (const e of elements) {
    if (e.type !== 'way' || e.tags?.golf !== 'hole') continue;
    const ref = (e.tags.ref ?? '').trim();
    if (!/^\d{1,2}$/.test(ref)) continue;
    const n = Number(ref);
    const g = clean(e.geometry);
    if (n < 1 || n > 18 || g.length < 2) continue;
    out.push({ ref: n, tee: g[0], end: g[g.length - 1], path: g });
  }
  return out;
}

/**
 * One hole line per number. Where a number appears more than once (two courses side by side), the course the player
 * is on wins: start from the hole whose tee is nearest the player, then follow the routing outwards (the next hole's
 * tee is near this hole's green; the previous hole's green is near this hole's tee), so the holes kept are one set.
 */
export function pickHoleSet(lines: HoleLine[], player: LatLon): Map<number, HoleLine> {
  const chosen = new Map<number, HoleLine>();
  if (!lines.length) return chosen;
  const start = lines.reduce((a, b) => (haversineM(player, b.tee) < haversineM(player, a.tee) ? b : a));
  chosen.set(start.ref, start);
  const nearest = (cands: HoleLine[], to: LatLon, key: 'tee' | 'end') =>
    cands.reduce((a, b) => (haversineM(to, b[key]) < haversineM(to, a[key]) ? b : a));
  let prev = start;
  for (let n = start.ref + 1; n <= 18; n++) {
    const c = lines.filter((l) => l.ref === n);
    if (!c.length) continue;
    prev = nearest(c, prev.end, 'tee');
    chosen.set(n, prev);
  }
  let next = start;
  for (let n = start.ref - 1; n >= 1; n--) {
    const c = lines.filter((l) => l.ref === n);
    if (!c.length) continue;
    next = nearest(c, next.tee, 'end');
    chosen.set(n, next);
  }
  return chosen;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const roundPoint = (p: LatLon) => [round6(p.lat), round6(p.lon)] as [number, number];

/**
 * The green for each hole: the golf=green polygon that contains the last point of the hole line, else the nearest one
 * within 60 m. `holes` are the hole numbers asked for (the course's holes); any without a green are `missing`. Each
 * green found carries the bunkers and water within 45 m of its hole's line (one hazard may go to two holes).
 */
export function matchGreens(elements: OsmElement[], player: LatLon, holes: number[] = range18()): GreensResult {
  const polys = greenPolygons(elements);
  const hz = hazardPolygons(elements);
  const set = pickHoleSet(holeLines(elements), player);
  const greens = new Map<number, FoundGreen>();
  for (const [n, line] of set) {
    if (!holes.includes(n)) continue;
    let best: LatLon[] | null = null, bestD = Infinity;
    for (const p of polys) {
      const d = distanceToRingM(line.end, p);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best || bestD > MATCH_MAX_M) continue;
    const c = centroid(best);
    const hazards = hz.filter((h) => distanceLineToRingM(line.path, h.ring) <= HAZARD_NEAR_M)
      .map((h) => ({ kind: h.kind, shape: simplifyRing(h.ring, HAZARD_MAX_POINTS).map(roundPoint) }));
    greens.set(n, {
      centre: { lat: round6(c.lat), lon: round6(c.lon) },
      outline: simplifyRing(best).map(roundPoint),
      ...(hazards.length ? { hazards } : {}),
    });
  }
  return { greens, missing: holes.filter((n) => !greens.has(n)) };
}

function range18() { return Array.from({ length: 18 }, (_, i) => i + 1); }

// ----- saving on the course --------------------------------------------------------------------------------------

export const copyHazards = (hz: Hazard[]): Hazard[] =>
  hz.map((h) => ({ kind: h.kind, shape: h.shape.map((p) => [p[0], p[1]] as [number, number]) }));

/** A green he saved himself by standing at the pin: a centre with no outline. */
export const isHandSaved = (h: Hole) => !!h.green && !h.greenShape;

/**
 * The course with the found greens written on its holes. Holes saved by hand keep their green unless `replaceMine`.
 * Hazards found are written on every hole they belong to (a hand-saved green keeps them too). Par, stroke index and
 * everything else on the course stay as they are.
 */
export function applyGreens(course: Course, found: Map<number, FoundGreen>, replaceMine = false): Course {
  return {
    ...course,
    holes: course.holes.map((h) => {
      const g = found.get(h.number);
      if (!g) return h;
      const hazards = g.hazards?.length ? { hazards: copyHazards(g.hazards) } : {};
      if (isHandSaved(h) && !replaceMine) return { ...h, ...hazards };
      return { ...h, green: { ...g.centre }, greenShape: g.outline.map((p) => [p[0], p[1]] as [number, number]), ...hazards };
    }),
  };
}

// ----- yardage (the fallback) ------------------------------------------------------------------------------------

export interface Yardage { centre: number; front?: number; back?: number }

/** Metres from the player to the nearest point of an outline (on an edge; 0 on it) and to its farthest point (a vertex). */
export function nearestFarthestM(player: LatLon, shape: [number, number][]): { front: number; back: number } {
  const ring = shape.map(([lat, lon]) => ({ lat, lon }));
  const pr = projector(player);
  const pts = ring.map(pr.to);
  const o = { x: 0, y: 0 };
  let near = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) near = Math.min(near, dist(o, closestOnSegment(o, pts[j], pts[i])));
  if (pointInRing(o, pts)) near = 0;
  return { front: near, back: Math.max(...ring.map((p) => haversineM(player, p))) };
}

/**
 * Whole yards to the green centre and the nearest and farthest points of its outline. This is no longer what the panel
 * shows (that is src/core/line-of-play.ts, along the line of play); it is the fallback when the line finds no crossing.
 */
export function yardage(player: LatLon, green: LatLon, shape?: [number, number][]): Yardage {
  const centre = Math.round(metresToYards(haversineM(player, green)));
  if (!shape || shape.length < 3) return { centre };
  const nf = nearestFarthestM(player, shape);
  return { centre, front: Math.round(metresToYards(nf.front)), back: Math.round(metresToYards(nf.back)) };
}

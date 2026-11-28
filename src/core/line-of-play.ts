// Distances along the line of play (plan section 16.1): front / middle / back of the green on the line from where he
// stands to the middle of the green, hazards in play on that line (reach and carry), a lay-up point, and smoothing of
// the GPS fixes so the numbers do not flicker. Pure functions, no DOM.
//
// Ported from src/pkjs/distance.js of pebble-watch-golf (yardages, pointInside and the hazard and lay-up ideas;
// the hazard method here clips the hazard to a corridor around the line instead of a ray to the hazard's centre):
//   MIT License. Copyright (c) 2026 John Suh. The full licence text is in THIRD-PARTY-NOTICES.md.
import { haversineM, metresToYards, type LatLon } from './geo';
import { centroid, nearestFarthestM } from './greens';
import type { Hole } from './types';

export type HazardShape = NonNullable<Hole['hazards']>[number];
export type Side = 'left' | 'right' | 'in line';

/** Half the width of the corridor around the line in which a hazard is in play: 40 m wide in all. */
export const CORRIDOR_HALF_M = 20;

// ----- local plane around one point (equirectangular; fine over a few kilometres) ---------------------------------

interface XY { x: number; y: number }
const RAD = Math.PI / 180;
const R = 6_371_008.8;

export function projection(origin: LatLon) {
  const k = Math.cos(origin.lat * RAD);
  return {
    xy: (p: LatLon): XY => ({ x: (p.lon - origin.lon) * RAD * R * k, y: (p.lat - origin.lat) * RAD * R }),
    point: (q: XY): LatLon => ({ lat: origin.lat + q.y / (R * RAD), lon: origin.lon + q.x / (R * RAD * k) }),
  };
}

const ringOf = (shape: [number, number][]): LatLon[] => shape.map(([lat, lon]) => ({ lat, lon }));

/** True when the point is inside the ring (ray casting; the ring may be open or closed). */
export function pointInside(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function areaM2(ring: XY[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  return Math.abs(a) / 2;
}

/** Distances t along the ray from the origin in direction d (a unit vector) at which it crosses the ring's edges. */
function crossings(d: XY, ring: XY[]): number[] {
  const hits: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const ex = b.x - a.x, ey = b.y - a.y, den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (a.x * ey - a.y * ex) / den;
    const u = (a.x * d.y - a.y * d.x) / den;
    if (u >= 0 && u <= 1) hits.push(t);
  }
  hits.sort((a, b) => a - b);
  // A ray through a vertex meets both of its edges: count that crossing once.
  return hits.filter((t, i) => i === 0 || t - hits[i - 1] > 1e-6);
}

/**
 * A point inside the ring to aim at: the centre given when it is inside (a green's area centroid usually is), else
 * the middle of the stretch of green nearest it on a north-south or east-west line through it (a crescent green's
 * centroid falls outside the green).
 */
export function aimPoint(centre: LatLon, shape: [number, number][]): LatLon {
  const pr = projection(centre);
  const ring = ringOf(shape).map(pr.xy);
  const o = { x: 0, y: 0 };
  if (ring.length < 3 || pointInside(o, ring)) return centre;
  let best: XY | null = null;
  for (const axis of ['x', 'y'] as const) {
    const other = axis === 'x' ? 'y' : 'x';
    const cuts: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      if ((a[other] > 0) !== (b[other] > 0)) cuts.push(a[axis] + ((0 - a[other]) * (b[axis] - a[axis])) / (b[other] - a[other]));
    }
    cuts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k += 2) {
      const mid = (cuts[k] + cuts[k + 1]) / 2;
      const q = axis === 'x' ? { x: mid, y: 0 } : { x: 0, y: mid };
      if (!best || Math.hypot(q.x, q.y) < Math.hypot(best.x, best.y)) best = q;
    }
  }
  return best ? pr.point(best) : centre;
}

// ----- the green --------------------------------------------------------------------------------------------------

/** Metres along the line of play. `front` / `back` are absent without an outline. `method` says how they were found. */
export interface GreenLineM {
  middle: number; front?: number; back?: number;
  method: 'line' | 'nearest-farthest' | 'centre';
  target: LatLon;
}

/**
 * Front / middle / back of the green on the line from the player to the middle of the green: the ring is crossed by
 * the ray player -> target; front is the last crossing before the target, back the first after it. On the green,
 * front is 0 and back is where the line leaves it beyond the target. With no usable crossing (a degenerate ring, or
 * standing on the target) it falls back to the nearest and farthest points of the outline.
 */
export function greenLine(player: LatLon, green: LatLon, shape?: [number, number][]): GreenLineM {
  if (!shape || shape.length < 3) return { middle: haversineM(player, green), method: 'centre', target: green };
  const pr = projection(player);
  const ring = ringOf(shape).map(pr.xy);
  const degenerate = areaM2(ring) < 1;
  const target = degenerate ? centroid(ringOf(shape)) : aimPoint(green, shape);
  const middle = haversineM(player, target);
  const fallback = (): GreenLineM => ({ middle, ...nearestFarthestM(player, shape), method: 'nearest-farthest', target });
  if (degenerate) return fallback();
  const c = pr.xy(target), len = Math.hypot(c.x, c.y);
  if (len < 0.01) return fallback();
  const hits = crossings({ x: c.x / len, y: c.y / len }, ring);
  const before = hits.filter((t) => t <= len), after = hits.filter((t) => t >= len);
  if (pointInside({ x: 0, y: 0 }, ring)) {
    if (!after.length) return fallback();
    return { middle, front: 0, back: after[0], method: 'line', target };
  }
  if (!before.length || !after.length || before[before.length - 1] <= 0) return fallback();
  return { middle, front: before[before.length - 1], back: after[0], method: 'line', target };
}

// ----- hazards ----------------------------------------------------------------------------------------------------

export interface HazardLineM { kind: HazardShape['kind']; side: Side; reach: number; carry: number }

type AC = { a: number; c: number };   // a: metres along the line, c: metres to its left (negative: right)

/** Sutherland-Hodgman: the part of the polygon on the side of one straight line where f(p) >= 0. */
function clip(poly: AC[], f: (p: AC) => number): AC[] {
  const out: AC[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = f(p), fq = f(q);
    if (fp >= 0) out.push(p);
    if ((fp >= 0) !== (fq >= 0)) {
      const t = fp / (fp - fq);
      out.push({ a: p.a + t * (q.a - p.a), c: p.c + t * (q.c - p.c) });
    }
  }
  return out;
}

/**
 * Hazards in play on the line from the player to `target`, nearest first. Each hazard is clipped to the 40 m wide
 * corridor around the line, ahead of the player; reach is the nearest point of what is left (0 when he stands in it),
 * carry the farthest. A hazard with nothing in the corridor ahead, or starting beyond `beyondM` (the back of the
 * green), is dropped. Side: left or right of the line, or in line when it crosses it.
 */
export function hazardsOnLine(player: LatLon, target: LatLon, hazards: HazardShape[] | undefined, beyondM = Infinity): HazardLineM[] {
  if (!hazards?.length) return [];
  const pr = projection(player);
  const t = pr.xy(target), len = Math.hypot(t.x, t.y);
  if (len < 0.01) return [];
  const u = { x: t.x / len, y: t.y / len };
  const out: HazardLineM[] = [];
  for (const h of hazards) {
    if (!h.shape || h.shape.length < 3) continue;
    const ring = ringOf(h.shape).map(pr.xy);
    let poly: AC[] = ring.map((p) => ({ a: p.x * u.x + p.y * u.y, c: -p.x * u.y + p.y * u.x }));
    poly = clip(poly, (p) => p.a);
    poly = clip(poly, (p) => CORRIDOR_HALF_M - p.c);
    poly = clip(poly, (p) => p.c + CORRIDOR_HALF_M);
    if (poly.length < 3) continue;
    const as = poly.map((p) => p.a), cs = poly.map((p) => p.c);
    const reach = pointInside({ x: 0, y: 0 }, ring) ? 0 : Math.max(0, Math.min(...as));
    const carry = Math.max(...as);
    if (reach > beyondM) continue;
    const lo = Math.min(...cs), hi = Math.max(...cs);
    const side: Side = lo <= 0 && hi >= 0 ? 'in line' : lo > 0 ? 'left' : 'right';
    out.push({ kind: h.kind, side, reach, carry });
  }
  return out.sort((a, b) => a.reach - b.reach || a.carry - b.carry);
}

// ----- what the panel shows ---------------------------------------------------------------------------------------

export interface HazardYards { kind: HazardShape['kind']; side: Side; reach: number; carry: number }
export interface HoleYards {
  centre: number; front?: number; back?: number;
  method: GreenLineM['method'];
  hazards: HazardYards[];
}

const yd = (m: number) => Math.round(metresToYards(m));

/** Whole yards to the green (front / middle / back on the line of play) and to the hazards in play, nearest first. */
export function holeYards(player: LatLon, hole: Pick<Hole, 'green' | 'greenShape' | 'hazards'> & { green: LatLon }): HoleYards {
  const g = greenLine(player, hole.green, hole.greenShape);
  const hz = hazardsOnLine(player, g.target, hole.hazards, g.back ?? g.middle);
  return {
    centre: yd(g.middle),
    ...(g.front !== undefined ? { front: yd(g.front) } : {}),
    ...(g.back !== undefined ? { back: yd(g.back) } : {}),
    method: g.method,
    hazards: hz.map((h) => ({ kind: h.kind, side: h.side, reach: yd(h.reach), carry: yd(h.carry) })),
  };
}

/** "Bunker left: 212 to reach, 228 to carry". */
export function hazardLine(h: HazardYards): string {
  return `${h.kind === 'water' ? 'Water' : 'Bunker'} ${h.side}: ${h.reach} to reach, ${h.carry} to carry`;
}

// ----- lay-up -----------------------------------------------------------------------------------------------------

/**
 * The point on the hole's playing line (tee -> ... -> green, as mapped) that leaves `remainingM` to the middle of the
 * green, and the length of the shot from the player to it. On a dogleg this is not "middle minus remaining". Null when
 * he is already that close, or when the point would send him backwards.
 */
export function layup(player: LatLon, path: LatLon[], middle: LatLon, remainingM: number): { shotM: number; target: LatLon } | null {
  if (!(remainingM > 0) || haversineM(player, middle) <= remainingM || path.length < 1) return null;
  const pr = projection(middle);
  const pts = [...path.slice(0, -1), middle].map(pr.xy);
  if (pts.length < 2) pts.unshift(pr.xy(player));
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i], b = pts[i + 1];
    const dx = a.x - b.x, dy = a.y - b.y, aa = dx * dx + dy * dy;
    if (aa < 1e-6) continue;
    const bb = 2 * (b.x * dx + b.y * dy), cc = b.x * b.x + b.y * b.y - remainingM * remainingM;
    const disc = bb * bb - 4 * aa * cc;
    if (disc < 0) continue;
    for (const s of [(-bb - Math.sqrt(disc)) / (2 * aa), (-bb + Math.sqrt(disc)) / (2 * aa)]) {
      if (s < 0 || s > 1) continue;
      const target = pr.point({ x: b.x + s * dx, y: b.y + s * dy });
      const pp = projection(player), toward = pp.xy(middle), shot = pp.xy(target);
      if (shot.x * toward.x + shot.y * toward.y <= 0) return null;
      return { shotM: haversineM(player, target), target };
    }
  }
  return null;
}

// ----- smoothing --------------------------------------------------------------------------------------------------

export interface TimedFix extends LatLon { acc: number; t: number }
export const SMOOTH_MAX_FIXES = 5;
export const SMOOTH_MAX_AGE_MS = 6000;
export const SMOOTH_JUMP_M = 30;

const weight = (acc: number) => 1 / Math.max(1, acc) ** 2;

/** The accuracy-weighted average of the fixes kept (weights 1 / accuracy squared); its accuracy is the weighted mean. */
export function smoothedFix(fixes: TimedFix[]): LatLon & { acc: number } {
  let w = 0, lat = 0, lon = 0, acc = 0;
  for (const f of fixes) { const k = weight(f.acc); w += k; lat += k * f.lat; lon += k * f.lon; acc += k * f.acc; }
  return { lat: lat / w, lon: lon / w, acc: acc / w };
}

/**
 * The fixes to average after a new one arrives: the new one and up to four before it that are no more than 6 s older
 * than it. A jump of more than 30 m from the current average starts afresh from the new fix.
 */
export function addFix(kept: TimedFix[], fix: TimedFix): TimedFix[] {
  const recent = kept.filter((f) => fix.t - f.t <= SMOOTH_MAX_AGE_MS && f.t <= fix.t);
  if (recent.length && haversineM(smoothedFix(recent), fix) > SMOOTH_JUMP_M) return [fix];
  return [...recent, fix].slice(-SMOOTH_MAX_FIXES);
}

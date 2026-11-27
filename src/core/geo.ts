// GPS distances for the distance finder (plan section 12.2). Pure functions, no DOM.

export interface LatLon { lat: number; lon: number }

/** Mean Earth radius (IUGG), metres. */
export const EARTH_RADIUS_M = 6_371_008.8;
export const M_PER_YD = 0.9144;

/** Great-circle distance in metres (haversine). */
export function haversineM(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const metresToYards = (m: number) => m / M_PER_YD;

/** Distance in whole yards. */
export function distanceYards(a: LatLon, b: LatLon): number {
  return Math.round(metresToYards(haversineM(a, b)));
}

/** A reported GPS accuracy (metres) as whole yards, at least 1. */
export function accuracyYards(m: number): number {
  return Math.max(1, Math.round(metresToYards(m)));
}

/** A usable fix: finite coordinates inside the valid ranges. */
export function validFix(p: { lat: number; lon: number }): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

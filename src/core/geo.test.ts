import { describe, expect, it } from 'vitest';
import { accuracyYards, distanceYards, EARTH_RADIUS_M, haversineM, metresToYards, validFix } from './geo';

describe('haversine', () => {
  it('0.001 degrees of latitude is R x 0.001 x pi / 180 = 111.195 m = 121.6 yd', () => {
    const m = haversineM({ lat: 38.2, lon: -122.0 }, { lat: 38.201, lon: -122.0 });
    expect(m).toBeCloseTo((EARTH_RADIUS_M * 0.001 * Math.PI) / 180, 3);
    expect(distanceYards({ lat: 38.2, lon: -122.0 }, { lat: 38.201, lon: -122.0 })).toBe(122);
  });
  it('0.001 degrees of longitude at 38.2 N is shorter by cos(lat): about 87.4 m', () => {
    const m = haversineM({ lat: 38.2, lon: -122.0 }, { lat: 38.2, lon: -121.999 });
    expect(m).toBeCloseTo(((EARTH_RADIUS_M * 0.001 * Math.PI) / 180) * Math.cos((38.2 * Math.PI) / 180), 1);
  });
  it('a known long distance: one degree of latitude on a meridian is 111.2 km', () => {
    expect(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) / 1000).toBeCloseTo(111.195, 2);
  });
  it('is symmetric and zero for the same point', () => {
    const a = { lat: 38.25, lon: -122.04 }, b = { lat: 38.2512, lon: -122.0387 };
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 9);
    expect(haversineM(a, a)).toBe(0);
  });
  it('antipodes do not overflow', () => {
    expect(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 0);
  });
});

describe('units', () => {
  it('metres to yards', () => {
    expect(metresToYards(0.9144)).toBeCloseTo(1, 9);
    expect(accuracyYards(4.57)).toBe(5);
    expect(accuracyYards(0)).toBe(1);
  });
  it('validFix', () => {
    expect(validFix({ lat: 38, lon: -122 })).toBe(true);
    expect(validFix({ lat: 91, lon: 0 })).toBe(false);
    expect(validFix({ lat: NaN, lon: 0 })).toBe(false);
  });
});

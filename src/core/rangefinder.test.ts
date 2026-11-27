import { describe, expect, it } from 'vitest';
import { clampFlagFt, distanceYd, effectiveF35, focalPx, hasDigitalZoom, LENSES, measure, spanPx } from './rangefinder';

describe('focalPx', () => {
  it('uses the image diagonal against the 43.27 mm full-frame diagonal', () => {
    // 4032 x 3024 has a 5040 px diagonal: 26 mm -> 26 x 5040 / 43.27 = 3028.4 px.
    expect(focalPx(26, 4032, 3024)).toBeCloseTo(3028.43, 1);
  });
  it('is the same for portrait and landscape', () => {
    expect(focalPx(26, 3024, 4032)).toBe(focalPx(26, 4032, 3024));
  });
  it('scales with a proportional resize', () => {
    expect(focalPx(52, 2016, 1512) * 2).toBeCloseTo(focalPx(52, 4032, 3024), 9);
  });
});

describe('measure', () => {
  it('worked example: a 7 ft stick 42 px tall in a 4032 x 3024 photo at 26 mm is 168 yd', () => {
    const m = measure({ flagFt: 7, f35: 26, width: 4032, height: 3024, heightPx: 42 });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.exact).toBeCloseTo(168.25, 1);
    expect(m.yards).toBe(168);
    // 2 px error: 40 px -> 176.7 yd, 44 px -> 160.6 yd; half the spread is 8 yd.
    expect(m.plusMinus).toBe(8);
  });
  it('gives the same answer in portrait', () => {
    const a = measure({ flagFt: 7, f35: 26, width: 4032, height: 3024, heightPx: 42 });
    const b = measure({ flagFt: 7, f35: 26, width: 3024, height: 4032, heightPx: 42 });
    expect(b).toEqual(a);
  });
  it('3x lens, 8 ft stick: 8 x (77 x 5040 / 43.27) / 120 / 3 = 199 yd', () => {
    const m = measure({ flagFt: 8, f35: 77, width: 4032, height: 3024, heightPx: 120 });
    expect(m.ok && m.yards).toBe(199);
    expect(m.ok && m.plusMinus).toBe(3);
  });
  it('digital zoom: the EXIF focal length is used as written unless he applies the zoom', () => {
    expect(effectiveF35(39, 1.5)).toBe(39);                 // iPhone: 1.5x on 26 mm is already written as 39 mm
    expect(effectiveF35(26, 2, true)).toBe(52);
    expect(effectiveF35(26, 1.03, true)).toBe(26);          // at or below 1.05 counts as no zoom
    expect(effectiveF35(26, 0, true)).toBe(26);
    expect(effectiveF35(26, undefined, true)).toBe(26);
    // 26 mm as written, 84 px stick: 7 x 3028.4 / 84 / 3 = 84 yd; with 2x applied, 168 yd.
    const asWritten = measure({ flagFt: 7, f35: effectiveF35(26, 2), width: 4032, height: 3024, heightPx: 84 });
    expect(asWritten.ok && asWritten.yards).toBe(84);
    expect(asWritten.ok && asWritten.plusMinus).toBe(2);
    const applied = measure({ flagFt: 7, f35: effectiveF35(26, 2, true), width: 4032, height: 3024, heightPx: 84 });
    expect(applied.ok && applied.yards).toBe(168);
  });
  it('hasDigitalZoom ignores ratios of 1.05 and below', () => {
    expect([undefined, 0, 1, 1.05, 1.06, 2].map(hasDigitalZoom)).toEqual([false, false, false, false, true, true]);
  });
  it('refuses a span too short to read and bad input', () => {
    expect(measure({ flagFt: 7, f35: 26, width: 4032, height: 3024, heightPx: 4 })).toEqual({ ok: false, reason: 'too-short' });
    expect(measure({ flagFt: 7, f35: 0, width: 4032, height: 3024, heightPx: 40 })).toEqual({ ok: false, reason: 'bad-input' });
    expect(measure({ flagFt: 7, f35: 26, width: 4032, height: 3024, heightPx: NaN })).toEqual({ ok: false, reason: 'bad-input' });
  });
  it('plus/minus is at least 1 yd for a close, tall stick', () => {
    const m = measure({ flagFt: 7, f35: 26, width: 4032, height: 3024, heightPx: 1400 });
    expect(m.ok && m.plusMinus).toBe(1);
  });
});

describe('helpers', () => {
  it('spanPx is the straight-line length, so a tilted stick still measures its length', () => {
    expect(spanPx({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
  it('distanceYd: 7 ft x 3000 px / 70 px = 300 ft = 100 yd', () => {
    expect(distanceYd(7, 3000, 70)).toBeCloseTo(100, 9);
  });
  it('lens list matches the plan', () => {
    expect(LENSES.map((l) => `${l.label}=${l.mm}`)).toEqual(['0.5x=13', '1x=26', '2x=52', '3x=77', '5x=120']);
  });
  it('clampFlagFt keeps half feet within 4-10', () => {
    expect(clampFlagFt(7.26)).toBe(7.5);
    expect(clampFlagFt(2)).toBe(4);
    expect(clampFlagFt(12)).toBe(10);
    expect(clampFlagFt(NaN)).toBe(7);
  });
});

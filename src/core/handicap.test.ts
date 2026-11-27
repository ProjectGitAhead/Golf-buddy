import { describe, expect, it } from 'vitest';
import {
  adjustedGrossScore, applyCaps, computeHistory, courseHandicap, differentialsToUse, exceptionalScoreAdjustment,
  expectedNineHoleDifferential, holeMaximum, indexFromDifferentials, nineHoleDifferential, nineHoleToEighteen,
  playedTeeValues, roundTenth, roundWhole, scoreDifferential, strokeAllocation, targetScore,
} from './handicap';
import type { Hole, ImportedDifferential, Profile, Round, Tee } from './types';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

// Stroke indexes for holes 1-18: a realistic odd-front / even-back layout.
const SI = [7, 15, 1, 11, 3, 17, 9, 13, 5, 8, 16, 2, 12, 4, 18, 10, 14, 6];
const HOLES: Hole[] = SI.map((si, i) => ({ number: i + 1, par: 4, strokeIndex: si }));

const PROFILE: Profile = { gender: 'M', updatedAt: '2026-01-01T00:00:00Z' };

/** Hole-by-hole scores adding to `gross`, at most 2 over or 1 under par on any hole (never above a hole maximum). */
function spread(holes: Hole[], gross: number): number[] {
  const scores = holes.map((h) => h.par);
  let left = gross - scores.reduce((a, b) => a + b, 0);
  for (let pass = 0; left !== 0; pass++) {
    for (let i = 0; i < scores.length && left !== 0; i++) {
      if (left > 0) { scores[i]++; left--; } else { scores[i]--; left++; }
    }
    if (pass > 2) throw new Error('spread: gross out of range');
  }
  return scores;
}

let seq = 0;
function round(opts: { date: string; gross?: number; scores?: (number | null)[]; rating?: number; slope?: number;
  holes?: Hole[]; holesPlayed?: Round['holesPlayed']; pcc?: number; id?: string; status?: Round['status'] }): Round {
  const holes = opts.holes ?? HOLES;
  const scores = opts.scores ?? spread(holes, opts.gross ?? 90);
  return {
    id: opts.id ?? `r${++seq}`,
    date: opts.date,
    courseId: 'test', teeId: 'white',
    snapshot: { courseName: 'Test', teeName: 'White', rating: opts.rating ?? 72.0, slope: opts.slope ?? 113,
      par: holes.reduce((s, h) => s + h.par, 0), holes },
    holesPlayed: opts.holesPlayed ?? '18',
    pcc: opts.pcc ?? 0,
    scores: holes.map((h, i) => ({ hole: h.number, strokes: scores[i] })),
    status: opts.status ?? 'posted',
    courseHandicap: null,
    updatedAt: `${opts.date}T12:00:00Z`,
  };
}

/** Daily dates from 2026-01-01. */
function day(n: number): string {
  const d = new Date(Date.UTC(2026, 0, 1 + n));
  return d.toISOString().slice(0, 10);
}

/**
 * Rounds with the given differentials on a slope 113, par 72 tee, ids `d<day>`.
 * 'rating' (default): every hole played in par (gross 72, never above any hole maximum) and the rating set to
 * 72 - differential, so the differential is exact whatever the index. 'gross': rating 72.0 and gross 72 + differential
 * spread over the holes (keep differentials small enough to stay under the hole maximums).
 */
function roundsWithDiffs(diffs: number[], startDay = 0, step = 1, mode: 'rating' | 'gross' = 'rating'): Round[] {
  return diffs.map((d, i) => round({ date: day(startDay + i * step), id: `d${startDay + i * step}`,
    ...(mode === 'gross' ? { gross: 72 + d } : { gross: 72, rating: 72 - d }) }));
}

// ---------------------------------------------------------------------------------------------------------------

describe('rounding', () => {
  it('rounds to the tenth with .5 toward +infinity', () => {
    expect(roundTenth(1.25)).toBe(1.3);
    expect(roundTenth(1.15)).toBe(1.2);
    expect(roundTenth(1.24)).toBe(1.2);
    expect(roundTenth(-1.25)).toBe(-1.2);
    expect(roundTenth(-1.35)).toBe(-1.3);
    expect(roundTenth(-1.26)).toBe(-1.3);
    expect(Object.is(roundTenth(-0.04), 0)).toBe(true);
  });
  it('rounds whole numbers the same way', () => {
    expect(roundWhole(2.5)).toBe(3);
    expect(roundWhole(-2.5)).toBe(-2);
    expect(roundWhole(-2.51)).toBe(-3);
    expect(Object.is(roundWhole(-0.4), 0)).toBe(true);
  });
  it('rounds negative index averages toward +infinity', () => {
    // 6 scores: lowest two -1.3 and -1.2 average -1.25, minus 1.0 = -2.25 -> -2.2
    expect(indexFromDifferentials([-1.3, -1.2, 5, 6, 7, 8])!.index).toBe(-2.2);
    // 5 scores: lowest one -0.35 -> -0.3 (an imported value with two decimals)
    expect(indexFromDifferentials([-0.35, 1, 2, 3, 4])!.index).toBe(-0.3);
  });
});

describe('course handicap', () => {
  it('18 holes: HI x slope / 113 + (rating - par)', () => {
    // 12.4 x 128 / 113 = 14.046 ; + (71.3 - 72) = 13.346 -> 13
    expect(courseHandicap(12.4, 71.3, 128, 72)).toBe(13);
    // 20.0 x 140 / 113 = 24.779 ; + 2.5 = 27.279 -> 27
    expect(courseHandicap(20.0, 74.5, 140, 72)).toBe(27);
    // .5 rounds up: 0 + 2.5 -> 3 ; 0 - 2.5 -> -2
    expect(courseHandicap(0, 74.5, 113, 72)).toBe(3);
    expect(courseHandicap(0, 69.5, 113, 72)).toBe(-2);
  });
  it('9 holes: (HI / 2) x slope9 / 113 + (rating9 - par9)', () => {
    // 6.2 x 125 / 113 = 6.858 ; - 0.4 = 6.458 -> 6
    expect(courseHandicap(12.4, 35.6, 125, 36, 9)).toBe(6);
    // 14.3 x 131 / 113 = 16.578 ; + 0.9 = 17.478 -> 17
    expect(courseHandicap(28.6, 36.9, 131, 36, 9)).toBe(17);
  });
  it('plus handicap', () => {
    // -2.3 x 135 / 113 = -2.748 ; + 1.1 = -1.648 -> -2
    expect(courseHandicap(-2.3, 73.1, 135, 72)).toBe(-2);
    // -4.0 x 113 / 113 = -4 ; + 0 -> -4
    expect(courseHandicap(-4.0, 72.0, 113, 72)).toBe(-4);
  });
  it('9-hole tee values, with the rating / 2 and 18-hole slope fallback', () => {
    const tee: Tee = { id: 'w', name: 'White', gender: 'M', rating: 71.3, slope: 128, par: 72,
      frontRating: 35.6, frontSlope: 125, yardages: new Array(18).fill(380) };
    const f9 = playedTeeValues(HOLES, tee, 'F9');
    expect([f9.rating, f9.slope, f9.par, f9.holes.map((h) => h.number)])
      .toEqual([35.6, 125, 36, [1, 2, 3, 4, 5, 6, 7, 8, 9]]);
    const b9 = playedTeeValues(HOLES, tee, 'B9');
    expect([b9.rating, b9.slope, b9.par, b9.holes[0].number]).toEqual([35.7, 128, 36, 10]); // 71.3 / 2 = 35.65 -> 35.7
    const all = playedTeeValues(HOLES, tee, '18');
    expect([all.rating, all.slope, all.par, all.holes.length]).toEqual([71.3, 128, 72, 18]);
  });
});

describe('strokes per hole', () => {
  const bySI = (alloc: number[]) => SI.map((si, i) => [si, alloc[i]]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  it('CH 0: none', () => {
    expect(strokeAllocation(HOLES, 0)).toEqual(new Array(18).fill(0));
  });
  it('CH 9: one on stroke index 1-9', () => {
    expect(bySI(strokeAllocation(HOLES, 9))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('CH 18: one on every hole', () => {
    expect(strokeAllocation(HOLES, 18)).toEqual(new Array(18).fill(1));
  });
  it('CH 27: two on stroke index 1-9, one elsewhere', () => {
    expect(bySI(strokeAllocation(HOLES, 27))).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
  it('CH 40: three on stroke index 1-4, two elsewhere', () => {
    const a = bySI(strokeAllocation(HOLES, 40));
    expect(a).toEqual([3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(a.reduce((s, x) => s + x, 0)).toBe(40);
  });
  it('CH -2: a stroke given back on stroke index 18 and 17', () => {
    const a = strokeAllocation(HOLES, -2);
    expect(bySI(a)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1]);
    expect(a[14]).toBe(-1); // hole 15 is stroke index 18
  });
  it('9-hole round: the nine are re-ranked 1-9 by stroke index', () => {
    const front = HOLES.slice(0, 9); // SI 7,15,1,11,3,17,9,13,5 -> ranks 4,8,1,6,2,9,5,7,3
    expect(strokeAllocation(front, 4)).toEqual([1, 0, 1, 0, 1, 0, 0, 0, 1]);
    expect(strokeAllocation(front, 11)).toEqual([1, 1, 2, 1, 2, 1, 1, 1, 1]);
    expect(strokeAllocation(front, -1)).toEqual([0, 0, 0, 0, 0, -1, 0, 0, 0]);
    const back = HOLES.slice(9); // SI 8,16,2,12,4,18,10,14,6 -> ranks 4,8,1,6,2,9,5,7,3
    expect(strokeAllocation(back, 3)).toEqual([0, 0, 1, 0, 1, 0, 0, 0, 1]);
  });
  it("uses the women's stroke index when given", () => {
    const holes: Hole[] = [{ number: 1, par: 4, strokeIndex: 1, strokeIndexW: 2 },
      { number: 2, par: 4, strokeIndex: 2, strokeIndexW: 1 }];
    expect(strokeAllocation(holes, 1, 'M')).toEqual([1, 0]);
    expect(strokeAllocation(holes, 1, 'W')).toEqual([0, 1]);
  });
});

describe('adjusted gross score', () => {
  it('net double bogey: par + 2 + strokes received', () => {
    expect(holeMaximum(4, 1, true)).toBe(7);
    expect(holeMaximum(3, 0, true)).toBe(5);
    expect(holeMaximum(5, 2, true)).toBe(9);
    expect(holeMaximum(4, -1, true)).toBe(5);
    const scores = spread(HOLES, 90);
    scores[2] = 11;  // hole 3, SI 1: CH 10 gives 1 stroke -> max 7
    scores[14] = 9;  // hole 15, SI 18: no stroke -> max 6
    const r = round({ date: day(0), scores });
    const a = adjustedGrossScore(r, 10);
    const gross = scores.reduce((s, x) => s + x, 0);
    expect(a.holeMax[2]).toBe(7);
    expect(a.holeMax[14]).toBe(6);
    expect(a.ags).toBe(gross - 4 - 3);
    expect(a.incomplete).toBe(false);
  });
  it('no index yet: par + 5', () => {
    expect(holeMaximum(4, 3, false)).toBe(9);
    const scores = new Array(18).fill(4);
    scores[0] = 12;
    const a = adjustedGrossScore(round({ date: day(0), scores }), null);
    expect(a.holeMax.every((m) => m === 9)).toBe(true);
    expect(a.ags).toBe(72 + 5);
  });
  it('10-17 holes played: the rest count net par and the round is incomplete', () => {
    const scores: (number | null)[] = new Array(18).fill(5);
    scores[2] = null;  // hole 3, SI 1: CH 18 -> net par 5
    scores[14] = null; // hole 15, SI 18: net par 5
    scores[0] = null;  // hole 1
    const a = adjustedGrossScore(round({ date: day(0), scores }), 18);
    expect(a.postable).toBe(true);
    expect(a.incomplete).toBe(true);
    expect(a.holesCompleted).toBe(15);
    expect(a.ags).toBe(15 * 5 + 3 * 5);
    // CH 9: SI 1 (hole 3) and SI 7 (hole 1) get a stroke, SI 18 (hole 15) does not
    expect(adjustedGrossScore(round({ date: day(0), scores }), 9).ags).toBe(15 * 5 + 5 + 5 + 4);
  });
  it('an 18-hole round with fewer than 10 holes cannot be posted', () => {
    const scores: (number | null)[] = new Array(18).fill(null).map((_, i) => (i < 9 ? 5 : null));
    const a = adjustedGrossScore(round({ date: day(0), scores }), 10);
    expect(a.postable).toBe(false);
    expect(a.ags).toBeNull();
    const h = computeHistory([round({ date: day(0), scores, id: 'short' })], [], PROFILE);
    expect(h.entries).toHaveLength(0);
    expect(h.notPosted.map((n) => n.roundId)).toEqual(['short']);
  });
});

describe('score differentials', () => {
  it('18 holes: (113 / slope) x (AGS - rating - PCC)', () => {
    expect(scoreDifferential(85, 71.3, 128)).toBe(12.1);   // 0.8828 x 13.7 = 12.094
    expect(scoreDifferential(85, 71.3, 128, 1)).toBe(11.2); // 0.8828 x 12.7 = 11.212
    expect(scoreDifferential(70, 72.4, 131, -1)).toBe(-1.2); // 0.8626 x -1.4 = -1.208
    expect(scoreDifferential(70.5, 71.75, 113)).toBe(-1.2); // -1.25 rounds toward +infinity
  });
  it('9 holes: diff9 + expected 9-hole differential', () => {
    expect(nineHoleDifferential(44, 35.6, 125, 1)).toBe(7.1); // 0.904 x (44 - 35.6 - 0.5) = 7.142
    expect(expectedNineHoleDifferential(12.4)).toBe(7.6);     // 0.52 x 12.4 + 1.2 = 7.648
    expect(expectedNineHoleDifferential(0)).toBe(1.2);
    expect(nineHoleToEighteen(7.1, 12.4)).toBe(14.7);
  });
  it('a 9-hole round in the history uses the index in effect for the expected score', () => {
    const front = HOLES.slice(0, 9);
    const r = round({ date: day(0), holes: front, holesPlayed: 'F9', rating: 35.6, slope: 125, pcc: 1,
      gross: 44, id: 'n1' });
    const h = computeHistory([r], [], { ...PROFILE, startingIndex: 12.4 });
    const e = h.entries[0];
    expect(e.kind).toBe('nine');
    expect(e.courseHandicap).toBe(6);
    expect(e.ags).toBe(44);
    expect(e.nineHoleDifferential).toBe(7.1);
    expect(e.expectedNineHole).toBe(7.6);
    expect(e.differential).toBe(14.7);
  });
  it('with no index, a 9-hole round waits and combines with the next one', () => {
    const front = HOLES.slice(0, 9);
    const back = HOLES.slice(9);
    const a = round({ date: day(0), holes: front, holesPlayed: 'F9', rating: 35.6, slope: 125, gross: 45, id: 'a' });
    const b = round({ date: day(3), holes: back, holesPlayed: 'B9', rating: 35.0, slope: 120, gross: 47, id: 'b' });
    const one = computeHistory([a], [], PROFILE);
    expect(one.entries).toHaveLength(0);
    expect(one.waitingNine).toBe('a');
    const two = computeHistory([a, b], [], PROFILE);
    expect(two.waitingNine).toBeNull();
    expect(two.entries).toHaveLength(1);
    const e = two.entries[0];
    expect(e.kind).toBe('combined-nine');
    expect(e.roundIds).toEqual(['a', 'b']);
    expect(e.date).toBe(day(3));
    // 0.904 x 9.4 = 8.498 -> 8.5 ; 0.9417 x 12 = 11.3 ; sum 19.8
    expect(e.differential).toBe(19.8);
  });
});

describe('index table', () => {
  // n scores with differentials 10, 11, ..., 10 + n - 1 (shuffled): lowest k average to 10 + (k - 1) / 2.
  const expected: Record<number, [number, number, number]> = {
    // n: [use, adjustment, index]
    3: [1, -2, 8.0], 4: [1, -1, 9.0], 5: [1, 0, 10.0], 6: [2, -1, 9.5], 7: [2, 0, 10.5], 8: [2, 0, 10.5],
    9: [3, 0, 11.0], 10: [3, 0, 11.0], 11: [3, 0, 11.0], 12: [4, 0, 11.5], 13: [4, 0, 11.5], 14: [4, 0, 11.5],
    15: [5, 0, 12.0], 16: [5, 0, 12.0], 17: [6, 0, 12.5], 18: [6, 0, 12.5], 19: [7, 0, 13.0], 20: [8, 0, 13.5],
  };
  for (const [n, [use, adj, idx]] of Object.entries(expected).map(([k, v]) => [Number(k), v] as const)) {
    it(`${n} scores: lowest ${use}, adjustment ${adj}`, () => {
      expect(differentialsToUse(n)).toEqual({ use, adjustment: adj });
      const diffs = Array.from({ length: n }, (_, i) => 10 + ((n - 1 - i + 2) % n)); // a permutation of 10..10+n-1
      const r = indexFromDifferentials(diffs)!;
      expect(r.index).toBe(idx);
      expect(r.used).toHaveLength(use);
      expect(r.used.map((i) => diffs[i]).sort((a, b) => a - b))
        .toEqual(Array.from({ length: use }, (_, i) => 10 + i));
    });
  }
  it('fewer than 3 scores: no index; the starting index is shown instead', () => {
    expect(differentialsToUse(2)).toBeNull();
    expect(indexFromDifferentials([10, 12])).toBeNull();
    const h = computeHistory(roundsWithDiffs([10, 12]), [], { ...PROFILE, startingIndex: 9.8 });
    expect(h.currentIndex).toBeNull();
    expect(h.indexSource).toBe('starting');
    expect(h.displayIndex).toBe(9.8);
    const none = computeHistory(roundsWithDiffs([10, 12]), [], PROFILE);
    expect(none.indexSource).toBe('none');
    expect(none.displayIndex).toBeNull();
  });
  it('only the most recent 20 are read', () => {
    expect(indexFromDifferentials([0, 0, 0, ...new Array(20).fill(20)])!.index).toBe(20);
  });
  it('maximum 54.0', () => {
    expect(indexFromDifferentials([57, 58, 59])!.index).toBe(54); // 57 - 2 = 55
    expect(indexFromDifferentials(new Array(20).fill(60))!.index).toBe(54);
    const h = computeHistory(roundsWithDiffs([60, 60, 60, 60, 60]), [], PROFILE);
    expect(h.currentIndex).toBe(54);
  });
});

describe('exceptional scores', () => {
  it('7.0-9.9 below: -1 ; 10.0 or more: -2', () => {
    expect(exceptionalScoreAdjustment(8.1, 15.0)).toBe(0);  // 6.9 below
    expect(exceptionalScoreAdjustment(8.0, 15.0)).toBe(-1); // 7.0
    expect(exceptionalScoreAdjustment(5.1, 15.0)).toBe(-1); // 9.9
    expect(exceptionalScoreAdjustment(5.0, 15.0)).toBe(-2); // 10.0
    expect(exceptionalScoreAdjustment(-3.0, 15.0)).toBe(-2);
    expect(exceptionalScoreAdjustment(0, null)).toBe(0);
  });
  it('-1 and -2 land on every recent score and accumulate', () => {
    const h = computeHistory(roundsWithDiffs([20, 20, 20, 20, 20, 12, 4]), [], PROFILE);
    const e = h.entries;
    expect(e[4].indexAfter).toBe(20);
    // round 6: 20.0 - 12.0 = 8.0 below -> -1 on all six; lowest two (11 + 19) / 2 - 1.0 = 14.0
    expect(e[5].esrAdjustment).toBe(-1);
    expect(e[5].indexAfter).toBe(14);
    // round 7: 14.0 - 4.0 = 10.0 below -> -2 on all seven; lowest two (2 + 9) / 2 = 5.5
    expect(e[6].esrAdjustment).toBe(-2);
    expect(e.map((x) => x.totalAdjustment)).toEqual([-3, -3, -3, -3, -3, -3, -2]);
    expect(e.map((x) => x.adjustedDifferential)).toEqual([17, 17, 17, 17, 17, 9, 2]);
    expect(h.currentIndex).toBe(5.5);
  });
  it('only the most recent 20 (including the exceptional one) receive it, and adjustments stay', () => {
    const h = computeHistory(roundsWithDiffs([...new Array(20).fill(20), 12]), [], PROFILE);
    expect(h.entries[19].indexAfter).toBe(20);
    expect(h.entries[20].esrAdjustment).toBe(-1);
    expect(h.entries[0].totalAdjustment).toBe(0);
    expect(h.entries.slice(1).every((x) => x.totalAdjustment === -1)).toBe(true);
    // window = rounds 2-21: 19 x 19.0 and 11.0 -> (11 + 7 x 19) / 8 = 18.0
    expect(h.currentIndex).toBe(18);
  });
});

describe('caps', () => {
  it('soft cap halves the rise beyond 3.0; hard cap stops at 5.0', () => {
    expect(applyCaps(13.0, 10.0)).toEqual({ index: 13.0, cap: null });
    expect(applyCaps(14.0, 10.0)).toEqual({ index: 13.5, cap: 'soft' });
    expect(applyCaps(14.3, 10.0)).toEqual({ index: 13.7, cap: 'soft' }); // 13 + 0.65 = 13.65 -> 13.7
    expect(applyCaps(17.0, 10.0)).toEqual({ index: 15.0, cap: 'soft' }); // 13 + 2.0 = 15.0
    expect(applyCaps(18.0, 10.0)).toEqual({ index: 15.0, cap: 'hard' }); // soft 15.5 > 15.0
    expect(applyCaps(30.0, 10.0)).toEqual({ index: 15.0, cap: 'hard' });
    expect(applyCaps(5.0, 10.0)).toEqual({ index: 5.0, cap: null });
    expect(applyCaps(25.0, null)).toEqual({ index: 25.0, cap: null });
  });
  it('apply in the history once 20 scores exist, against the Low Index of the past 365 days', () => {
    const diffs = [...new Array(20).fill(10), ...new Array(15).fill(30)];
    const h = computeHistory(roundsWithDiffs(diffs), [], PROFILE);
    const e = h.entries;
    // indexes: 8.0 after 3 scores (the -2.0 row), 9.0 after 4 and 6, 10.0 otherwise
    expect(e[2].indexAfter).toBe(8);
    expect(e[19].indexAfter).toBe(10);
    expect(e[19].lowIndex).toBe(8);
    // after 32 scores: 8 x 10 -> 10.0, rise 2.0 over the Low Index 8.0, no cap
    expect(e[31].indexAfter).toBe(10);
    expect(e[31].cap).toBeNull();
    // after 33: (7 x 10 + 30) / 8 = 12.5, rise 4.5 -> soft 8 + 3 + 0.75 = 11.75 -> 11.8
    expect(e[32].lowIndex).toBe(8);
    expect(e[32].indexAfter).toBe(11.8);
    expect(e[32].cap).toBe('soft');
    // after 34: 15.0, rise 7.0 -> soft 8 + 3 + 2.0 = 13.0 = the hard limit
    expect(e[33].indexAfter).toBe(13);
    expect(e[33].cap).toBe('soft');
    // after 35: 17.5, rise 9.5 -> soft 14.25 -> 14.3 is past 8 + 5 -> hard 13.0
    expect(e[34].indexAfter).toBe(13);
    expect(e[34].cap).toBe('hard');
    expect(h.currentIndex).toBe(13);
    expect(h.capApplied).toBe('hard');
    expect(h.lowIndex).toBe(8);
  });
  it('the Low Index only looks at the 365 days before the latest score', () => {
    // 20 scores of 10 on days 0-19: index 8.0 after day 2, 9.0 after days 3 and 5, 10.0 on the other days
    const old = roundsWithDiffs(new Array(20).fill(10), 0, 1);
    const low = (dayN: number) => computeHistory([...old, ...roundsWithDiffs([10], dayN)], [], PROFILE)
      .entries[20].lowIndex;
    expect(low(367)).toBe(8);    // day 2 is 365 days before
    expect(low(368)).toBe(9);    // day 2 is 366 days before, day 3 is 365
    expect(low(370)).toBe(9);    // day 5 is 365 days before
    expect(low(371)).toBe(10);
    expect(low(400)).toBeNull(); // nothing in the past 365 days: no Low Index, no cap
  });
  it('no cap before 20 scores', () => {
    const h = computeHistory(roundsWithDiffs([0, 0, 0, 30, 30, 30, 30, 30, 30, 30]), [], PROFILE);
    expect(h.entries[2].indexAfter).toBe(-2);
    // 10 scores: lowest 3 = 0, 0, 0 -> 0.0 ; index never rose, so check a rising case below
    expect(h.capApplied).toBeNull();
    const rising = computeHistory(roundsWithDiffs([0, 0, 0, 30, 30, 30, 30]), [], PROFILE);
    // 7 scores: lowest 2 = 0, 0 -> 0.0 (the -2.0 after 3 scores is no Low Index yet)
    expect(rising.currentIndex).toBe(0);
    const sixteen = computeHistory(roundsWithDiffs([0, 0, 0, ...new Array(16).fill(30)]), [], PROFILE);
    // 19 scores: lowest 7 = 0,0,0,30,30,30,30 -> 120 / 7 = 17.14 -> 17.1, uncapped although it was -2.0
    expect(sixteen.currentIndex).toBe(17.1);
    expect(sixteen.capApplied).toBeNull();
  });
});

describe('imported differentials', () => {
  it('take part in the calculation by date and can be counting scores', () => {
    const imported: ImportedDifferential[] = [
      { id: 'i1', date: '2025-12-01', differential: 11.4 },
      { id: 'i2', date: '2025-12-08', differential: 9.8, note: 'From association record' },
      { id: 'i3', date: '2025-12-15', differential: 13.0 },
    ];
    const only = computeHistory([], imported, PROFILE);
    expect(only.currentIndex).toBe(7.8); // 9.8 - 2.0
    expect(only.countingIds).toEqual(['i2']);
    const rounds = roundsWithDiffs([12, 9]); // 2026-01-01: 12, 2026-01-02: 9
    const mixed = computeHistory(rounds, imported, PROFILE);
    expect(mixed.entries.map((e) => e.id)).toEqual(['i1', 'i2', 'i3', 'd0', 'd1']);
    expect(mixed.entries[3].indexInEffect).toBe(7.8);
    // 5 scores: lowest 1 = 9.0
    expect(mixed.currentIndex).toBe(9);
    expect(mixed.countingIds).toEqual(['d1']);
  });
  it('are not themselves checked as exceptional, but receive later adjustments', () => {
    const imported: ImportedDifferential[] = [20, 20, 20, 20, 0].map((d, i) => ({ id: `i${i}`, date: day(i),
      differential: d }));
    const h = computeHistory(roundsWithDiffs([10], 10), imported, PROFILE);
    expect(h.entries[4].esrAdjustment).toBe(0);
    // index after the imports: 0 (lowest 1 of 5). Round on day 10 with differential 10: not exceptional.
    expect(h.entries[5].esrAdjustment).toBe(0);
    const h2 = computeHistory(roundsWithDiffs([2], 10), imported.slice(0, 4), PROFILE);
    // index after 4 imports: 20 - 1 = 19.0 ; round 2.0 is 17.0 below -> -2 on all five
    expect(h2.entries[4].esrAdjustment).toBe(-2);
    expect(h2.entries[0].totalAdjustment).toBe(-2);
  });
});

describe('computeHistory end to end', () => {
  // 22 rounds a week apart on a rating 72.0 / slope 113 tee, so each differential is gross - 72.
  const diffs = [18, 16, 20, 15, 17, 19, 14, 16, 18, 21, 15, 13, 17, 19, 16, 14, 18, 20, 15, 17, 12, 22];
  const rounds = roundsWithDiffs(diffs, 0, 7, 'gross');
  const active = round({ date: day(200), gross: 60, status: 'active', id: 'active' });
  const h = computeHistory([...rounds].reverse().concat(active), [], PROFILE);

  it('replays every posted round in date order and ignores active rounds', () => {
    expect(h.entries).toHaveLength(22);
    expect(h.entries.map((e) => e.differential)).toEqual(diffs);
    expect(h.entries.every((e) => e.ags === 72 + e.differential && e.esrAdjustment === 0)).toBe(true);
  });
  it('gives the index after each score', () => {
    // hand-worked: see the plan's table; e.g. after 12: (13 + 14 + 15 + 15) / 4 = 14.25 -> 14.3
    expect(h.entries.map((e) => e.indexAfter)).toEqual([
      null, null, 14.0, 14.0, 15.0, 14.5, 14.5, 14.5, 15.0, 15.0, 14.7,
      14.3, 14.3, 14.3, 14.6, 14.2, 14.5, 14.5, 14.6, 14.8, 14.3, 14.3,
    ]);
    expect(h.currentIndex).toBe(14.3);
    expect(h.indexSource).toBe('calculated');
    expect(h.trend).toHaveLength(20);
    expect(h.trend[0]).toEqual({ date: day(14), index: 14 });
  });
  it('uses the replayed index for course handicap and hole maximums', () => {
    expect(h.entries[0].courseHandicap).toBeNull();
    expect(h.entries[3].indexInEffect).toBe(14.0);
    expect(h.entries[3].courseHandicap).toBe(14);
  });
  it('marks the 8 counting scores of the last 20 (ties: the more recent)', () => {
    // last 20 = rounds 3-22; lowest 8 = 12, 13, 14, 14, 15, 15, 15, 16
    const ids = [4, 7, 11, 12, 15, 16, 19, 21].map((n) => `d${(n - 1) * 7}`);
    expect(h.countingIds).toEqual(ids);
    expect(h.entries.filter((e) => e.counting)).toHaveLength(8);
  });
  it('tracks the Low Index without capping a small rise', () => {
    expect(h.lowIndex).toBe(14.0);
    expect(h.capApplied).toBeNull();
  });
});

describe('targetScore', () => {
  it('the gross that lowers the index and the gross that counts', () => {
    const rounds = roundsWithDiffs(new Array(20).fill(10));
    const t = targetScore({ rounds, imported: [], profile: PROFILE, rating: 72.0, slope: 113, par: 72,
      holesPlayed: '18', date: day(30) });
    // index 10.0. A differential of 9 -> (7 x 10 + 9) / 8 = 9.875 -> 9.9 ; of 10 -> 10.0 (counts, ties: the newer)
    expect(t.courseHandicap).toBe(10);
    expect(t.lowerIndex).toBe(81);
    expect(t.countingScore).toBe(82);
  });
  it('on a harder tee with PCC', () => {
    const rounds = roundsWithDiffs(new Array(20).fill(10));
    const t = targetScore({ rounds, imported: [], profile: PROFILE, rating: 74.1, slope: 135, par: 72,
      holesPlayed: '18', date: day(30), pcc: 1 });
    // counts at differential <= 10.0: 113 / 135 x (G - 75.1) <= 10.04 -> G <= 87.09 -> 87 (10.0)
    // lowers at differential <= 9.6: G <= 86.56 -> 86 (9.1)
    expect(t.countingScore).toBe(87);
    expect(t.lowerIndex).toBe(86);
  });
  it('no calculated index: nothing to lower, but a score can still count', () => {
    const t = targetScore({ rounds: roundsWithDiffs([10]), imported: [], profile: PROFILE, rating: 72.0,
      slope: 113, par: 72, holesPlayed: '18', date: day(30) });
    expect(t.lowerIndex).toBeNull();
    expect(t.courseHandicap).toBeNull();
    // 2 scores after it: no index yet, so nothing counts
    expect(t.countingScore).toBeNull();
    const t3 = targetScore({ rounds: roundsWithDiffs([10, 12]), imported: [], profile: PROFILE, rating: 72.0,
      slope: 113, par: 72, holesPlayed: '18', date: day(30) });
    expect(t3.countingScore).toBe(82); // the lowest of 3 counts: differential 10 ties with the older 10
  });
  it('9 holes with an index uses the expected-score approximation', () => {
    const rounds = roundsWithDiffs(new Array(20).fill(10));
    const t = targetScore({ rounds, imported: [], profile: PROFILE, rating: 36.0, slope: 113, par: 36,
      holesPlayed: 'F9', date: day(30) });
    // expected 9 at 10.0 = 6.4 ; counts when diff9 + 6.4 <= 10.0 -> diff9 <= 3.6 -> G <= 39
    expect(t.countingScore).toBe(39);
    // lowers when the 18-hole differential <= 9.6 -> diff9 <= 3.2 -> G <= 39 (3.0 -> 9.4)
    expect(t.lowerIndex).toBe(39);
    expect(t.courseHandicap).toBe(5);
  });
});

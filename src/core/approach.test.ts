import { describe, expect, it } from 'vitest';
import {
  MAX_FT, SUMMARY_MIN, clampMark, collectMarks, currentCourseId, densityGrid, describeMark, direction, offsetWords,
  summarize,
} from './approach';
import type { ApproachMark, HoleScore, Round } from './types';

const mk = (xFt: number, yFt: number, onGreen = true): ApproachMark => ({ xFt, yFt, onGreen, source: 'manual' });

function round(id: string, date: string, courseId: string, scores: Partial<HoleScore>[], status: Round['status'] = 'posted'): Round {
  return {
    id, date, courseId, teeId: 't', status, pcc: 0, courseHandicap: null, holesPlayed: '18', updatedAt: `${date}T12:00:00.000Z`,
    snapshot: { courseName: courseId, teeName: 'White', rating: 70, slope: 120, par: 72,
      holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: i % 6 === 2 ? 3 : 4, strokeIndex: i + 1 })) },
    scores: scores.map((s, i) => ({ hole: i + 1, strokes: 4, ...s })),
  };
}

describe('clampMark', () => {
  it('rounds to 0.1 ft and leaves near marks alone', () => {
    expect(clampMark(mk(3.14159, -12.06))).toMatchObject({ xFt: 3.1, yFt: -12.1 });
  });
  it(`pulls a far mark in to ${MAX_FT} ft along the same line`, () => {
    const c = clampMark(mk(300, -400));
    expect(Math.hypot(c.xFt, c.yFt)).toBeCloseTo(150, 0);
    expect(c.xFt).toBeCloseTo(90, 1);
    expect(c.yFt).toBeCloseTo(-120, 1);
  });
  it('never returns -0', () => {
    expect(Object.is(clampMark(mk(-0.01, 0.02)).xFt, 0)).toBe(true);
  });
});

describe('describeMark', () => {
  it('names the eight directions from where the shot was hit', () => {
    expect(direction({ xFt: 0, yFt: -10 })).toBe('short');
    expect(direction({ xFt: 0, yFt: 10 })).toBe('long');
    expect(direction({ xFt: -10, yFt: 0 })).toBe('left');
    expect(direction({ xFt: 10, yFt: 0 })).toBe('right');
    expect(direction({ xFt: -8, yFt: -7 })).toBe('short left');
    expect(direction({ xFt: 8, yFt: -7 })).toBe('short right');
    expect(direction({ xFt: -8, yFt: 7 })).toBe('long left');
    expect(direction({ xFt: 8, yFt: 7 })).toBe('long right');
    expect(direction({ xFt: -2, yFt: -10 })).toBe('short');
  });
  it('reads as distance then direction', () => {
    expect(describeMark(mk(-9, -10.5))).toBe('14 ft, short left');
    expect(describeMark(mk(0.3, 0.4))).toBe('Inside a foot');
    expect(describeMark(mk(0, 38, false))).toBe('38 ft, long, off the green');
  });
});

describe('collectMarks', () => {
  const rounds = [
    round('a', '2026-10-01', 'rancho', [{ approach: mk(1, 2) }, {}, { approach: mk(-3, -4) }]),
    round('b', '2026-10-08', 'other', [{ approach: mk(5, 5) }]),
    round('c', '2026-11-20', 'rancho', [{ approach: mk(0, -20) }, { approach: { xFt: NaN, yFt: 1 } as ApproachMark }], 'active'),
    ...['d', 'e', 'f', 'g'].map((id, i) => round(id, `2026-11-0${i + 1}`, 'other', [{ approach: mk(i, i) }])),
  ];
  it('takes posted and active rounds and skips broken marks', () => {
    const all = collectMarks(rounds);
    expect(all).toHaveLength(8);
    expect(all[0].roundId).toBe('c');            // newest first
    expect(all.some((e) => e.roundId === 'a' && e.hole === 3 && e.par === 3)).toBe(true);
  });
  it('filters par 3s, one course and the last 5 rounds', () => {
    expect(collectMarks(rounds, 'par3').map((e) => e.hole)).toEqual([3]);
    expect(collectMarks(rounds, 'course', 'rancho').map((e) => e.roundId).sort()).toEqual(['a', 'a', 'c']);
    expect(new Set(collectMarks(rounds, 'last5').map((e) => e.roundId))).toEqual(new Set(['c', 'g', 'f', 'e', 'd']));
  });
  it('"this course" is the round in progress, else the latest round', () => {
    expect(currentCourseId(rounds)).toBe('rancho');
    expect(currentCourseId(rounds.filter((r) => r.status === 'posted'))).toBe('other');
    expect(currentCourseId([])).toBeUndefined();
  });
});

describe('densityGrid', () => {
  it('is all zero with no marks', () => {
    const g = densityGrid([], 20);
    expect(g.values.every((v) => v === 0)).toBe(true);
  });
  it('peaks at 1 in the cell under a single mark, row 0 being the long edge', () => {
    const g = densityGrid([{ xFt: 0, yFt: 40 }], 18, 45, 5);
    let best = 0;
    g.values.forEach((v, i) => { if (v > g.values[best]) best = i; });
    expect(g.values[best]).toBe(1);
    expect(Math.floor(best / 18)).toBe(0);                  // top row
    expect(best % 18 === 8 || best % 18 === 9).toBe(true);  // centre column
  });
  it('is heavier where marks cluster', () => {
    const g = densityGrid([mk(-20, -20), mk(-21, -19), mk(-19, -21), mk(20, 20)], 30, 45, 5);
    const at = (x: number, y: number) => g.values[Math.floor((45 - y) / 3) * 30 + Math.floor((x + 45) / 3)];
    expect(at(-20, -20)).toBeGreaterThan(at(20, 20) * 2);
    expect(at(40, -40)).toBeLessThan(0.01);
  });
  it('keeps the automatic bandwidth between 4 and 10 ft', () => {
    expect(densityGrid([mk(0, 0), mk(0.1, 0.1), mk(0.2, 0)]).bandwidthFt).toBe(4);
    expect(densityGrid([mk(-100, -100), mk(100, 100)]).bandwidthFt).toBe(10);
  });
});

describe('summarize', () => {
  it(`gives no lines below ${SUMMARY_MIN} marks`, () => {
    const s = summarize([mk(1, 1), mk(2, 2), mk(3, 3), mk(4, 4)]);
    expect(s.count).toBe(4);
    expect(s.lines).toEqual([]);
  });
  it('computes the numbers and the lean in words', () => {
    const marks = [mk(-6, -12), mk(-3, -20, false), mk(2, -8), mk(-10, -4), mk(4, 6), mk(-5, -15, false), mk(-1, -30, false)];
    const s = summarize(marks);
    const d = marks.reduce((a, m) => a + Math.hypot(m.xFt, m.yFt), 0) / 7;
    expect(s.avgDistFt).toBeCloseTo(d, 6);
    expect(s.onGreenShare).toBeCloseTo(4 / 7, 6);
    expect(s.shortShare).toBeCloseTo(6 / 7, 6);
    expect(s.leftShare).toBeCloseTo(5 / 7, 6);
    expect(s.lines[0]).toBe('86% finish short of the pin, 71% left of it.');
    expect(s.lines[1]).toBe('The middle of your pattern is 12 ft short, 3 ft left of the pin.');
    expect(s.lines[2]).toBe('Off the green, 3 of 3 misses finished short.');
  });
  it('says when there is no strong lean', () => {
    const s = summarize([mk(-5, -5), mk(5, 5), mk(-5, 5), mk(5, -5), mk(0, 0.5)]);
    expect(s.lines[0]).toBe('No strong lean: 40% short, 40% long, 40% left, 40% right.');
    expect(s.lines[1]).toBe('The middle of your pattern is on the pin.');
    expect(s.lines).toHaveLength(2);
  });
  it('words offsets', () => {
    expect(offsetWords({ xFt: 2.6, yFt: 7.4 })).toBe('7 ft long, 3 ft right');
    expect(offsetWords({ xFt: 0.4, yFt: -0.2 })).toBe('on the pin');
  });
});

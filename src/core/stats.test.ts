import { describe, expect, it } from 'vitest';
import { greenInRegulation, percent, roundStats, summarizeStats } from './stats';
import type { Hole, HoleScore, Round } from './types';

// Pars for 18 holes: four par 3s, ten par 4s, four par 5s (par 72).
const PARS = [4, 5, 3, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4];
const holes18: Hole[] = PARS.map((par, i) => ({ number: i + 1, par, strokeIndex: i + 1 }));

function round(id: string, scores: Partial<HoleScore>[], holes: Hole[] = holes18): Round {
  return {
    id, date: '2026-11-01', courseId: 'c', teeId: 't',
    snapshot: { courseName: 'C', teeName: 'T', rating: 70, slope: 120, par: holes.reduce((a, h) => a + h.par, 0), holes },
    holesPlayed: holes.length === 18 ? '18' : 'F9', pcc: 0,
    scores: holes.map((h, i) => ({ hole: h.number, strokes: null, ...scores[i] })),
    status: 'posted', courseHandicap: null, updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

describe('greenInRegulation', () => {
  it('is strokes minus putts at most par minus two', () => {
    expect(greenInRegulation(3, 2, 3)).toBe(true);   // par 3: on in 1
    expect(greenInRegulation(4, 2, 3)).toBe(false);  // par 3: on in 2
    expect(greenInRegulation(4, 2, 4)).toBe(true);   // par 4: on in 2
    expect(greenInRegulation(5, 3, 4)).toBe(true);   // par 4: on in 2, three-putt
    expect(greenInRegulation(5, 2, 4)).toBe(false);  // par 4: on in 3
    expect(greenInRegulation(5, 2, 5)).toBe(true);   // par 5: on in 3
    expect(greenInRegulation(4, 0, 4)).toBe(false);  // par 4: holed out from off the green in 4
    expect(greenInRegulation(2, 0, 4)).toBe(true);   // eagle from the fairway
  });
});

describe('roundStats', () => {
  it('counts fairways on par 4s and 5s only, and only where recorded', () => {
    const scores = PARS.map((par, i): Partial<HoleScore> => ({
      strokes: par,
      // every hole gets a result, including par 3s, which must be ignored
      fairway: i % 3 === 0 ? 'hit' : i % 3 === 1 ? 'left' : 'right',
    }));
    scores[0] = { strokes: 4 };                     // par 4 with no tee-shot result: not counted
    const s = roundStats(round('a', scores));
    const fwHoles = PARS.map((p, i) => ({ p, i })).filter(({ p, i }) => p >= 4 && i !== 0);
    expect(s.fairways.of).toBe(fwHoles.length);
    expect(s.fairways.hit).toBe(fwHoles.filter(({ i }) => i % 3 === 0).length);
    expect(s.fairwayMisses.left).toBe(fwHoles.filter(({ i }) => i % 3 === 1).length);
    expect(s.fairwayMisses.right).toBe(fwHoles.filter(({ i }) => i % 3 === 2).length);
  });

  it('computes GIR and putts only on holes with putts', () => {
    // hole 1 par 4: 4 strokes 2 putts (GIR) · hole 2 par 5: 6 strokes 2 putts (no) · hole 3 par 3: 3 strokes 2 putts (GIR)
    // hole 4: strokes but no putts (left out) · rest blank
    const s = roundStats(round('a', [{ strokes: 4, putts: 2 }, { strokes: 6, putts: 2 }, { strokes: 3, putts: 2 }, { strokes: 5 }]));
    expect(s.gir).toEqual({ hit: 2, of: 3 });
    expect(s.putts).toBe(6);
    expect(s.puttHoles).toBe(3);
    expect(s.holesScored).toBe(4);
    expect(s.gross).toBe(18);
  });

  it('averages scoring by par', () => {
    const scores = PARS.map((par): Partial<HoleScore> => ({ strokes: par === 3 ? 4 : par === 4 ? 5 : 5 }));
    const s = roundStats(round('a', scores));
    expect(s.byPar[3]).toMatchObject({ holes: 4, strokes: 16, average: 4, toPar: 1 });
    expect(s.byPar[4]).toMatchObject({ holes: 10, strokes: 50, average: 5, toPar: 1 });
    expect(s.byPar[5]).toMatchObject({ holes: 4, strokes: 20, average: 5, toPar: 0 });
  });

  it('leaves blank holes and pars with no score out', () => {
    const s = roundStats(round('a', []));
    expect(s.holesScored).toBe(0);
    expect(s.byPar[3].average).toBeNull();
    expect(s.byPar[3].toPar).toBeNull();
    expect(s.gir.of).toBe(0);
  });
});

describe('summarizeStats', () => {
  it('pools holes across rounds, so 9- and 18-hole rounds weigh by holes', () => {
    const a = round('a', PARS.map((par) => ({ strokes: par + 1, putts: 2, fairway: 'hit' as const })));
    const nine = holes18.slice(0, 9);
    const b = round('b', nine.map((h) => ({ strokes: h.par, putts: 2, fairway: 'right' as const })), nine);
    const s = summarizeStats([a, b]);
    expect(s.rounds).toBe(2);
    const fwA = PARS.filter((p) => p >= 4).length;
    const fwB = nine.filter((h) => h.par >= 4).length;
    expect(s.fairways).toEqual({ hit: fwA, of: fwA + fwB });
    expect(s.fairwayMisses.right).toBe(fwB);
    // a: bogey with 2 putts is on in par - 1: no GIR. b: par with 2 putts is on in par - 2: GIR.
    expect(s.gir).toEqual({ hit: 9, of: 27 });
    expect(s.puttHoles).toBe(27);
    expect(s.puttsPerHole).toBeCloseTo((36 + 18) / 27, 10);
    expect(s.puttsPer18).toBeCloseTo(((36 + 18) / 27) * 18, 10);
    const par3a = PARS.filter((p) => p === 3).length;
    const par3b = nine.filter((h) => h.par === 3).length;
    expect(s.byPar[3].holes).toBe(par3a + par3b);
    expect(s.byPar[3].average).toBeCloseTo((par3a * 4 + par3b * 3) / (par3a + par3b), 10);
  });

  it('returns nulls with no rounds', () => {
    const s = summarizeStats([]);
    expect(s.rounds).toBe(0);
    expect(s.puttsPer18).toBeNull();
    expect(percent(s.fairways)).toBeNull();
    expect(percent(s.gir)).toBeNull();
  });

  it('rounds percentages to whole numbers', () => {
    expect(percent({ hit: 1, of: 3 })).toBe(33);
    expect(percent({ hit: 2, of: 3 })).toBe(67);
    expect(percent({ hit: 0, of: 5 })).toBe(0);
  });
});

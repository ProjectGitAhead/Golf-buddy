// Round stats for the Shots tab: fairways, greens in regulation, putts, scoring by par. Pure functions.
//
// Only what was recorded is counted: a hole with no fairway result is left out of the fairway count, a hole with no
// putts is left out of greens in regulation and putts. Holes come from the round's frozen snapshot.
import type { FairwayResult, Round } from './types';

export interface Ratio { hit: number; of: number }

export interface ParScoring { holes: number; strokes: number; average: number | null; toPar: number | null }

export interface RoundStats {
  roundId: string;
  holesScored: number;                  // holes with strokes entered
  gross: number;                        // sum of the strokes entered
  fairways: Ratio;                      // par 4s and 5s with a tee-shot result
  fairwayMisses: Record<Exclude<FairwayResult, 'hit'>, number>;
  gir: Ratio;                           // holes with strokes and putts: strokes - putts <= par - 2
  putts: number;                        // total putts on holes with putts entered
  puttHoles: number;                    // holes with putts entered
  byPar: Record<3 | 4 | 5, ParScoring>;
}

export interface StatsSummary {
  rounds: number;
  fairways: Ratio;
  fairwayMisses: RoundStats['fairwayMisses'];
  gir: Ratio;
  puttsPerHole: number | null;
  puttsPer18: number | null;            // putts per hole x 18, so 9- and 18-hole rounds mix fairly
  puttHoles: number;
  byPar: Record<3 | 4 | 5, ParScoring>;
}

const PARS = [3, 4, 5] as const;

function emptyPar(): Record<3 | 4 | 5, ParScoring> {
  return { 3: { holes: 0, strokes: 0, average: null, toPar: null }, 4: { holes: 0, strokes: 0, average: null, toPar: null },
    5: { holes: 0, strokes: 0, average: null, toPar: null } };
}

function finishPar(p: Record<3 | 4 | 5, ParScoring>): Record<3 | 4 | 5, ParScoring> {
  for (const par of PARS) {
    const s = p[par];
    s.average = s.holes ? s.strokes / s.holes : null;
    s.toPar = s.average === null ? null : s.average - par;
  }
  return p;
}

/** Greens in regulation: on the green in par minus two strokes or fewer. */
export function greenInRegulation(strokes: number, putts: number, par: number): boolean {
  return strokes - putts <= par - 2;
}

export function roundStats(round: Round): RoundStats {
  const out: RoundStats = {
    roundId: round.id, holesScored: 0, gross: 0, fairways: { hit: 0, of: 0 },
    fairwayMisses: { left: 0, right: 0, short: 0, long: 0 }, gir: { hit: 0, of: 0 }, putts: 0, puttHoles: 0,
    byPar: emptyPar(),
  };
  for (const hole of round.snapshot.holes) {
    const s = round.scores.find((x) => x.hole === hole.number);
    if (!s) continue;
    const strokes = typeof s.strokes === 'number' ? s.strokes : null;
    if (strokes !== null) {
      out.holesScored++; out.gross += strokes;
      if (hole.par === 3 || hole.par === 4 || hole.par === 5) {
        out.byPar[hole.par].holes++; out.byPar[hole.par].strokes += strokes;
      }
    }
    if (hole.par >= 4 && s.fairway) {
      out.fairways.of++;
      if (s.fairway === 'hit') out.fairways.hit++;
      else out.fairwayMisses[s.fairway]++;
    }
    if (typeof s.putts === 'number') {
      out.putts += s.putts; out.puttHoles++;
      if (strokes !== null) {
        out.gir.of++;
        if (greenInRegulation(strokes, s.putts, hole.par)) out.gir.hit++;
      }
    }
  }
  finishPar(out.byPar);
  return out;
}

/** Totals across rounds. Pass the rounds to include (the Shots tab passes the posted ones). */
export function summarizeStats(rounds: Round[]): StatsSummary {
  const per = rounds.map(roundStats);
  const sum: StatsSummary = {
    rounds: rounds.length, fairways: { hit: 0, of: 0 }, fairwayMisses: { left: 0, right: 0, short: 0, long: 0 },
    gir: { hit: 0, of: 0 }, puttsPerHole: null, puttsPer18: null, puttHoles: 0, byPar: emptyPar(),
  };
  let putts = 0;
  for (const r of per) {
    sum.fairways.hit += r.fairways.hit; sum.fairways.of += r.fairways.of;
    for (const k of Object.keys(sum.fairwayMisses) as (keyof RoundStats['fairwayMisses'])[]) {
      sum.fairwayMisses[k] += r.fairwayMisses[k];
    }
    sum.gir.hit += r.gir.hit; sum.gir.of += r.gir.of;
    putts += r.putts; sum.puttHoles += r.puttHoles;
    for (const par of PARS) { sum.byPar[par].holes += r.byPar[par].holes; sum.byPar[par].strokes += r.byPar[par].strokes; }
  }
  if (sum.puttHoles) { sum.puttsPerHole = putts / sum.puttHoles; sum.puttsPer18 = sum.puttsPerHole * 18; }
  finishPar(sum.byPar);
  return sum;
}

/** Whole-number percentage, or null with nothing recorded. */
export function percent(r: Ratio): number | null {
  return r.of ? Math.round((r.hit / r.of) * 100) : null;
}

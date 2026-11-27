// World Handicap System calculations (plan section 5). Pure functions, no DOM, no dates from the clock.
//
// The index this app shows is unofficial: it follows the published WHS rules as closely as a personal tracker can,
// but only a golf association can issue an official Handicap Index.

import type { Gender, Hole, ImportedDifferential, Profile, Round, Tee } from './types';

// ---------------------------------------------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------------------------------------------

/** Nearest tenth, .5 rounds up toward +infinity (-1.25 -> -1.2, 1.25 -> 1.3). Never returns -0. */
export function roundTenth(x: number): number {
  // toFixed(6) removes binary noise such as 1.15 * 10 = 11.499999999999998 before rounding.
  const r = Math.round(Number((x * 10).toFixed(6))) / 10;
  return r === 0 ? 0 : r;
}

/** Nearest whole number, .5 rounds up toward +infinity (-2.5 -> -2). Never returns -0. */
export function roundWhole(x: number): number {
  const r = Math.round(Number(x.toFixed(6)));
  return r === 0 ? 0 : r;
}

export const MAX_INDEX = 54.0;

// ---------------------------------------------------------------------------------------------------------------
// 1. Course Handicap
// ---------------------------------------------------------------------------------------------------------------

/**
 * Course Handicap. 18 holes: HI x slope / 113 + (rating - par).
 * 9 holes: (HI / 2) x slope9 / 113 + (rating9 - par9); pass the 9-hole rating, slope and par with `holes = 9`.
 */
export function courseHandicap(index: number, rating: number, slope: number, par: number, holes: 9 | 18 = 18): number {
  const hi = holes === 9 ? index / 2 : index;
  return roundWhole((hi * slope) / 113 + (rating - par));
}

export interface PlayedTeeValues { rating: number; slope: number; par: number; holes: Hole[] }

/**
 * Rating, slope, par and holes for what is being played on a tee. Nine holes use the tee's front / back rating and
 * slope; a missing 9-hole rating falls back to rating / 2 and the 18-hole slope.
 */
export function playedTeeValues(courseHoles: Hole[], tee: Tee, holesPlayed: Round['holesPlayed']): PlayedTeeValues {
  if (holesPlayed === '18') {
    return { rating: tee.rating, slope: tee.slope, par: tee.par, holes: courseHoles.slice() };
  }
  const front = holesPlayed === 'F9';
  const holes = courseHoles.filter((h) => (front ? h.number <= 9 : h.number >= 10));
  const par = holes.reduce((s, h) => s + h.par, 0);
  const rating9 = front ? tee.frontRating : tee.backRating;
  const slope9 = front ? tee.frontSlope : tee.backSlope;
  if (rating9 === undefined) return { rating: roundTenth(tee.rating / 2), slope: tee.slope, par, holes };
  return { rating: rating9, slope: slope9 ?? tee.slope, par, holes };
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Strokes per hole
// ---------------------------------------------------------------------------------------------------------------

function holeIndex(h: Hole, gender: Gender): number {
  return gender === 'W' ? h.strokeIndexW ?? h.strokeIndex : h.strokeIndex;
}

/**
 * Strokes received on each hole, in the order of `holes`. The holes are ranked 1..n by stroke index (for a 9-hole
 * round the nine holes are re-ranked 1-9). CH >= 0: one stroke where rank <= CH, a second where rank <= CH - n, and
 * so on. CH < 0: strokes are given back starting from the highest rank (stroke index 18) downward.
 */
export function strokeAllocation(holes: Hole[], ch: number, gender: Gender = 'M'): number[] {
  const n = holes.length;
  if (n === 0) return [];
  const order = holes
    .map((h, i) => ({ i, si: holeIndex(h, gender), num: h.number }))
    .sort((a, b) => a.si - b.si || a.num - b.num);
  const rank = new Array<number>(n);
  order.forEach((o, r) => { rank[o.i] = r + 1; });
  const m = Math.abs(ch);
  const base = Math.floor(m / n);
  const extra = m % n;
  return holes.map((_, i) => {
    if (ch >= 0) return base + (rank[i] <= extra ? 1 : 0);
    const back = base + (rank[i] > n - extra ? 1 : 0);
    return back === 0 ? 0 : -back;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Adjusted Gross Score
// ---------------------------------------------------------------------------------------------------------------

/** Hole maximum: net double bogey (par + 2 + strokes received); with no index yet, par + 5. */
export function holeMaximum(par: number, strokesReceived: number, hasIndex: boolean): number {
  return hasIndex ? par + 2 + strokesReceived : par + 5;
}

export interface AdjustedGross {
  postable: boolean;
  reason?: string;
  ags: number | null;            // null when not postable
  holesCompleted: number;
  incomplete: boolean;           // some holes were not played and count net par
  strokesReceived: number[];     // per snapshot hole
  holeMax: number[];             // per snapshot hole
  adjusted: (number | null)[];   // the score counted on each hole (null when not postable and not played)
}

/**
 * Adjusted Gross Score for a round. `ch` is the course handicap at the time of play (null with no index, which also
 * switches the hole maximum to par + 5). 18-hole rounds: all 18, or 10-17 holes with the rest at net par
 * (`incomplete`); 9 or fewer cannot be posted as 18. 9-hole rounds: all 9, or 7-8 holes with the rest at net par.
 */
export function adjustedGrossScore(round: Pick<Round, 'snapshot' | 'scores' | 'holesPlayed'>, ch: number | null,
  gender: Gender = 'M'): AdjustedGross {
  const holes = round.snapshot.holes;
  const strokesReceived = ch === null ? holes.map(() => 0) : strokeAllocation(holes, ch, gender);
  const holeMax = holes.map((h, i) => holeMaximum(h.par, strokesReceived[i], ch !== null));
  const played = holes.map((h) => {
    const s = round.scores.find((x) => x.hole === h.number)?.strokes;
    return typeof s === 'number' && s > 0 ? s : null;
  });
  const holesCompleted = played.filter((s) => s !== null).length;
  const nine = round.holesPlayed !== '18';
  const minHoles = nine ? 7 : 10;
  const adjusted = played.map((s, i) => (s === null ? null : Math.min(s, holeMax[i])));
  if (holesCompleted < minHoles) {
    return {
      postable: false,
      reason: nine ? 'A 9-hole score needs at least 7 holes played.'
        : 'An 18-hole score needs at least 10 holes played.',
      ags: null, holesCompleted, incomplete: true, strokesReceived, holeMax, adjusted,
    };
  }
  const counted = adjusted.map((s, i) => (s === null ? holes[i].par + strokesReceived[i] : s));
  return {
    postable: true,
    ags: counted.reduce((a, b) => a + b, 0),
    holesCompleted,
    incomplete: holesCompleted < holes.length,
    strokesReceived, holeMax, adjusted: counted,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 4-5. Score Differentials
// ---------------------------------------------------------------------------------------------------------------

/** 18-hole Score Differential = (113 / slope) x (AGS - rating - PCC), to the tenth. */
export function scoreDifferential(ags: number, rating: number, slope: number, pcc = 0): number {
  return roundTenth((113 / slope) * (ags - rating - pcc));
}

/** 9-hole Score Differential = (113 / slope9) x (AGS9 - rating9 - PCC / 2), to the tenth. */
export function nineHoleDifferential(ags9: number, rating9: number, slope9: number, pcc = 0): number {
  return roundTenth((113 / slope9) * (ags9 - rating9 - pcc / 2));
}

/**
 * Expected 9-hole Score Differential for the unplayed nine: 0.52 x HI + 1.2, to the tenth.
 * This is an APPROXIMATION of the USGA expected-score table (WHS 2024), not the table itself.
 */
export function expectedNineHoleDifferential(index: number): number {
  return roundTenth(0.52 * index + 1.2);
}

/** A 9-hole score posted as 18: diff9 + expected 9-hole differential at the index in effect. */
export function nineHoleToEighteen(diff9: number, indexInEffect: number): number {
  return roundTenth(diff9 + expectedNineHoleDifferential(indexInEffect));
}

// ---------------------------------------------------------------------------------------------------------------
// 6. Handicap Index from differentials
// ---------------------------------------------------------------------------------------------------------------

/** How many of the lowest differentials count, and the adjustment, for a number of scores (capped at 20). */
export function differentialsToUse(scores: number): { use: number; adjustment: number } | null {
  const n = Math.min(scores, 20);
  if (n < 3) return null;
  if (n === 3) return { use: 1, adjustment: -2.0 };
  if (n === 4) return { use: 1, adjustment: -1.0 };
  if (n === 5) return { use: 1, adjustment: 0 };
  if (n === 6) return { use: 2, adjustment: -1.0 };
  if (n <= 8) return { use: 2, adjustment: 0 };
  if (n <= 11) return { use: 3, adjustment: 0 };
  if (n <= 14) return { use: 4, adjustment: 0 };
  if (n <= 16) return { use: 5, adjustment: 0 };
  if (n <= 18) return { use: 6, adjustment: 0 };
  if (n === 19) return { use: 7, adjustment: 0 };
  return { use: 8, adjustment: 0 };
}

/**
 * Index from up to the 20 most recent differentials (oldest first; only the last 20 are read): average of the lowest
 * per the table, plus the adjustment, to the tenth, at most 54.0. `used` are positions in `diffs`.
 */
export function indexFromDifferentials(diffs: number[]): { index: number; used: number[]; adjustment: number } | null {
  const offset = Math.max(0, diffs.length - 20);
  const recent = diffs.slice(offset);
  const rule = differentialsToUse(recent.length);
  if (!rule) return null;
  const lowest = recent
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d - b.d || b.i - a.i) // ties: the more recent score counts
    .slice(0, rule.use);
  const avg = lowest.reduce((s, x) => s + x.d, 0) / rule.use;
  const index = Math.min(MAX_INDEX, roundTenth(avg + rule.adjustment));
  return { index, used: lowest.map((x) => x.i + offset).sort((a, b) => a - b), adjustment: rule.adjustment };
}

// ---------------------------------------------------------------------------------------------------------------
// 7. Exceptional scores
// ---------------------------------------------------------------------------------------------------------------

/** -1 when the differential is 7.0-9.9 below the index in effect, -2 when 10.0 or more below, else 0. */
export function exceptionalScoreAdjustment(differential: number, indexInEffect: number | null): 0 | -1 | -2 {
  if (indexInEffect === null) return 0;
  const below = roundTenth(indexInEffect - differential);
  if (below >= 10) return -2;
  if (below >= 7) return -1;
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// 8. Caps
// ---------------------------------------------------------------------------------------------------------------

export type Cap = 'soft' | 'hard' | null;

/** Soft cap halves any rise beyond 3.0 above the Low Index; hard cap: never more than 5.0 above it. */
export function applyCaps(calculated: number, lowIndex: number | null): { index: number; cap: Cap } {
  if (lowIndex === null) return { index: calculated, cap: null };
  const rise = roundTenth(calculated - lowIndex);
  if (rise <= 3) return { index: calculated, cap: null };
  const soft = roundTenth(lowIndex + 3 + (rise - 3) / 2);
  const hard = roundTenth(lowIndex + 5);
  if (soft > hard) return { index: hard, cap: 'hard' };
  return { index: soft, cap: 'soft' };
}

/** Days between two ISO dates (b - a), by calendar date. */
function daysBetween(a: string, b: string): number {
  const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((d(b) - d(a)) / 86400000);
}

// ---------------------------------------------------------------------------------------------------------------
// 9. History replay
// ---------------------------------------------------------------------------------------------------------------

export type EntryKind = 'round' | 'nine' | 'combined-nine' | 'imported' | 'hypothetical';

export interface HistoryEntry {
  kind: EntryKind;
  id: string;                    // round id, imported id, or "<first>+<second>" for two combined nines
  roundIds: string[];            // rounds behind this score (empty for imported)
  date: string;
  courseHandicap: number | null; // at the time of play (from the replayed index in effect)
  ags: number | null;            // for combined nines, the second nine's AGS; null for imported
  incomplete: boolean;
  indexInEffect: number | null;  // calculated index before this score, else the starting index, else null
  nineHoleDifferential?: number; // 9-hole rounds: the 9-hole differential
  expectedNineHole?: number;     // 9-hole rounds with an index: the expected-score approximation added
  differential: number;          // the 18-hole Score Differential as posted
  esrAdjustment: 0 | -1 | -2;    // exceptional-score adjustment this score triggered
  totalAdjustment: number;       // all exceptional-score adjustments that landed on this score
  adjustedDifferential: number;  // differential + totalAdjustment: the value used in the index
  indexAfter: number | null;     // calculated index once this score is in (null with fewer than 3 scores)
  lowIndex: number | null;       // Low Index used for the caps at this score
  cap: Cap;                      // cap applied to indexAfter
  counting: boolean;             // one of the scores the current index is made from
}

export interface HandicapHistory {
  entries: HistoryEntry[];       // oldest first
  currentIndex: number | null;   // calculated index (3+ scores)
  indexSource: 'calculated' | 'starting' | 'none';
  displayIndex: number | null;   // currentIndex, else the profile's starting index, else null
  lowIndex: number | null;
  capApplied: Cap;
  trend: { date: string; index: number }[];
  countingIds: string[];         // entry ids of the counting scores
  waitingNine: string | null;    // a 9-hole round (no index yet) waiting for the next 9-hole round
  notPosted: { roundId: string; reason: string }[];
}

interface Hypothetical {
  date: string; ags: number; rating: number; slope: number; par: number; nine: boolean; pcc: number;
}

type Item =
  | { t: 'round'; date: string; key: string; round: Round }
  | { t: 'imported'; date: string; key: string; imp: ImportedDifferential }
  | { t: 'hypothetical'; date: string; key: string; h: Hypothetical };

function replay(rounds: Round[], imported: ImportedDifferential[], profile: Profile | null | undefined,
  hypothetical?: Hypothetical): HandicapHistory {
  const gender: Gender = profile?.gender ?? 'M';
  const starting = typeof profile?.startingIndex === 'number' ? profile.startingIndex : null;
  const items: Item[] = [
    ...imported.map((imp): Item => ({ t: 'imported', date: imp.date, key: '0' + imp.id, imp })),
    ...rounds.filter((r) => r.status === 'posted')
      .map((round): Item => ({ t: 'round', date: round.date, key: '1' + round.id, round })),
  ];
  // Date order; on the same date imported scores first, then by id, so the replay is deterministic.
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (hypothetical) items.push({ t: 'hypothetical', date: hypothetical.date, key: '2', h: hypothetical });

  const entries: HistoryEntry[] = [];
  const notPosted: HandicapHistory['notPosted'] = [];
  let calculated: number | null = null;
  let pendingNine: { id: string; diff9: number } | null = null;

  for (const item of items) {
    const indexInEffect = calculated ?? starting;
    let entry: HistoryEntry;
    const base = { indexInEffect, esrAdjustment: 0 as const, totalAdjustment: 0, adjustedDifferential: 0,
      indexAfter: null, lowIndex: null, cap: null as Cap, counting: false };

    if (item.t === 'imported') {
      entry = { ...base, kind: 'imported', id: item.imp.id, roundIds: [], date: item.date, courseHandicap: null,
        ags: null, incomplete: false, differential: roundTenth(item.imp.differential) };
    } else {
      let rating: number, slope: number, par: number, nine: boolean, pcc: number, ags: number;
      let incomplete = false; let ch: number | null;
      if (item.t === 'round') {
        const r = item.round;
        ({ rating, slope, par } = r.snapshot);
        nine = r.holesPlayed !== '18'; pcc = r.pcc ?? 0;
        ch = indexInEffect === null ? null : courseHandicap(indexInEffect, rating, slope, par, nine ? 9 : 18);
        const a = adjustedGrossScore(r, ch, gender);
        if (!a.postable || a.ags === null) { notPosted.push({ roundId: r.id, reason: a.reason ?? '' }); continue; }
        ags = a.ags; incomplete = a.incomplete;
      } else {
        ({ rating, slope, par, nine, pcc, ags } = item.h);
        ch = indexInEffect === null ? null : courseHandicap(indexInEffect, rating, slope, par, nine ? 9 : 18);
      }
      const id = item.t === 'round' ? item.round.id : 'hypothetical';
      const kindOf: EntryKind = item.t === 'hypothetical' ? 'hypothetical' : nine ? 'nine' : 'round';
      if (!nine) {
        entry = { ...base, kind: kindOf, id, roundIds: item.t === 'round' ? [id] : [], date: item.date,
          courseHandicap: ch, ags, incomplete, differential: scoreDifferential(ags, rating, slope, pcc) };
      } else {
        const diff9 = nineHoleDifferential(ags, rating, slope, pcc);
        if (indexInEffect !== null) {
          const expected = expectedNineHoleDifferential(indexInEffect);
          entry = { ...base, kind: kindOf, id, roundIds: item.t === 'round' ? [id] : [], date: item.date,
            courseHandicap: ch, ags, incomplete, nineHoleDifferential: diff9, expectedNineHole: expected,
            differential: roundTenth(diff9 + expected) };
        } else if (pendingNine) {
          entry = { ...base, kind: item.t === 'hypothetical' ? 'hypothetical' : 'combined-nine',
            id: `${pendingNine.id}+${id}`, roundIds: [pendingNine.id, ...(item.t === 'round' ? [id] : [])],
            date: item.date, courseHandicap: null, ags, incomplete, nineHoleDifferential: diff9,
            differential: roundTenth(pendingNine.diff9 + diff9) };
          pendingNine = null;
        } else {
          pendingNine = { id, diff9 };
          continue;
        }
      }
    }

    entries.push(entry);
    // Exceptional score: only for scores made in the app (imported differentials arrive already final).
    if (entry.kind !== 'imported') {
      const esr = exceptionalScoreAdjustment(entry.differential, indexInEffect);
      entry.esrAdjustment = esr;
      if (esr !== 0) for (const e of entries.slice(-20)) e.totalAdjustment += esr;
    }
    for (const e of entries.slice(-20)) e.adjustedDifferential = roundTenth(e.differential + e.totalAdjustment);

    const recent = entries.slice(-20);
    const calc = indexFromDifferentials(recent.map((e) => e.adjustedDifferential));
    if (calc) {
      let low: number | null = null;
      if (entries.length >= 20) {
        for (const e of entries.slice(0, -1)) {
          const d = daysBetween(e.date, entry.date);
          if (e.indexAfter !== null && d > 0 && d <= 365 && (low === null || e.indexAfter < low)) low = e.indexAfter;
        }
      }
      const capped = applyCaps(calc.index, low);
      entry.indexAfter = capped.index; entry.lowIndex = low; entry.cap = capped.cap;
      calculated = capped.index;
    } else {
      calculated = null;
    }
  }

  const recent = entries.slice(-20);
  const final = indexFromDifferentials(recent.map((e) => e.adjustedDifferential));
  const offset = entries.length - recent.length;
  if (final) for (const i of final.used) entries[offset + i].counting = true;
  const last = entries[entries.length - 1];
  const currentIndex = final && last ? last.indexAfter : null;
  return {
    entries,
    currentIndex,
    indexSource: currentIndex !== null ? 'calculated' : starting !== null ? 'starting' : 'none',
    displayIndex: currentIndex ?? starting,
    lowIndex: currentIndex !== null ? last.lowIndex : null,
    capApplied: currentIndex !== null ? last.cap : null,
    trend: entries.filter((e) => e.indexAfter !== null).map((e) => ({ date: e.date, index: e.indexAfter as number })),
    countingIds: entries.filter((e) => e.counting).map((e) => e.id),
    waitingNine: pendingNine ? pendingNine.id : null,
    notPosted,
  };
}

/**
 * Replays every posted round and imported differential in date order. Each score's course handicap, hole maximums,
 * exceptional-score check and expected 9-hole score use the index in effect when it was played, as replayed here
 * (the stored `Round.courseHandicap` is not read). Active rounds are ignored.
 */
export function computeHistory(rounds: Round[], imported: ImportedDifferential[],
  profile?: Profile | null): HandicapHistory {
  return replay(rounds, imported, profile);
}

// ---------------------------------------------------------------------------------------------------------------
// Target score
// ---------------------------------------------------------------------------------------------------------------

export interface TargetScoreInput {
  rounds: Round[];
  imported: ImportedDifferential[];
  profile?: Profile | null;
  rating: number; slope: number; par: number;   // as from playedTeeValues for what will be played
  holesPlayed: Round['holesPlayed'];
  date: string;                                   // today, ISO date
  pcc?: number;
}

export interface TargetScore {
  lowerIndex: number | null;    // highest adjusted gross that would lower the calculated index
  countingScore: number | null; // highest adjusted gross that would be one of the counting scores
  courseHandicap: number | null;
}

/**
 * The adjusted gross score to beat today. Each candidate score is posted hypothetically after every existing score
 * and the whole history replayed, so exceptional scores and caps are included. `lowerIndex` is null until there is
 * a calculated index; both are null when the score would not produce a differential (a 9-hole round with no index
 * and no other nine waiting).
 */
export function targetScore(input: TargetScoreInput): TargetScore {
  const nine = input.holesPlayed !== '18';
  const pcc = input.pcc ?? 0;
  const current = replay(input.rounds, input.imported, input.profile);
  const inEffect = current.currentIndex ?? input.profile?.startingIndex ?? null;
  const ch = inEffect === null ? null : courseHandicap(inEffect, input.rating, input.slope, input.par, nine ? 9 : 18);
  const minHoles = nine ? 9 : 18;
  const top = input.par * 3;
  let lowerIndex: number | null = null;
  let countingScore: number | null = null;
  for (let g = top; g >= minHoles; g--) {
    if (lowerIndex !== null && countingScore !== null) break;
    const h = replay(input.rounds, input.imported, input.profile,
      { date: input.date, ags: g, rating: input.rating, slope: input.slope, par: input.par, nine, pcc });
    const e = h.entries[h.entries.length - 1];
    if (!e || e.kind !== 'hypothetical') return { lowerIndex: null, countingScore: null, courseHandicap: ch };
    if (countingScore === null && e.counting) countingScore = g;
    if (lowerIndex === null && current.currentIndex !== null && h.currentIndex !== null
      && h.currentIndex < current.currentIndex) lowerIndex = g;
  }
  return { lowerIndex, countingScore, courseHandicap: ch };
}

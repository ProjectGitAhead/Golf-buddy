// Round helpers shared by the screens: creating a round, per-hole facts, running totals, display formats.
import { courseHandicap, holeMaximum, playedTeeValues, strokeAllocation } from '../core/handicap';
import type { Course, Gender, Hole, HoleScore, Round, Tee } from '../core/types';

export function todayISO(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Ids use only letters, digits and hyphens so they are valid db path segments. */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const HOLES_LABEL: Record<Round['holesPlayed'], string> = { '18': '18 holes', F9: 'Front 9', B9: 'Back 9' };

export function teeYards(tee: Tee): number {
  return tee.yardages.reduce((a, b) => a + (b || 0), 0);
}

/** Course handicap for a tee and length, or null with no index. */
export function courseHandicapFor(index: number | null, course: Course, tee: Tee,
  holesPlayed: Round['holesPlayed']): number | null {
  if (index === null) return null;
  const v = playedTeeValues(course.holes, tee, holesPlayed);
  return courseHandicap(index, v.rating, v.slope, v.par, holesPlayed === '18' ? 18 : 9);
}

export function createRound(course: Course, tee: Tee, holesPlayed: Round['holesPlayed'], date: string,
  index: number | null): Round {
  const v = playedTeeValues(course.holes, tee, holesPlayed);
  return {
    id: newId('r'),
    date,
    courseId: course.id,
    teeId: tee.id,
    snapshot: { courseName: course.name, teeName: tee.name, rating: v.rating, slope: v.slope, par: v.par,
      holes: v.holes.map((h) => ({ ...h })) },
    holesPlayed,
    pcc: 0,
    scores: v.holes.map((h) => ({ hole: h.number, strokes: null })),
    status: 'active',
    courseHandicap: courseHandicapFor(index, course, tee, holesPlayed),
    updatedAt: '',
  };
}

export interface HoleFacts {
  hole: Hole;
  yards: number | null;
  strokesReceived: number;
  max: number;
  score: HoleScore;
}

/**
 * Per-hole facts for a round, from its frozen snapshot (yards come from the course, which the snapshot lacks).
 * `courseHandicap` overrides the stored one: posted rounds pass the course handicap from `computeHistory`
 * (`roundFacts`), so the maximums shown are the ones the posted AGS used. The stored `round.courseHandicap` is
 * only for the round in progress.
 */
export function holeFacts(round: Round, course: Course | undefined, gender: Gender,
  courseHandicap: number | null = round.courseHandicap): HoleFacts[] {
  const holes = round.snapshot.holes;
  const ch = courseHandicap;
  const received = ch === null ? holes.map(() => 0) : strokeAllocation(holes, ch, gender);
  const tee = course?.tees.find((t) => t.id === round.teeId);
  return holes.map((h, i) => ({
    hole: h,
    yards: tee && tee.yardages[h.number - 1] ? tee.yardages[h.number - 1] : null,
    strokesReceived: received[i],
    max: holeMaximum(h.par, received[i], ch !== null),
    score: round.scores.find((s) => s.hole === h.number) ?? { hole: h.number, strokes: null },
  }));
}

export interface Totals { strokes: number; par: number; thru: number; toPar: number; putts: number }

export function totals(facts: HoleFacts[]): Totals {
  let strokes = 0, par = 0, thru = 0, putts = 0;
  for (const f of facts) {
    if (typeof f.score.strokes === 'number') {
      strokes += f.score.strokes; par += f.hole.par; thru += 1;
    }
    putts += f.score.putts ?? 0;
  }
  return { strokes, par, thru, toPar: strokes - par, putts };
}

/** "E", "+3", "−2" (a true minus sign). */
export function formatToPar(n: number): string {
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

export function formatSigned(n: number): string {
  return n < 0 ? `−${Math.abs(n).toFixed(1)}` : n.toFixed(1);
}

/** Index for display: "12.4", "+1.2" for plus handicaps (stored as negatives). */
export function formatIndex(n: number | null): string {
  if (n === null) return '–';
  return n < 0 ? `+${Math.abs(n).toFixed(1)}` : n.toFixed(1);
}

/** Scorecard notation: circles for birdie or better, squares for bogey or worse. */
export function scoreMark(strokes: number | null | undefined, par: number): string {
  if (typeof strokes !== 'number') return '';
  const d = strokes - par;
  if (d <= -2) return 'mk-eagle';
  if (d === -1) return 'mk-birdie';
  if (d === 1) return 'mk-bogey';
  if (d >= 2) return 'mk-double';
  return 'mk-par';
}

const NAMES: Record<string, string> = { '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', '0': 'Par', '1': 'Bogey',
  '2': 'Double bogey', '3': 'Triple bogey' };

export function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return 'Hole in one';
  const d = strokes - par;
  return NAMES[String(d)] ?? (d > 0 ? `${d} over` : `${-d} under`);
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

/** The round in progress, if any (the most recently changed one). */
export function activeRound(rounds: Record<string, Round>): Round | undefined {
  return Object.values(rounds).filter((r) => r.status === 'active')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

export function postedRounds(rounds: Record<string, Round>): Round[] {
  return Object.values(rounds).filter((r) => r.status === 'posted')
    .sort((a, b) => (a.date === b.date ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.date < b.date ? 1 : -1));
}

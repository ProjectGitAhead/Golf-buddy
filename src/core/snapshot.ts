// What a round keeps of its course (plan section 4: the snapshot is frozen at the start of play). Only the fields
// scoring and the handicap need are copied, from an allow-list, so course geometry (greens, outlines, hazards) and
// any field added to `Hole` later never bloat a stored round. Live yardage always reads geometry from the course.
import type { Hole, Round } from './types';

/** A hole as a round's snapshot holds it: number, par, stroke index and (when set) the women's stroke index. */
export function scoringHole(h: Hole): Hole {
  const out: Hole = { number: h.number, par: h.par, strokeIndex: h.strokeIndex };
  if (h.strokeIndexW !== undefined) out.strokeIndexW = h.strokeIndexW;
  return out;
}

const KEYS = new Set(['number', 'par', 'strokeIndex', 'strokeIndexW']);

/**
 * The round with any non-scoring field taken off its snapshot holes. The same object when there is nothing to take
 * off. `updatedAt` is left alone: this is not an edit, so it never makes a copy win or lose a merge.
 */
export function cleanRound(r: Round): Round {
  const holes = r?.snapshot?.holes;
  if (!Array.isArray(holes) || holes.every((h) => Object.keys(h).every((k) => KEYS.has(k)))) return r;
  return { ...r, snapshot: { ...r.snapshot, holes: holes.map(scoringHole) } };
}

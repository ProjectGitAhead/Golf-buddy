// Approach marks: where the ball finished relative to the pin (plan section 8). Pure logic, no DOM: clamping,
// the short readout ("14 ft, short left"), collecting marks from rounds with the Shots filters, a kernel-density
// grid for the heat map, and the summary lines shown from 5 marks up.
import type { ApproachMark, Round } from './types';

/** Marks further than this from the pin are pulled in to it (a photo answer that far off is not a green read). */
export const MAX_FT = 150;
/** The summary (average distance, share on green, miss pattern) appears from this many marks. */
export const SUMMARY_MIN = 5;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Keeps a mark within MAX_FT of the pin (same direction), rounded to 0.1 ft. */
export function clampMark<T extends { xFt: number; yFt: number }>(m: T): T {
  const d = Math.hypot(m.xFt, m.yFt);
  const k = d > MAX_FT ? MAX_FT / d : 1;
  return { ...m, xFt: round1(m.xFt * k) || 0, yFt: round1(m.yFt * k) || 0 };
}

export function distanceFt(m: { xFt: number; yFt: number }): number {
  return Math.hypot(m.xFt, m.yFt);
}

/**
 * Direction in words, from where the shot was hit: "short", "long left", "right"… One of eight 45° sectors, so a
 * ball 10 ft short and 2 ft left reads "short", and 8 ft short and 7 ft left reads "short left".
 */
export function direction(m: { xFt: number; yFt: number }): string {
  const deg = (Math.atan2(m.xFt, m.yFt) * 180) / Math.PI;      // 0 = long, 90 = right, ±180 = short
  const names = ['long', 'long right', 'right', 'short right', 'short', 'short left', 'left', 'long left'];
  return names[(Math.round(((deg + 360) % 360) / 45)) % 8];
}

/** The short readout: "14 ft, short left", "Inside a foot", "38 ft, long, off the green". */
export function describeMark(m: Pick<ApproachMark, 'xFt' | 'yFt'> & { onGreen?: boolean }): string {
  const d = distanceFt(m);
  const off = m.onGreen === false ? ', off the green' : '';
  if (d < 1) return `Inside a foot${off}`;
  return `${Math.round(d)} ft, ${direction(m)}${off}`;
}

// ---- collecting marks ----

export type ApproachFilter = 'all' | 'par3' | 'course' | 'last5';

export interface MarkEntry {
  mark: ApproachMark;
  roundId: string;
  courseId: string;
  date: string;
  hole: number;
  par: number;
}

/** Rounds newest first (date, then last change). */
function newestFirst(rounds: Round[]): Round[] {
  return [...rounds].sort((a, b) => (a.date === b.date ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.date < b.date ? 1 : -1));
}

/** The course "This course" means: the round in progress, else the most recent round. */
export function currentCourseId(rounds: Round[]): string | undefined {
  const active = rounds.filter((r) => r.status === 'active').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  return active?.courseId ?? newestFirst(rounds)[0]?.courseId;
}

function isMark(m: unknown): m is ApproachMark {
  const o = m as ApproachMark | undefined;
  return !!o && Number.isFinite(o.xFt) && Number.isFinite(o.yFt);
}

/** Every mark in posted and active rounds that passes the filter, newest round first. */
export function collectMarks(rounds: Round[], filter: ApproachFilter = 'all', courseId?: string): MarkEntry[] {
  let list = newestFirst(rounds);
  if (filter === 'last5') list = list.slice(0, 5);
  if (filter === 'course') list = list.filter((r) => r.courseId === courseId);
  const out: MarkEntry[] = [];
  for (const r of list) {
    for (const s of r.scores) {
      if (!isMark(s.approach)) continue;
      const par = r.snapshot.holes.find((h) => h.number === s.hole)?.par ?? 0;
      if (filter === 'par3' && par !== 3) continue;
      out.push({ mark: s.approach, roundId: r.id, courseId: r.courseId, date: r.date, hole: s.hole, par });
    }
  }
  return out;
}

// ---- density ----

export interface DensityGrid {
  size: number;           // cells per side
  extentFt: number;       // the grid covers -extentFt..+extentFt on both axes
  bandwidthFt: number;
  values: Float64Array;   // row-major, row 0 = the long edge (+y), normalised so the peak is 1 (all 0 with no marks)
}

/**
 * Gaussian kernel density over a square grid centred on the pin. The bandwidth follows Scott's rule on the
 * marks' spread, kept between 4 and 10 ft so a few marks still read as a pattern, not as pinpricks.
 */
export function densityGrid(marks: { xFt: number; yFt: number }[], size = 72, extentFt = 45, bandwidthFt?: number): DensityGrid {
  const values = new Float64Array(size * size);
  const n = marks.length;
  let h = bandwidthFt ?? 6;
  if (bandwidthFt === undefined && n > 1) {
    const sd = (k: 'xFt' | 'yFt') => {
      const mean = marks.reduce((a, m) => a + m[k], 0) / n;
      return Math.sqrt(marks.reduce((a, m) => a + (m[k] - mean) ** 2, 0) / (n - 1));
    };
    h = Math.min(10, Math.max(4, ((sd('xFt') + sd('yFt')) / 2) * n ** (-1 / 6)));
  }
  if (!n) return { size, extentFt, bandwidthFt: h, values };
  const cell = (2 * extentFt) / size;
  const inv = 1 / (2 * h * h);
  let peak = 0;
  for (let row = 0; row < size; row++) {
    const y = extentFt - (row + 0.5) * cell;
    for (let col = 0; col < size; col++) {
      const x = -extentFt + (col + 0.5) * cell;
      let v = 0;
      for (const m of marks) {
        const dx = x - m.xFt, dy = y - m.yFt;
        v += Math.exp(-(dx * dx + dy * dy) * inv);
      }
      values[row * size + col] = v;
      if (v > peak) peak = v;
    }
  }
  if (peak > 0) for (let i = 0; i < values.length; i++) values[i] /= peak;
  return { size, extentFt, bandwidthFt: h, values };
}

// ---- summary ----

export interface ApproachSummary {
  count: number;
  avgDistFt: number;
  onGreenShare: number;     // 0..1
  centre: { xFt: number; yFt: number };
  shortShare: number; longShare: number; leftShare: number; rightShare: number;   // of all marks, 0..1
  lines: string[];          // the summary in words; empty below SUMMARY_MIN marks
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Words for an offset: "8 ft short, 3 ft left", "on the pin". Parts under 1 ft are left out. */
export function offsetWords(c: { xFt: number; yFt: number }): string {
  const parts: string[] = [];
  if (Math.abs(c.yFt) >= 1) parts.push(`${Math.round(Math.abs(c.yFt))} ft ${c.yFt < 0 ? 'short' : 'long'}`);
  if (Math.abs(c.xFt) >= 1) parts.push(`${Math.round(Math.abs(c.xFt))} ft ${c.xFt < 0 ? 'left' : 'right'}`);
  return parts.length ? parts.join(', ') : 'on the pin';
}

/** Average distance, share on the green, the pattern's centre and lean. Lines only from SUMMARY_MIN marks. */
export function summarize(marks: ApproachMark[]): ApproachSummary {
  const n = marks.length;
  const share = (f: (m: ApproachMark) => boolean) => (n ? marks.filter(f).length / n : 0);
  const s: ApproachSummary = {
    count: n,
    avgDistFt: n ? marks.reduce((a, m) => a + distanceFt(m), 0) / n : 0,
    onGreenShare: share((m) => m.onGreen),
    centre: { xFt: n ? marks.reduce((a, m) => a + m.xFt, 0) / n : 0, yFt: n ? marks.reduce((a, m) => a + m.yFt, 0) / n : 0 },
    shortShare: share((m) => m.yFt <= -1), longShare: share((m) => m.yFt >= 1),
    leftShare: share((m) => m.xFt <= -1), rightShare: share((m) => m.xFt >= 1),
    lines: [],
  };
  if (n < SUMMARY_MIN) return s;

  // The lean: the larger side of each axis, named when it holds a clear majority of all marks (55% or more).
  const depth = s.shortShare >= s.longShare ? { word: 'short', v: s.shortShare } : { word: 'long', v: s.longShare };
  const side = s.leftShare >= s.rightShare ? { word: 'left', v: s.leftShare } : { word: 'right', v: s.rightShare };
  const leans = [depth, side].filter((x) => x.v >= 0.55);
  if (leans.length) {
    s.lines.push(`${pct(leans[0].v)} finish ${leans[0].word} of the pin${leans[1] ? `, ${pct(leans[1].v)} ${leans[1].word} of it` : ''}.`);
  } else {
    s.lines.push(`No strong lean: ${pct(s.shortShare)} short, ${pct(s.longShare)} long, ${pct(s.leftShare)} left, ${pct(s.rightShare)} right.`);
  }
  s.lines.push(`The middle of your pattern is ${offsetWords(s.centre)}${offsetWords(s.centre) === 'on the pin' ? '' : ' of the pin'}.`);
  const misses = marks.filter((m) => !m.onGreen);
  if (misses.length >= 3) {
    const short = misses.filter((m) => m.yFt <= -1).length;
    const long = misses.filter((m) => m.yFt >= 1).length;
    const big = short >= long ? { word: 'short', k: short } : { word: 'long', k: long };
    if (big.k > 0) s.lines.push(`Off the green, ${big.k} of ${misses.length} misses finished ${big.word}.`);
  }
  return s;
}

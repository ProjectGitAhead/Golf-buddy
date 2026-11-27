// Scorecard scan (plan section 9): the prompt sent to Claude with the photos, and the parsing and checks that turn
// its answer into a course editor draft. Every value Claude could not read, or that fails a check, comes back as a
// flag keyed by the editor control id it belongs to, with the reason to show next to the field.
import type { CourseForm } from '../ui/screens/courses-editor';

const N = 18;

/** The `sample` capability as this file uses it (see the artifact-capabilities `sample.d.ts`). */
export interface SampleFn {
  json<T = unknown>(input: string, options?: { images?: Blob[]; signal?: AbortSignal; onText?: (u: { text: string }) => void }): Promise<T>;
  limits(): Promise<{ images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] } }>;
}

export function scorecardPrompt(photoCount: number): string {
  const photos = photoCount > 1
    ? `${photoCount} photos of one golf course's paper scorecard (for example the front and the back of the card)`
    : 'a photo of a golf course\'s paper scorecard';
  return `You are reading ${photos}. Copy the course data printed on it into JSON.

What a golf scorecard looks like:
- A grid with one column per hole (1 to 9, then OUT, then 10 to 18, then IN and TOTAL or TOT). Some cards print the
  front nine and back nine on separate panels or on the two sides of the card.
- One row per tee (named by colour or name, such as Black, Blue, White, Gold, Red, Championship, Forward) holding the
  yardage of every hole, with OUT, IN and TOTAL yardages.
- A "Par" row. Sometimes separate men's and women's par rows; use the men's one.
- A "Handicap" or "HCP" row (also called stroke index): every number from 1 to 18 appears exactly once across the 18
  holes. Some cards have two: men's (often "Men's HCP") and women's ("Ladies' HCP", "Women's HCP"). If there is
  only one handicap row, it is the men's.
- The course rating and slope for each tee, usually printed as "71.8/133" (rating/slope) next to the tee name or in a
  small table, sometimes with separate values for men and women. Rating is a decimal number between about 55 and
  80; slope is a whole number between 55 and 155.
- Rows for players' names and scores are empty boxes or handwriting: ignore them.

Reply with only one JSON object, no other text, in exactly this shape:
{
  "found": true,
  "name": "Course name as printed" or null,
  "city": "City" or null,
  "state": "State or region" or null,
  "holes": [
    {"number": 1, "par": 4, "strokeIndex": 7, "strokeIndexW": 5},
    ... one object for every hole number from 1 to 18, in order ...
  ],
  "tees": [
    {"name": "Blue", "gender": "M", "rating": 71.8, "slope": 133,
     "yardages": [18 numbers, hole 1 first], "out": 3405, "in": 3390, "total": 6795}
  ]
}

Rules:
- Use null for anything you cannot read clearly; never guess a number. A null is better than a wrong value.
- "strokeIndex" is the men's handicap row; "strokeIndexW" is the women's handicap row, or null if there is none.
- "yardages" always has 18 entries in hole order; put null for a hole you cannot read.
- "out", "in" and "total" are the totals printed on the card for that tee, or null if not printed. Do not add
  them up yourself.
- Give one tee object per tee and gender that has its own rating and slope: a tee rated for both men and women
  appears twice, once with "gender": "M" and once with "gender": "W", with the same yardages. A tee row with no
  rating printed appears once with "gender": null, "rating": null and "slope": null.
- If the card has only 9 holes, fill holes 10 to 18 with null values.
- If the photos do not show a golf scorecard, reply {"found": false}.`;
}

export interface ScanResult {
  found: boolean;
  form: CourseForm;
  /** Reasons keyed by editor control id: values not read or failing a check. */
  flags: Record<string, string>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A number from the answer: a finite number or a numeric string ("6,795" and "71.8" accepted); otherwise null. */
function readNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/(\d),(\d{3})\b/g, '$1$2');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function readText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

const fmt = (n: number) => n.toLocaleString('en-US');
const str = (n: number | null) => (n === null ? '' : String(n));
let seq = 0;
const teeId = () => `t-scan-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const NOT_READ = 'Not read from the photo. Copy it from the card.';

function listHoles(holes: number[]): string {
  return holes.length === 1 ? `hole ${holes[0]}` : `holes ${holes.slice(0, -1).join(', ')} and ${holes[holes.length - 1]}`;
}

/** Flags a stroke index row that is not a 1-18 permutation: blanks, out-of-range values and duplicates. */
function checkStrokeIndex(values: (number | null)[], idPrefix: string, flags: Record<string, string>) {
  const where = new Map<number, number[]>();
  values.forEach((v, i) => { if (v !== null) where.set(v, [...(where.get(v) ?? []), i + 1]); });
  const missing = Array.from({ length: N }, (_, i) => i + 1).filter((n) => !where.has(n));
  const missingNote = missing.length ? ` Missing: ${missing.join(', ')}.` : '';
  values.forEach((v, i) => {
    const id = `${idPrefix}-${i + 1}`;
    if (v === null) flags[id] = NOT_READ;
    else if (!Number.isInteger(v) || v < 1 || v > N) flags[id] = `Read as ${v}. A stroke index is 1 to 18.`;
    else if ((where.get(v) ?? []).length > 1) {
      const others = where.get(v)!.filter((n) => n !== i + 1);
      flags[id] = `Read as ${v}, same as ${listHoles(others)}. Each of 1 to 18 is used once.${missingNote}`;
    }
  });
}

/** Turns Claude's answer into an editor draft plus flags. Never throws; anything malformed becomes a flag. */
export function parseScorecard(raw: unknown): ScanResult {
  const flags: Record<string, string> = {};
  const r: Obj = isObj(raw) ? raw : {};
  const found = r.found !== false && (Array.isArray(r.holes) || Array.isArray(r.tees));

  const byNo = new Map<number, Obj>();
  (Array.isArray(r.holes) ? r.holes : []).forEach((h, i) => {
    if (!isObj(h)) return;
    const n = readNum(h.number) ?? i + 1;
    if (Number.isInteger(n) && n >= 1 && n <= N && !byNo.has(n)) byNo.set(n, h);
  });
  const pars = Array.from({ length: N }, (_, i) => readNum(byNo.get(i + 1)?.par));
  const si = Array.from({ length: N }, (_, i) => readNum(byNo.get(i + 1)?.strokeIndex));
  const siWRaw = Array.from({ length: N }, (_, i) => readNum(byNo.get(i + 1)?.strokeIndexW));
  const hasW = siWRaw.some((v) => v !== null);

  const name = readText(r.name, 80);
  if (!name) flags['course-name-input'] = 'Course name not read from the photo. Type it in.';
  pars.forEach((p, i) => {
    const id = `par-${i + 1}`;
    if (p === null) flags[id] = NOT_READ;
    else if (!Number.isInteger(p) || p < 3 || p > 5) flags[id] = `Read as ${p}. A par is almost always 3, 4 or 5: check the card.`;
  });
  checkStrokeIndex(si, 'si', flags);
  if (hasW) checkStrokeIndex(siWRaw, 'siw', flags);

  const teesRaw = (Array.isArray(r.tees) ? r.tees : []).filter(isObj).slice(0, 10);
  const tees = teesRaw.map((t, k) => {
    const label = readText(t.name, 30);
    const rating = readNum(t.rating);
    const slope = readNum(t.slope);
    const g = typeof t.gender === 'string' ? t.gender.trim().toUpperCase() : '';
    const yards = Array.from({ length: N }, (_, i) => readNum(Array.isArray(t.yardages) ? t.yardages[i] : null));

    if (!label) flags[`tee-${k}-name`] = 'Tee name not read from the photo.';
    if (g !== 'M' && g !== 'W') flags[`tee-${k}-gender`] = 'The card does not say whether this rating is for men or women: check it.';
    if (rating === null) flags[`tee-${k}-rating`] = NOT_READ;
    else if (rating < 55 || rating > 80) flags[`tee-${k}-rating`] = `Read as ${rating}. A course rating is 55 to 80.`;
    if (slope === null) flags[`tee-${k}-slope`] = NOT_READ;
    else if (!Number.isInteger(slope) || slope < 55 || slope > 155) flags[`tee-${k}-slope`] = `Read as ${slope}. A slope is a whole number from 55 to 155.`;
    yards.forEach((y, i) => {
      const id = `yards-${k}-${i + 1}`;
      if (y === null) flags[id] = NOT_READ;
      else if (!Number.isInteger(y) || y < 40 || y > 750) flags[id] = `Read as ${y}. A hole is 40 to 750 yards.`;
    });

    const sum = (from: number, to: number) => yards.slice(from, to).reduce<number>((a, y) => a + (y ?? 0), 0);
    const complete = (from: number, to: number) => yards.slice(from, to).every((y) => y !== null);
    const totals: [string, string, number, number, number | null][] = [
      ['out', 'Holes 1-9', 0, 9, readNum(t.out)],
      ['in', 'Holes 10-18', 9, 18, readNum(t.in)],
      ['total', 'All 18 holes', 0, 18, readNum(t.total)],
    ];
    for (const [key, what, from, to, printed] of totals) {
      if (printed === null || !complete(from, to)) continue;
      const got = sum(from, to);
      if (got !== printed) {
        flags[`yards-${k}-${key}`] = `${what} add up to ${fmt(got)} yards; the card's ${key === 'total' ? 'total' : key.toUpperCase()} reads ${fmt(printed)}. One hole was misread: check each against the card.`;
      }
    }

    return { id: teeId(), name: label, gender: (g === 'W' ? 'W' : 'M') as 'M' | 'W', rating: rating === null ? '' : Number.isInteger(rating) ? rating.toFixed(1) : String(rating), slope: str(slope),
      yards: yards.map(str) };
  });
  if (!tees.length) {
    flags['add-tee'] = 'No tee read from the photo. Add one with its rating and slope.';
    tees.push({ id: teeId(), name: '', gender: 'M', rating: '', slope: '', yards: Array.from({ length: N }, () => '') });
  }

  const form: CourseForm = {
    name, city: readText(r.city, 60), state: readText(r.state, 40),
    pars: pars.map(str), si: si.map(str), tees, verified: false,
  };
  if (hasW) form.siW = siWRaw.map(str);
  return { found, form, flags };
}

/** One plain line for each way the scan can fail; the hand editor opens below it. */
export function scanFailureLine(code: string | undefined): string {
  switch (code) {
    case 'unavailable': return 'Scanning needs Claude, which is not available here. Copy the numbers from the card instead.';
    case 'images_unavailable': return 'This view cannot send photos to Claude. Copy the numbers from the card instead.';
    case 'not_granted': return 'Claude was not allowed to read the photo. Copy the numbers from the card instead.';
    case 'sampling_disabled': case 'not_declared': case 'capability_disabled': case 'capability_removed':
      return 'Claude is not available for this account here. Copy the numbers from the card instead.';
    case 'rate_limited': return 'Claude is busy or your usage limit is reached. Copy the numbers from the card, or scan again later.';
    case 'session_expired': return 'Your Claude sign-in expired. Sign in again to scan, or copy the numbers from the card.';
    case 'image_rejected': return 'Claude could not open that photo. Copy the numbers from the card, or scan again with a new photo.';
    case 'not_found': return 'No scorecard was found in the photo. Copy the numbers from the card, or scan again closer and flat.';
    case 'invalid_json': case 'empty_completion': case 'refused':
      return 'Claude could not read the card. Copy the numbers from the card, or scan again with a sharper photo.';
    default: return 'The scan did not finish. Copy the numbers from the card, or scan again.';
  }
}

/** Sends the photos and parses the answer. Rejects with `{ code }` (a sample error code, or `not_found`). */
export async function readScorecard(sample: SampleFn, photos: Blob[], opts: { signal?: AbortSignal; onText?: () => void } = {}): Promise<ScanResult> {
  // Only members that are set: the runtime rejects a `signal` or `onText` that is present but undefined.
  const options: { images: Blob[]; signal?: AbortSignal; onText?: () => void } = { images: photos };
  if (opts.signal) options.signal = opts.signal;
  if (opts.onText) { const cb = opts.onText; options.onText = () => cb(); }
  const raw = await sample.json(scorecardPrompt(photos.length), options);
  const result = parseScorecard(raw);
  if (!result.found) throw { code: 'not_found' };
  return result;
}

// Course editor: add or edit a course by hand. T3.2's scorecard scan opens this same editor with a draft.
import { useState } from 'preact/hooks';
import type { Course, Gender, Hole, Tee } from '../../core/types';
import { newId } from '../round';

interface TeeForm { id: string; name: string; gender: Gender; rating: string; slope: string; yards: string[] }
export interface CourseForm {
  name: string; city: string; state: string;
  pars: string[]; si: string[];
  tees: TeeForm[];
  verified: boolean;
}

const N = 18;
const blank = () => Array.from({ length: N }, () => '');

export function formFromCourse(c?: Course): CourseForm {
  if (!c) {
    return { name: '', city: '', state: '', pars: blank(), si: blank(), verified: false,
      tees: [{ id: newId('t'), name: '', gender: 'M', rating: '', slope: '', yards: blank() }] };
  }
  const byNo = (n: number) => c.holes.find((h) => h.number === n);
  return {
    name: c.name, city: c.city ?? '', state: c.state ?? '', verified: c.verified,
    pars: Array.from({ length: N }, (_, i) => String(byNo(i + 1)?.par ?? '')),
    si: Array.from({ length: N }, (_, i) => String(byNo(i + 1)?.strokeIndex ?? '')),
    tees: c.tees.map((t) => ({ id: t.id, name: t.name, gender: t.gender, rating: String(t.rating), slope: String(t.slope),
      yards: Array.from({ length: N }, (_, i) => (t.yardages[i] ? String(t.yardages[i]) : '')) })),
  };
}

function num(s: string): number { return s.trim() === '' ? NaN : Number(s.trim().replace(',', '.')); }

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'course';
}

/** Checks a form. `errors` is keyed by the control id that needs fixing; `course` is set when there are none. */
export function validateCourseForm(f: CourseForm, original?: Course): { errors: Record<string, string>; course?: Course } {
  const errors: Record<string, string> = {};
  if (!f.name.trim()) errors['course-name-input'] = 'Give the course a name.';
  f.pars.forEach((p, i) => {
    const v = num(p);
    if (!Number.isInteger(v) || v < 3 || v > 6) errors[`par-${i + 1}`] = `Hole ${i + 1}: par must be 3 to 6.`;
  });
  const si = f.si.map(num);
  const seen = new Map<number, number>();
  si.forEach((v) => seen.set(v, (seen.get(v) ?? 0) + 1));
  si.forEach((v, i) => {
    if (!Number.isInteger(v) || v < 1 || v > N) errors[`si-${i + 1}`] = `Hole ${i + 1}: stroke index must be 1 to 18.`;
    else if ((seen.get(v) ?? 0) > 1) errors[`si-${i + 1}`] = `Stroke index ${v} is used more than once.`;
  });
  if (!f.tees.length) errors['add-tee'] = 'Add at least one tee.';
  f.tees.forEach((t, k) => {
    const label = t.name.trim() || `Tee ${k + 1}`;
    if (!t.name.trim()) errors[`tee-${k}-name`] = `Tee ${k + 1}: give it a name.`;
    const r = num(t.rating);
    if (!(r >= 55 && r <= 80)) errors[`tee-${k}-rating`] = `${label}: course rating must be 55 to 80.`;
    const s = num(t.slope);
    if (!Number.isInteger(s) || s < 55 || s > 155) errors[`tee-${k}-slope`] = `${label}: slope must be a whole number from 55 to 155.`;
    t.yards.forEach((y, i) => {
      if (y.trim() === '') return;
      const v = num(y);
      if (!Number.isInteger(v) || v < 40 || v > 750) errors[`yards-${k}-${i + 1}`] = `${label}, hole ${i + 1}: yards must be 40 to 750.`;
    });
  });
  if (Object.keys(errors).length) return { errors };

  const holes: Hole[] = f.pars.map((p, i) => {
    const prev = original?.holes.find((h) => h.number === i + 1);
    const h: Hole = { number: i + 1, par: num(p), strokeIndex: si[i] };
    if (prev?.strokeIndexW !== undefined) h.strokeIndexW = prev.strokeIndexW;
    return h;
  });
  const par = holes.reduce((a, h) => a + h.par, 0);
  const tees: Tee[] = f.tees.map((t) => {
    const prev = original?.tees.find((x) => x.id === t.id);
    const tee: Tee = { id: t.id, name: t.name.trim(), gender: t.gender, rating: num(t.rating), slope: num(t.slope), par,
      yardages: t.yards.map((y) => (y.trim() === '' ? 0 : num(y))) };
    // Nine-hole ratings only stay while the 18-hole rating and slope they belong with are unchanged.
    if (prev && prev.rating === tee.rating && prev.slope === tee.slope) {
      for (const k of ['frontRating', 'frontSlope', 'backRating', 'backSlope'] as const) if (prev[k] !== undefined) tee[k] = prev[k];
    }
    return tee;
  });
  const course: Course = {
    id: original?.id ?? `${slug(f.name)}-${Math.random().toString(36).slice(2, 7)}`,
    name: f.name.trim(), holes, tees, verified: f.verified, updatedAt: '',
  };
  if (f.city.trim()) course.city = f.city.trim();
  if (f.state.trim()) course.state = f.state.trim();
  if (original?.sources) course.sources = original.sources;
  return { errors: {}, course };
}

export function CourseEditor({ course, draft, onCancel, onSaved }: {
  course?: Course; draft?: CourseForm; onCancel: () => void; onSaved: (c: Course) => void;
}) {
  const [f, setF] = useState<CourseForm>(() => draft ?? formFromCourse(course));
  const [teeTab, setTeeTab] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (change: Partial<CourseForm>) => setF({ ...f, ...change });
  const setTee = (k: number, change: Partial<TeeForm>) => set({ tees: f.tees.map((t, i) => (i === k ? { ...t, ...change } : t)) });
  const setAt = (arr: string[], i: number, v: string) => arr.map((x, j) => (j === i ? v : x));
  const bad = (id: string) => (errors[id] ? true : undefined);
  const val = (e: Event) => (e.target as HTMLInputElement).value;
  const tab = Math.min(teeTab, Math.max(0, f.tees.length - 1));
  const tee = f.tees[tab];
  const parTotal = f.pars.reduce((a, p) => a + (num(p) || 0), 0);

  const save = () => {
    const r = validateCourseForm(f, course);
    setErrors(r.errors);
    if (r.course) onSaved(r.course);
    else document.getElementById('main')?.scrollTo({ top: 0 });
  };

  return (
    <div id="course-editor">
      <h1 class="h1">{course ? 'Edit course' : 'Add a course'}</h1>
      <p class="lede">Copy the numbers from the scorecard. Posted rounds keep the numbers they were played with.</p>
      {Object.keys(errors).length > 0 && (
        <div class="note" id="editor-errors" role="alert">
          {Object.values(errors).slice(0, 4).map((m) => <div>{m}</div>)}
          {Object.keys(errors).length > 4 && <div>and {Object.keys(errors).length - 4} more marked in red.</div>}
        </div>
      )}
      <div class="stack" style="margin-top:12px">
        <label class="field"><span>Course name</span>
          <input class="input" id="course-name-input" value={f.name} aria-invalid={bad('course-name-input')}
            onInput={(e) => set({ name: val(e) })} /></label>
        <div class="pair">
          <label class="field"><span>City</span>
            <input class="input" id="course-city" value={f.city} onInput={(e) => set({ city: val(e) })} /></label>
          <label class="field"><span>State</span>
            <input class="input" id="course-state" value={f.state} onInput={(e) => set({ state: val(e) })} /></label>
        </div>
      </div>

      <h2 class="h2">Tees</h2>
      <div class="stack">
        {f.tees.map((t, k) => (
          <div class="tee-card">
            <div class="tee-grid">
              <label class="field"><span>Name</span>
                <input class="input" id={`tee-${k}-name`} value={t.name} placeholder="White" aria-invalid={bad(`tee-${k}-name`)}
                  onInput={(e) => setTee(k, { name: val(e) })} /></label>
              <label class="field"><span>For</span>
                <select class="select" id={`tee-${k}-gender`} value={t.gender}
                  onChange={(e) => setTee(k, { gender: val(e) as Gender })}>
                  <option value="M">Men</option><option value="W">Women</option>
                </select></label>
              <label class="field"><span>Rating</span>
                <input class="input num" id={`tee-${k}-rating`} inputMode="decimal" value={t.rating} placeholder="70.1"
                  aria-invalid={bad(`tee-${k}-rating`)} onInput={(e) => setTee(k, { rating: val(e) })} /></label>
              <label class="field"><span>Slope</span>
                <input class="input num" id={`tee-${k}-slope`} inputMode="numeric" value={t.slope} placeholder="128"
                  aria-invalid={bad(`tee-${k}-slope`)} onInput={(e) => setTee(k, { slope: val(e) })} /></label>
            </div>
            {f.tees.length > 1 && (
              <button class="btn-text danger" id={`tee-${k}-remove`}
                onClick={() => { set({ tees: f.tees.filter((_, i) => i !== k) }); setTeeTab(0); }}>Remove this tee</button>
            )}
          </div>
        ))}
        <button class="btn btn-line btn-block" id="add-tee"
          onClick={() => { set({ tees: [...f.tees, { id: newId('t'), name: '', gender: 'M', rating: '', slope: '', yards: blank() }] }); setTeeTab(f.tees.length); }}>
          Add a tee</button>
      </div>

      <h2 class="h2">Holes · par {parTotal || '–'}</h2>
      {f.tees.length > 1 && (
        <div class="seg" role="group" aria-label="Yards for tee" style="margin-bottom:8px">
          {f.tees.map((t, k) => (
            <button class="chip" id={`yards-tee-${k}`} aria-pressed={k === tab} onClick={() => setTeeTab(k)}>{t.name || `Tee ${k + 1}`}</button>
          ))}
        </div>
      )}
      <table class="ed-holes num">
        <thead><tr><th>#</th><th>Par</th><th>SI</th><th>Yards{tee?.name ? ` (${tee.name})` : ''}</th></tr></thead>
        <tbody>
          {f.pars.map((p, i) => (
            <tr>
              <td>{i + 1}</td>
              <td><input class="input" id={`par-${i + 1}`} inputMode="numeric" value={p} aria-label={`Hole ${i + 1} par`}
                aria-invalid={bad(`par-${i + 1}`)} onInput={(e) => set({ pars: setAt(f.pars, i, val(e)) })} /></td>
              <td><input class="input" id={`si-${i + 1}`} inputMode="numeric" value={f.si[i]} aria-label={`Hole ${i + 1} stroke index`}
                aria-invalid={bad(`si-${i + 1}`)} onInput={(e) => set({ si: setAt(f.si, i, val(e)) })} /></td>
              <td>{tee && <input class="input" id={`yards-${tab}-${i + 1}`} inputMode="numeric" value={tee.yards[i]}
                aria-label={`Hole ${i + 1} yards`} aria-invalid={bad(`yards-${tab}-${i + 1}`)}
                onInput={(e) => setTee(tab, { yards: setAt(tee.yards, i, val(e)) })} />}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <label class="check" style="margin-top:12px">
        <input type="checkbox" id="course-verified" checked={f.verified}
          onChange={(e) => set({ verified: (e.target as HTMLInputElement).checked })} />
        These numbers match the scorecard
      </label>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn btn-quiet" id="cancel-edit" onClick={onCancel}>Cancel</button>
        <button class="btn btn-primary" id="save-course" onClick={save}>Save course</button>
      </div>
    </div>
  );
}

// Course editor: add or edit a course by hand. The scorecard scan opens this same editor with a draft and flags.
import { useState } from 'preact/hooks';
import type { Course, Gender, Hole, Tee } from '../../core/types';
import { newId } from '../round';

interface TeeForm { id: string; name: string; gender: Gender; rating: string; slope: string; yards: string[] }
export interface CourseForm {
  name: string; city: string; state: string;
  pars: string[]; si: string[];
  /** Women's stroke index, only when a scanned card printed one; blank throughout means none. */
  siW?: string[];
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
  const siW = f.siW && f.siW.some((v) => v.trim() !== '') ? f.siW.map(num) : null;
  if (siW) {
    const seenW = new Map<number, number>();
    siW.forEach((v) => seenW.set(v, (seenW.get(v) ?? 0) + 1));
    siW.forEach((v, i) => {
      if (!Number.isInteger(v) || v < 1 || v > N) errors[`siw-${i + 1}`] = `Hole ${i + 1}: women's stroke index must be 1 to 18.`;
      else if ((seenW.get(v) ?? 0) > 1) errors[`siw-${i + 1}`] = `Women's stroke index ${v} is used more than once.`;
    });
  }
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
    if (siW) h.strokeIndexW = siW[i];
    else if (prev?.strokeIndexW !== undefined) h.strokeIndexW = prev.strokeIndexW;
    if (prev?.green) h.green = prev.green;                // T5.1: a learned green survives editing the numbers
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

type Msgs = Record<string, string>;

/** Drops tee `k`'s entries and moves later tees' entries down one, so messages stay on the right controls. */
function reindexTees(m: Msgs, k: number): Msgs {
  const out: Msgs = {};
  for (const [id, v] of Object.entries(m)) {
    const x = /^(tee|yards)-(\d+)-(.+)$/.exec(id);
    if (!x) { out[id] = v; continue; }
    const j = Number(x[2]);
    if (j !== k) out[`${x[1]}-${j > k ? j - 1 : j}-${x[3]}`] = v;
  }
  return out;
}

/** Where a control is, for the list at the top of the editor. */
function where(id: string, f: CourseForm): string {
  if (id === 'course-name-input') return 'Course name';
  if (id === 'add-tee') return 'Tees';
  let x = /^(par|si|siw)-(\d+)$/.exec(id);
  if (x) return `Hole ${x[2]} ${x[1] === 'par' ? 'par' : x[1] === 'si' ? 'stroke index' : "women's stroke index"}`;
  x = /^(tee|yards)-(\d+)-(.+)$/.exec(id);
  if (x) {
    const k = Number(x[2]);
    const tee = f.tees[k]?.name.trim() || `Tee ${k + 1}`;
    if (x[1] === 'tee') return `${tee} ${x[3] === 'gender' ? 'men or women' : x[3]}`;
    return /^\d+$/.test(x[3]) ? `${tee} hole ${x[3]} yards` : `${tee} yards`;
  }
  return 'Check';
}

export function CourseEditor({ course, draft, flags: scanFlags, notice, onCancel, onSaved }: {
  course?: Course; draft?: CourseForm;
  /** From a scorecard scan: reasons keyed by control id. Each blocks Save until that control is edited. */
  flags?: Msgs;
  /** One plain line shown above the editor (why a scan did not fill it). */
  notice?: string;
  onCancel: () => void; onSaved: (c: Course) => void;
}) {
  const scanned = !!scanFlags;
  const [f, setF] = useState<CourseForm>(() => draft ?? formFromCourse(course));
  const [teeTab, setTeeTab] = useState(0);
  const [errors, setErrors] = useState<Msgs>({});
  const [flags, setFlags] = useState<Msgs>(() => scanFlags ?? {});
  const [tried, setTried] = useState(false);
  const set = (change: Partial<CourseForm>) => setF({ ...f, ...change });
  const setTee = (k: number, change: Partial<TeeForm>) => set({ tees: f.tees.map((t, i) => (i === k ? { ...t, ...change } : t)) });
  const setAt = (arr: string[], i: number, v: string) => arr.map((x, j) => (j === i ? v : x));
  /** Editing a control clears its message: a scan flag is settled once he has typed the value from the card. */
  const touch = (...ids: string[]) => {
    const drop = (m: Msgs) => (ids.some((id) => id in m) ? Object.fromEntries(Object.entries(m).filter(([k]) => !ids.includes(k))) : m);
    setFlags(drop); setErrors(drop);
  };
  const msg = (id: string): string | undefined => errors[id] ?? flags[id];
  const bad = (id: string) => (msg(id) ? true : undefined);
  const why = (id: string) => (msg(id) ? `${id}-why` : undefined);
  const Why = ({ id, label }: { id: string; label?: string }) =>
    msg(id) ? <p class="why" id={`${id}-why`}>{label ? `${label}: ` : ''}{msg(id)}</p> : null;
  const val = (e: Event) => (e.target as HTMLInputElement).value;
  const tab = Math.min(teeTab, Math.max(0, f.tees.length - 1));
  const tee = f.tees[tab];
  const hasW = !!f.siW;
  const cols = hasW ? 5 : 4;
  const parTotal = f.pars.reduce((a, p) => a + (num(p) || 0), 0);
  const sumOf = (arr: string[], from: number, to: number) => arr.slice(from, to).reduce((a, v) => a + (num(v) || 0), 0);
  const openFlags = Object.keys(flags).length;
  /** A tee's label; names shared by a men's and a women's rating get M / W so the chips can be told apart. */
  const teeLabel = (k: number) => {
    const t = f.tees[k];
    const name = t.name.trim() || `Tee ${k + 1}`;
    return t.name.trim() && f.tees.some((o, j) => j !== k && o.name.trim() === t.name.trim()) ? `${name} ${t.gender}` : name;
  };
  const teeFlags = (k: number) => Object.keys(flags).filter((id) => id.startsWith(`tee-${k}-`) || id.startsWith(`yards-${k}-`)).length;
  const summary = [...new Set([...new Set([...Object.keys(errors), ...(tried ? Object.keys(flags) : [])])]
    .map((id) => errors[id] ?? `${where(id, f)}: ${flags[id]}`))];

  const save = () => {
    const r = validateCourseForm(f, course);
    setErrors(r.errors);
    setTried(true);
    if (r.course && !openFlags) onSaved(r.course);
    else document.getElementById('main')?.scrollTo({ top: 0 });
  };

  const removeTee = (k: number) => {
    set({ tees: f.tees.filter((_, i) => i !== k) });
    setFlags((m) => reindexTees(m, k));
    setErrors((m) => reindexTees(m, k));
    setTeeTab(0);
  };

  const sumRow = (label: string, key: 'out' | 'in' | 'total', from: number, to: number) => {
    const id = tee ? `yards-${tab}-${key}` : '';
    return [
      <tr class="ed-sum">
        <td>{label}</td><td>{sumOf(f.pars, from, to) || '–'}</td><td />{hasW && <td />}
        <td>{tee && <output id={id} data-bad={bad(id)} aria-describedby={why(id)}>{sumOf(tee.yards, from, to).toLocaleString('en-US') || '–'}</output>}</td>
      </tr>,
      tee && msg(id) && <tr class="why-row"><td /><td colSpan={cols - 1}><Why id={id} /></td></tr>,
    ];
  };

  return (
    <div id="course-editor">
      <h1 class="h1">{course ? 'Edit course' : scanned ? 'Scanned course' : 'Add a course'}</h1>
      {notice && <p class="note scan-notice" id="scan-notice" role="status">{notice}</p>}
      {scanned ? (
        <div class="scan-check" id="scan-check">
          <span class="badge warn">Check against the card</span>
          <p>Read from your photo. Compare every number with the card before you save; nothing is saved until you tap Save course.</p>
          <p id="scan-open"><b>{openFlags
            ? `${openFlags} ${openFlags === 1 ? 'value needs' : 'values need'} you: marked in red with the reason. Retype each from the card.`
            : 'Every flagged value has been retyped.'}</b></p>
        </div>
      ) : (
        <p class="lede">Copy the numbers from the scorecard. Posted rounds keep the numbers they were played with.</p>
      )}
      {summary.length > 0 && (
        <div class="note" id="editor-errors" role="alert">
          {summary.slice(0, 4).map((m) => <div>{m}</div>)}
          {summary.length > 4 && <div>and {summary.length - 4} more marked in red.</div>}
        </div>
      )}
      <div class="stack" style="margin-top:12px">
        <label class="field"><span>Course name</span>
          <input class="input" id="course-name-input" value={f.name} aria-invalid={bad('course-name-input')}
            aria-describedby={why('course-name-input')}
            onInput={(e) => { set({ name: val(e) }); touch('course-name-input'); }} />
          <Why id="course-name-input" /></label>
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
                <input class="input" id={`tee-${k}-name`} value={t.name} placeholder={msg(`tee-${k}-name`) ? undefined : 'White'} aria-invalid={bad(`tee-${k}-name`)}
                  aria-describedby={why(`tee-${k}-name`)}
                  onInput={(e) => { setTee(k, { name: val(e) }); touch(`tee-${k}-name`); }} />
                <Why id={`tee-${k}-name`} /></label>
              <label class="field"><span>For</span>
                <select class="select" id={`tee-${k}-gender`} value={t.gender} aria-invalid={bad(`tee-${k}-gender`)}
                  aria-describedby={why(`tee-${k}-gender`)}
                  onChange={(e) => { setTee(k, { gender: val(e) as Gender }); touch(`tee-${k}-gender`); }}>
                  <option value="M">Men</option><option value="W">Women</option>
                </select>
                <Why id={`tee-${k}-gender`} /></label>
              <label class="field"><span>Rating</span>
                <input class="input num" id={`tee-${k}-rating`} inputMode="decimal" value={t.rating} placeholder={msg(`tee-${k}-rating`) ? undefined : '70.1'}
                  aria-invalid={bad(`tee-${k}-rating`)} aria-describedby={why(`tee-${k}-rating`)}
                  onInput={(e) => { setTee(k, { rating: val(e) }); touch(`tee-${k}-rating`); }} />
                <Why id={`tee-${k}-rating`} /></label>
              <label class="field"><span>Slope</span>
                <input class="input num" id={`tee-${k}-slope`} inputMode="numeric" value={t.slope} placeholder={msg(`tee-${k}-slope`) ? undefined : '128'}
                  aria-invalid={bad(`tee-${k}-slope`)} aria-describedby={why(`tee-${k}-slope`)}
                  onInput={(e) => { setTee(k, { slope: val(e) }); touch(`tee-${k}-slope`); }} />
                <Why id={`tee-${k}-slope`} /></label>
            </div>
            {f.tees.length > 1 && (
              <button class="btn-text danger" id={`tee-${k}-remove`} onClick={() => removeTee(k)}>Remove this tee</button>
            )}
          </div>
        ))}
        <Why id="add-tee" />
        <button class="btn btn-line btn-block" id="add-tee"
          onClick={() => { set({ tees: [...f.tees, { id: newId('t'), name: '', gender: 'M', rating: '', slope: '', yards: blank() }] }); setTeeTab(f.tees.length); touch('add-tee'); }}>
          Add a tee</button>
      </div>

      <h2 class="h2">Holes · par {parTotal || '–'}</h2>
      {f.tees.length > 1 && (
        <div class="seg" role="group" aria-label="Yards for tee" style="margin-bottom:8px">
          {f.tees.map((t, k) => (
            <button class="chip" id={`yards-tee-${k}`} aria-pressed={k === tab} onClick={() => setTeeTab(k)}>
              {teeLabel(k)}{teeFlags(k) > 0 && <small class="chip-flag">{teeFlags(k)} to check</small>}</button>
          ))}
        </div>
      )}
      <table class="ed-holes num">
        <thead><tr><th>#</th><th>Par</th><th>SI</th>{hasW && <th>SI W</th>}<th>Yards{tee?.name.trim() ? ` (${teeLabel(tab)})` : ''}</th></tr></thead>
        <tbody>
          {f.pars.map((p, i) => {
            const h = i + 1;
            const rowIds: [string, string][] = [[`par-${h}`, 'Par'], [`si-${h}`, 'SI'], ...(hasW ? [[`siw-${h}`, 'SI W'] as [string, string]] : []),
              ...(tee ? [[`yards-${tab}-${h}`, 'Yards'] as [string, string]] : [])];
            const rowMsgs = rowIds.filter(([id]) => msg(id));
            return [
              <tr>
                <td>{h}</td>
                <td><input class="input" id={`par-${h}`} inputMode="numeric" value={p} aria-label={`Hole ${h} par`}
                  aria-invalid={bad(`par-${h}`)} aria-describedby={why(`par-${h}`)}
                  onInput={(e) => { set({ pars: setAt(f.pars, i, val(e)) }); touch(`par-${h}`); }} /></td>
                <td><input class="input" id={`si-${h}`} inputMode="numeric" value={f.si[i]} aria-label={`Hole ${h} stroke index`}
                  aria-invalid={bad(`si-${h}`)} aria-describedby={why(`si-${h}`)}
                  onInput={(e) => { set({ si: setAt(f.si, i, val(e)) }); touch(`si-${h}`); }} /></td>
                {hasW && <td><input class="input" id={`siw-${h}`} inputMode="numeric" value={f.siW![i]} aria-label={`Hole ${h} women's stroke index`}
                  aria-invalid={bad(`siw-${h}`)} aria-describedby={why(`siw-${h}`)}
                  onInput={(e) => { set({ siW: setAt(f.siW!, i, val(e)) }); touch(`siw-${h}`); }} /></td>}
                <td>{tee && <input class="input" id={`yards-${tab}-${h}`} inputMode="numeric" value={tee.yards[i]}
                  aria-label={`Hole ${h} yards`} aria-invalid={bad(`yards-${tab}-${h}`)} aria-describedby={why(`yards-${tab}-${h}`)}
                  onInput={(e) => { setTee(tab, { yards: setAt(tee.yards, i, val(e)) });
                    touch(`yards-${tab}-${h}`, `yards-${tab}-${h <= 9 ? 'out' : 'in'}`, `yards-${tab}-total`); }} />}</td>
              </tr>,
              rowMsgs.length > 0 && (
                <tr class="why-row"><td /><td colSpan={cols - 1}>{rowMsgs.map(([id, label]) => <Why id={id} label={label} />)}</td></tr>
              ),
              h === 9 && sumRow('Out', 'out', 0, 9),
              h === 18 && sumRow('In', 'in', 9, 18),
              h === 18 && sumRow('Tot', 'total', 0, 18),
            ];
          })}
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

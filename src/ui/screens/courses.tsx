// Courses tab: list, detail (tees, ratings, hole table, green positions) and the hand editor, opened empty, from a
// scorecard scan or from "Find a course".
import { useRef, useState } from 'preact/hooks';
import type { Course } from '../../core/types';
import { allCourses, findCourse, isBundledCourse } from '../../data/courses';
import { useStore } from '../../store/use-store';
import { Confirm, Icon } from '../components/common';
import { teeYards } from '../round';
import { downscalePhoto } from '../../vision/photo';
import { readScorecard, scanFailureLine, type SampleFn, type ScanResult } from '../../vision/scorecard';
import { CourseEditor, type CourseForm } from './courses-editor';
import { ATTRIBUTION } from '../../net/course-search';
import { CourseGreens, FindCourseSlot, hosted } from './courses-find';

type View = { name: 'list' } | { name: 'detail'; id: string; loadGreens?: boolean }
  | { name: 'edit'; id: string | null; draft?: CourseForm; flags?: Record<string, string>; notice?: string; origin?: 'scan' | 'data' };

export function Courses({ onPlay }: { onPlay: (courseId: string) => void }) {
  const store = useStore();
  const [view, setView] = useState<View>({ name: 'list' });
  const top = () => document.getElementById('main')?.scrollTo({ top: 0 });
  const show = (v: View) => { setView(v); top(); };

  if (view.name === 'edit') {
    const existing = view.id ? findCourse(view.id, store.data.courses) : undefined;
    // A found course with a map location: the Save tap also looks up its greens (around the course, not the phone).
    const greensOnSave = view.origin === 'data' && !!view.draft?.location && hosted();
    return (
      <CourseEditor course={existing} draft={view.draft} flags={view.flags} notice={view.notice} origin={view.origin}
        saveHint={greensOnSave ? "Saving also loads this course's green positions from OpenStreetMap, which gets the course's rough location." : undefined}
        onCancel={() => show(view.id ? { name: 'detail', id: view.id } : { name: 'list' })}
        onSaved={(c) => { store.saveCourse(c); show({ name: 'detail', id: c.id, loadGreens: greensOnSave }); }} />
    );
  }
  if (view.name === 'detail') {
    const course = findCourse(view.id, store.data.courses);
    if (course) {
      return <CourseDetail course={course} loadGreens={view.loadGreens} onBack={() => show({ name: 'list' })} onEdit={() => show({ name: 'edit', id: course.id })}
        onPlay={() => onPlay(course.id)} onRemoved={() => show({ name: 'list' })} />;
    }
  }

  const courses = allCourses(store.data.courses);
  return (
    <div id="courses-screen">
      <h1 class="h1">Courses</h1>
      <p class="lede">Every number here feeds your course handicap and hole maximums.</p>
      <ul class="list" id="course-list">
        {courses.map((c) => (
          <li>
            <button class="li" id={`course-${c.id}`} onClick={() => show({ name: 'detail', id: c.id })}>
              <div class="grow">
                <div class="t">{c.name}</div>
                <div class="s">{[c.city, c.state].filter(Boolean).join(', ') || 'No location'} · {c.tees.length} tee{c.tees.length === 1 ? '' : 's'}</div>
                {!c.verified && <span class="badge warn" style="margin-top:6px">Check against the card</span>}
              </div>
              <span class="chev"><Icon name="chev" /></span>
            </button>
          </li>
        ))}
      </ul>
      <div class="stack" style="margin-top:14px">
        {hosted() && <FindCourseSlot onFound={(d) => show({ name: 'edit', id: null, draft: d.form, flags: d.flags, origin: 'data' })} />}
        <ScanScorecardSlot quiet={hosted()}
          onScanned={(r) => show({ name: 'edit', id: null, draft: r.form, flags: r.flags })}
          onFailed={(notice) => show({ name: 'edit', id: null, notice })} />
        <button class="btn btn-line btn-block" id="add-course" onClick={() => show({ name: 'edit', id: null })}>Add a course by hand</button>
      </div>
    </div>
  );
}

type ClaudeWindow = { claude?: { use?: (name: string) => Promise<unknown> } };
type ScanState =
  | { step: 'idle' } | { step: 'opening' }
  | { step: 'photos'; sample: SampleFn; maxCount: number; maxBytes: number; types: string[]; photos: File[]; problem?: string }
  | { step: 'reading'; writing: boolean };

/**
 * "Scan a scorecard" (plan section 9): one or two photos of the card go to Claude through the `sample` capability;
 * the answer opens in the course editor marked "Check against the card". The photos stay in memory only.
 */
function ScanScorecardSlot({ onScanned, onFailed, quiet }: { onScanned: (r: ScanResult) => void; onFailed: (line: string) => void; quiet?: boolean }) {
  const [st, setSt] = useState<ScanState>({ step: 'idle' });
  const ctl = useRef<AbortController | null>(null);

  const open = async () => {
    setSt({ step: 'opening' });
    let sample: SampleFn | null = null;
    try { sample = (await (globalThis as unknown as ClaudeWindow).claude?.use?.('sample')) as SampleFn | null; } catch { sample = null; }
    if (!sample) { setSt({ step: 'idle' }); onFailed(scanFailureLine('unavailable')); return; }
    const images = (await sample.limits().catch(() => null))?.images;
    if (!images || images.maxCount < 1) { setSt({ step: 'idle' }); onFailed(scanFailureLine('images_unavailable')); return; }
    setSt({ step: 'photos', sample, maxCount: Math.min(images.maxCount, 2), maxBytes: images.maxInputBytes,
      types: images.mediaTypes, photos: [] });
  };

  const add = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    input.value = '';
    if (st.step !== 'photos' || !picked.length) return;
    const photos = [...st.photos, ...picked].slice(0, st.maxCount);
    const dropped = st.photos.length + picked.length - photos.length;
    setSt({ ...st, photos, problem: dropped > 0 ? `Only ${st.maxCount} ${st.maxCount === 1 ? 'photo' : 'photos'} can be read at once.` : undefined });
  };

  const read = async () => {
    if (st.step !== 'photos' || !st.photos.length) return;
    const { sample, maxBytes, types } = st;
    const c = new AbortController();
    ctl.current = c;
    setSt({ step: 'reading', writing: false });
    const blobs = await Promise.all(st.photos.map((p) => downscalePhoto(p, 1600, 0.88)));
    if (blobs.some((b) => b.size > maxBytes || (types.length > 0 && !types.includes(b.type)))) {
      setSt({ step: 'idle' }); onFailed(scanFailureLine('image_rejected')); return;
    }
    try {
      const result = await readScorecard(sample, blobs, { signal: c.signal, onText: () => setSt({ step: 'reading', writing: true }) });
      setSt({ step: 'idle' });
      onScanned(result);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      setSt({ step: 'idle' });
      if (code !== 'cancelled') onFailed(scanFailureLine(code));
    } finally {
      ctl.current = null;
    }
  };

  if (st.step === 'idle' || st.step === 'opening') {
    return (
      <button class={`btn ${quiet ? 'btn-line' : 'btn-primary'} btn-block`} id="scan-card" disabled={st.step === 'opening'} onClick={() => void open()}>
        {st.step === 'opening' ? 'Opening the scanner…' : 'Scan a scorecard'}</button>
    );
  }
  if (st.step === 'reading') {
    return (
      <div class="scan-panel" id="scan-panel" aria-busy="true">
        <p class="scan-status" id="scan-status" role="status">
          {st.writing ? 'Writing down the numbers…' : 'Reading the card. This can take up to a minute.'}</p>
        <button class="btn btn-quiet btn-block" id="scan-stop" onClick={() => ctl.current?.abort()}>Stop</button>
      </div>
    );
  }
  const room = st.maxCount - st.photos.length;
  return (
    <div class="scan-panel" id="scan-panel">
      <h2 class="scan-title">Scan a scorecard</h2>
      <p class="scan-help">Lay the card flat in good light with every row in the frame.
        {st.maxCount > 1 ? ' If the ratings or handicap rows are on the back, add a second photo of the back.' : ''}</p>
      {st.photos.length > 0 && (
        <ul class="scan-photos" id="scan-photos">
          {st.photos.map((p, i) => (
            <li>
              <span>Photo {i + 1} <span class="muted">· {(p.size / 1048576).toFixed(1)} MB</span></span>
              <button class="btn-text danger" id={`scan-photo-remove-${i}`}
                onClick={() => setSt({ ...st, photos: st.photos.filter((_, j) => j !== i), problem: undefined })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {st.problem && <p class="error" id="scan-problem">{st.problem}</p>}
      {room > 0 && (
        <div class="btn-row">
          <label class="btn btn-line scan-pick" for="scan-photo-take">{st.photos.length ? 'Take another' : 'Take a photo'}</label>
          <label class="btn btn-line scan-pick" for="scan-photo-choose">Choose a photo</label>
          <input class="sr" type="file" id="scan-photo-take" accept="image/*" capture="environment" onChange={add} />
          <input class="sr" type="file" id="scan-photo-choose" accept={st.types.join(',') || 'image/*'} multiple={room > 1} onChange={add} />
        </div>
      )}
      <div class="btn-row">
        <button class="btn btn-quiet" id="scan-cancel" onClick={() => setSt({ step: 'idle' })}>Cancel</button>
        <button class="btn btn-primary" id="scan-read" disabled={!st.photos.length} onClick={() => void read()}>Read the card</button>
      </div>
    </div>
  );
}

function CourseDetail({ course, loadGreens, onBack, onEdit, onPlay, onRemoved }: {
  course: Course; loadGreens?: boolean; onBack: () => void; onEdit: () => void; onPlay: () => void; onRemoved: () => void;
}) {
  const store = useStore();
  const [confirm, setConfirm] = useState(false);
  const userCopy = !!store.data.courses[course.id];
  const bundled = isBundledCourse(course.id);
  const tees = [...course.tees].sort((a, b) => teeYards(b) - teeYards(a));
  const nines = [course.holes.filter((h) => h.number <= 9), course.holes.filter((h) => h.number >= 10)];
  const hasW = course.holes.some((h) => h.strokeIndexW !== undefined && h.strokeIndexW !== h.strokeIndex);
  const sumYds = (holes: typeof course.holes, i: number) => holes.reduce((a, h) => a + (tees[i].yardages[h.number - 1] || 0), 0);

  return (
    <div id="course-detail">
      <button class="back" id="courses-back" onClick={onBack}><Icon name="back" size={20} />Courses</button>
      <h1 class="h1" id="course-name">{course.name}</h1>
      <p class="lede">{[course.city, course.state].filter(Boolean).join(', ')}</p>
      {!course.verified && (
        <p class="note" id="course-unverified">Check these numbers against the card. Fix anything that differs with Edit.</p>
      )}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-quiet" id="edit-course" onClick={onEdit}>Edit</button>
        <button class="btn btn-primary" id="play-course" onClick={onPlay}>Play this course</button>
      </div>

      <h2 class="h2">Tees</h2>
      <div class="table-wrap">
        <table class="tbl num" id="tee-table">
          <thead><tr><th>Tee</th><th>Rating</th><th>Slope</th><th>Par</th><th>Yards</th></tr></thead>
          <tbody>
            {tees.map((t) => (
              <tr><td><b>{t.name}</b> <span class="muted">{t.gender === 'W' ? 'W' : 'M'}</span></td>
                <td>{t.rating.toFixed(1)}</td><td>{t.slope}</td><td>{t.par}</td><td>{teeYards(t) || '–'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 class="h2">Holes</h2>
      <div class="table-wrap">
        <table class="tbl num" id="hole-table">
          <thead><tr><th>#</th><th>Par</th><th>SI</th>{hasW && <th>SI W</th>}{tees.map((t) => <th>{t.name}</th>)}</tr></thead>
          <tbody>
            {nines.map((nine, n) => [
              ...nine.map((h, k) => (
                <tr class={k === nine.length - 1 ? 'split' : ''}>
                  <td><b>{h.number}</b></td><td>{h.par}</td><td>{h.strokeIndex}</td>
                  {hasW && <td>{h.strokeIndexW ?? ''}</td>}
                  {tees.map((t) => <td>{t.yardages[h.number - 1] || '–'}</td>)}
                </tr>
              )),
              <tr class="split"><td><b>{n === 0 ? 'OUT' : 'IN'}</b></td><td><b>{nine.reduce((a, h) => a + h.par, 0)}</b></td><td />
                {hasW && <td />}{tees.map((_, i) => <td><b>{sumYds(nine, i) || '–'}</b></td>)}</tr>,
            ])}
          </tbody>
          <tfoot><tr><td>TOT</td><td>{course.holes.reduce((a, h) => a + h.par, 0)}</td><td />{hasW && <td />}
            {tees.map((t) => <td>{teeYards(t) || '–'}</td>)}</tr></tfoot>
        </table>
      </div>

      <CourseGreens course={course} auto={loadGreens} />

      {course.sources && course.sources.length > 0 && (
        <>
          <h2 class="h2">Sources</h2>
          <ul class="sources" id="course-sources">{course.sources.map((s) => <li>{s}</li>)}</ul>
          {course.sources.some((s) => s.startsWith('OpenGolfAPI')) && <p class="find-attr" id="course-attribution">{ATTRIBUTION}</p>}
        </>
      )}

      {userCopy && (
        <div style="margin-top:20px">
          {confirm
            ? <Confirm idBase="remove-course" yes={bundled ? 'Restore' : 'Delete course'}
                text={bundled ? 'Undo your edits and restore the numbers this app shipped with? Posted rounds keep their own copy.'
                  : 'Delete this course? Posted rounds keep their own copy of its numbers.'}
                onNo={() => setConfirm(false)}
                onYes={() => { store.deleteCourse(course.id); if (bundled) setConfirm(false); else onRemoved(); }} />
            : <button class="btn-text danger" id="remove-course" onClick={() => setConfirm(true)}>
                {bundled ? 'Restore the original numbers' : 'Delete this course'}</button>}
        </div>
      )}
    </div>
  );
}

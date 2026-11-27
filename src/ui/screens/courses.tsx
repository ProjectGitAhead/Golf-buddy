// Courses tab: list, detail (tees, ratings, hole table) and the hand editor.
import { useState } from 'preact/hooks';
import type { Course } from '../../core/types';
import { allCourses, findCourse, isBundledCourse } from '../../data/courses';
import { useStore } from '../../store/use-store';
import { Confirm, Icon } from '../components/common';
import { teeYards } from '../round';
import { CourseEditor } from './courses-editor';

type View = { name: 'list' } | { name: 'detail'; id: string } | { name: 'edit'; id: string | null };

export function Courses({ onPlay }: { onPlay: (courseId: string) => void }) {
  const store = useStore();
  const [view, setView] = useState<View>({ name: 'list' });
  const top = () => document.getElementById('main')?.scrollTo({ top: 0 });
  const show = (v: View) => { setView(v); top(); };

  if (view.name === 'edit') {
    const existing = view.id ? findCourse(view.id, store.data.courses) : undefined;
    return (
      <CourseEditor course={existing}
        onCancel={() => show(view.id ? { name: 'detail', id: view.id } : { name: 'list' })}
        onSaved={(c) => { store.saveCourse(c); show({ name: 'detail', id: c.id }); }} />
    );
  }
  if (view.name === 'detail') {
    const course = findCourse(view.id, store.data.courses);
    if (course) {
      return <CourseDetail course={course} onBack={() => show({ name: 'list' })} onEdit={() => show({ name: 'edit', id: course.id })}
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
        <button class="btn btn-line btn-block" id="add-course" onClick={() => show({ name: 'edit', id: null })}>Add a course by hand</button>
        <ScanScorecardSlot onScanned={(draft) => { void draft; }} />
      </div>
    </div>
  );
}

/**
 * T3.2 slot: "Scan a scorecard" (plan section 9) renders here and opens the editor pre-filled with the scanned
 * draft. Until then it renders nothing, so the list shows no control that does nothing.
 */
function ScanScorecardSlot(_props: { onScanned: (draft: Course) => void }) {
  return null;
}

function CourseDetail({ course, onBack, onEdit, onPlay, onRemoved }: {
  course: Course; onBack: () => void; onEdit: () => void; onPlay: () => void; onRemoved: () => void;
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

      {course.sources && course.sources.length > 0 && (
        <>
          <h2 class="h2">Sources</h2>
          <ul class="sources">{course.sources.map((s) => <li>{s}</li>)}</ul>
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

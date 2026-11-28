// "Find a course" and "Load green positions" for the Courses screens (plan section 16.2). Hosted copy only (inside
// Claude, `window.claude` is present and neither shows). Every request starts from a tap.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LatLon } from '../../core/geo';
import { applyGreens, isHandSaved, matchGreens, type FoundGreen } from '../../core/greens';
import type { Course } from '../../core/types';
import { findCourse } from '../../data/courses';
import {
  ATTRIBUTION, distanceText, draftFromCourse, loadCourse, searchByName, searchFailureLine, searchNear,
  type FoundCourse, type FoundDraft,
} from '../../net/course-search';
import { COURSE_RADIUS_M, failureLine, fitCourse, loadGolfFeatures, OSM_COPYRIGHT_URL, OverpassError } from '../../net/overpass';
import { useStore } from '../../store/use-store';
import { Icon } from '../components/common';
import { locationState, onForYardage } from '../location';

/** The hosted copy: not inside Claude, where the page has no network or location. */
export const hosted = () => !(globalThis as { claude?: unknown }).claude;

type Find =
  | { s: 'closed' }
  | { s: 'idle' }
  | { s: 'busy'; line: string }
  | { s: 'results'; courses: FoundCourse[]; near: boolean; capped: string[] }
  | { s: 'none'; line: string }
  | { s: 'failed'; line: string };

/** One position: the live yardage fix when it is on, otherwise one fix from this tap. */
function onePosition(): Promise<LatLon> {
  const now = locationState();
  if (onForYardage() && now.state === 'live') return Promise.resolve({ lat: now.fix.lat, lon: now.fix.lon });
  return new Promise((ok, fail) => {
    const g = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
    if (!g) { fail(1); return; }
    try {
      g.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }), (e) => fail(e.code),
        { enableHighAccuracy: false, timeout: 20_000, maximumAge: 300_000 });
    } catch { fail(1); }
  });
}

/** Courses > "Find a course": by name, or near me. A pick opens the editor pre-filled, with what is missing flagged. */
export function FindCourseSlot({ onFound }: { onFound: (d: FoundDraft) => void }) {
  const [st, setSt] = useState<Find>({ s: 'closed' });
  const [q, setQ] = useState('');
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const start = (line: string) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setSt({ s: 'busy', line });
    return c;
  };
  const done = (c: AbortController) => !c.signal.aborted && ctl.current === c;

  const byName = async (e?: Event) => {
    e?.preventDefault();
    const term = q.trim();
    if (term.length < 2) { setSt({ s: 'failed', line: 'Type at least two letters of the course name.' }); return; }
    const c = start('Searching…');
    try {
      const courses = await searchByName(term, { signal: c.signal });
      if (!done(c)) return;
      setSt(courses.length ? { s: 'results', courses, near: false, capped: [] }
        : { s: 'none', line: `No course in the list matches "${term}". Try part of the name, or add it by hand.` });
    } catch (err) {
      if (done(c)) setSt({ s: 'failed', line: searchFailureLine(err) });
    }
  };

  const nearMe = async () => {
    const c = start('Finding you…');
    let p: LatLon;
    try { p = await onePosition(); } catch (code) {
      if (!done(c)) return;
      setSt({ s: 'failed', line: code === 1
        ? 'Your phone is not letting this page use your location. Search by name instead.'
        : 'No location yet. Step into the open and try again, or search by name.' });
      return;
    }
    if (!done(c)) return;
    setSt({ s: 'busy', line: 'Looking for courses near you…' });
    try {
      const r = await searchNear(p, { signal: c.signal });
      if (!done(c)) return;
      if (!r.states.length) { setSt({ s: 'none', line: 'The course list covers the United States only. Search by name, or add it by hand.' }); return; }
      setSt(r.courses.length ? { s: 'results', courses: r.courses, near: true, capped: r.capped }
        : { s: 'none', line: 'No listed course within 37 miles of you. Search by name, or add it by hand.' });
    } catch (err) {
      if (done(c)) setSt({ s: 'failed', line: searchFailureLine(err) });
    }
  };

  const choose = async (f: FoundCourse) => {
    const c = start(`Getting the scorecard for ${f.name}…`);
    try {
      const d = await loadCourse(f.id, { signal: c.signal });
      if (!done(c)) return;
      setSt({ s: 'closed' });
      onFound(draftFromCourse(d));
    } catch (err) {
      if (done(c)) setSt({ s: 'failed', line: searchFailureLine(err) });
    }
  };

  if (st.s === 'closed') {
    return <button class="btn btn-primary btn-block" id="find-course" onClick={() => setSt({ s: 'idle' })}>Find a course</button>;
  }
  const busy = st.s === 'busy';
  return (
    <div class="scan-panel find-panel" id="find-panel">
      <h2 class="scan-title">Find a course</h2>
      <form class="find-form" onSubmit={(e) => void byName(e)}>
        <label class="field grow"><span>Course name</span>
          <input class="input" id="find-q" type="search" enterKeyHint="search" autoComplete="off" value={q} placeholder="Rancho Solano"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></label>
        <button class="btn btn-primary" id="find-search" type="submit" disabled={busy}>Search</button>
      </form>
      <div class="btn-row">
        <button class="btn btn-line" id="find-near" disabled={busy} onClick={() => void nearMe()}>Near me</button>
        <button class="btn btn-quiet" id="find-close" onClick={() => { ctl.current?.abort(); setSt({ s: 'closed' }); }}>Close</button>
      </div>
      {st.s === 'idle' && (
        <p class="scan-help" id="find-hint">Searches OpenGolfAPI's open list of US courses. Only the name you type is sent;
          near me sends your state, never your position.</p>
      )}
      {busy && <p class="scan-status" id="find-status" role="status" aria-busy="true">{st.line}</p>}
      {st.s === 'failed' && <p class="error" id="find-failed" role="status">{st.line}</p>}
      {st.s === 'none' && <p class="find-none" id="find-none" role="status">{st.line}</p>}
      {st.s === 'results' && (
        <>
          <p class="find-count" id="find-count" role="status">{st.courses.length} {st.courses.length === 1 ? 'course' : 'courses'}
            {st.near ? ' near you' : ''}. Pick yours to check its numbers.</p>
          <ul class="list find-results" id="find-results">
            {st.courses.map((c, i) => (
              <li>
                <button class="li" id={`find-result-${i}`} onClick={() => void choose(c)}>
                  <div class="grow">
                    <div class="t">{c.name}</div>
                    <div class="s">{[[c.city, c.state].filter(Boolean).join(', ') || 'No town listed',
                      c.par ? `par ${c.par}` : '', c.distanceM !== undefined ? distanceText(c.distanceM) : ''].filter(Boolean).join(' · ')}</div>
                  </div>
                  <span class="chev"><Icon name="chev" /></span>
                </button>
              </li>
            ))}
          </ul>
          {st.capped.length > 0 && (
            <p class="scan-help" id="find-capped">Near me looks through the first 500 listed courses in {st.capped.join(' and ')}, so a
              nearby one can be missing. Search by name if yours is not here.</p>
          )}
        </>
      )}
      {(st.s === 'results' || st.s === 'none') && <p class="find-attr" id="find-attribution">{ATTRIBUTION}</p>}
    </div>
  );
}

type Greens =
  | { s: 'idle' }
  | { s: 'loading' }
  | { s: 'failed'; line: string }
  | { s: 'unmapped' }
  | { s: 'done'; found: Map<number, FoundGreen>; total: number; missing: number[]; mine: number[]; trimmed: string };

/**
 * "Green positions" on a course's page: looks up greens, bunkers and water within 2,500 m of the course's own
 * coordinates and stores them on his copy of the course. `auto`: start at once (right after he saved a found course;
 * that Save was the tap). Greens he saved by hand stay unless he taps "Replace mine".
 */
export function CourseGreens({ course, auto }: { course: Course; auto?: boolean }) {
  const store = useStore();
  const [st, setSt] = useState<Greens>({ s: 'idle' });
  const loc = course.location;
  const mapped = course.holes.filter((h) => h.greenShape).length;
  const any = course.holes.filter((h) => h.green).length;

  const save = (found: Map<number, FoundGreen>, replaceMine: boolean): string => {
    const latest = findCourse(course.id, store.data.courses) ?? course;
    const fit = fitCourse(applyGreens(latest, found, replaceMine));
    store.saveCourse(fit.course);
    return fit.trimmed === 'hazards' ? 'Too many bunkers and water areas to store them all: saved the greens only.'
      : fit.trimmed === 'outlines' ? 'Bunker and water outlines were simplified to fit.' : '';
  };

  const go = async () => {
    if (!loc) return;
    setSt({ s: 'loading' });
    let elements: Awaited<ReturnType<typeof loadGolfFeatures>>;
    try {
      elements = await loadGolfFeatures(loc.lat, loc.lon, undefined, COURSE_RADIUS_M);
    } catch (e) {
      setSt({ s: 'failed', line: e instanceof OverpassError ? failureLine(e.attempts) : failureLine([]) });
      return;
    }
    const numbers = course.holes.map((h) => h.number);
    let r: ReturnType<typeof matchGreens>;
    try { r = matchGreens(elements, loc, numbers); } catch {
      setSt({ s: 'failed', line: failureLine([{ url: '', ms: 0, failure: { kind: 'unreadable' } }]) });
      return;
    }
    if (!r.greens.size) { setSt({ s: 'unmapped' }); return; }
    const latest = findCourse(course.id, store.data.courses) ?? course;
    const mine = latest.holes.filter((h) => isHandSaved(h) && r.greens.has(h.number)).map((h) => h.number);
    const trimmed = save(r.greens, false);
    setSt({ s: 'done', found: r.greens, total: numbers.length, missing: r.missing, mine, trimmed });
  };
  const started = useRef(false);
  useEffect(() => { if (auto && loc && hosted() && !started.current) { started.current = true; void go(); } }, []);

  if (!hosted()) return null;
  if (!loc) {
    return (
      <section class="cg" id="course-greens">
        <h2 class="h2">Green positions</h2>
        <p class="yd-small" id="course-greens-noloc">{any} of {course.holes.length} holes have one. This course has no map location, so
          greens load on the course: turn on live yardage on a hole and tap Load green positions there.</p>
      </section>
    );
  }
  const list = (ns: number[]) => `hole${ns.length > 1 ? 's' : ''} ${ns.join(', ')}`;
  return (
    <section class="cg" id="course-greens">
      <h2 class="h2">Green positions</h2>
      {st.s === 'done' ? (
        <div class="yd-found" id="course-greens-found" role="status">
          <p class="yd-found-line" id="course-greens-found-line">Found {st.found.size} of {st.total} greens</p>
          <p class="yd-small yd-ok" id="course-greens-saved">Saved with this course.</p>
          {st.missing.length > 0 && <p class="yd-small" id="course-greens-missing">Missing: {list(st.missing)}. Stand at those pins once and save them.</p>}
          {st.mine.length > 0 && <p class="yd-small" id="course-greens-mine">You saved {list(st.mine)} yourself. Those stay as they are unless you replace them.</p>}
          {st.trimmed && <p class="yd-small" id="course-greens-trimmed">{st.trimmed}</p>}
          {st.mine.length > 0 && (
            <button class="btn btn-line btn-block yd-gap" id="course-greens-replace"
              onClick={() => { const t = save(st.found, true); setSt({ ...st, mine: [], trimmed: t }); }}>Replace mine</button>
          )}
          <p class="yd-small yd-osm">Green positions © <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></p>
        </div>
      ) : (
        <>
          <p class="yd-small" id="course-greens-count">{mapped
            ? `${mapped} of ${course.holes.length} holes have a green from the map.`
            : any ? `${any} of ${course.holes.length} holes have a green you saved.` : 'No green positions yet.'}</p>
          {st.s === 'unmapped' && <p class="yd-line" id="course-greens-unmapped" role="status">This course is not mapped in OpenStreetMap yet. Stand at each pin once and save it.</p>}
          {st.s === 'failed' && <p class="yd-line" id="course-greens-failed" role="status">{st.line}</p>}
          <button class="btn btn-line btn-block yd-gap" id="course-load-greens" disabled={st.s === 'loading'} onClick={() => void go()}>
            {st.s === 'loading' ? 'Loading green positions…' : st.s === 'failed' ? 'Try loading again' : mapped ? 'Load green positions again' : 'Load green positions'}</button>
          {st.s !== 'loading' && <p class="yd-small" id="course-greens-privacy">Loading sends this course's rough location to OpenStreetMap. Nothing else leaves your phone.</p>}
        </>
      )}
    </section>
  );
}

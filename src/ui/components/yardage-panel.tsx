// Live yardage on the hole screen (plan sections 15.2 and 16.1): front / middle / back of the green along the line
// from where he stands to the middle of the green, and up to three bunkers or water in play on that line, from the
// page's one location watcher. Hosted copy only: inside Claude (`window.claude` present) the page cannot use
// location, so nothing renders there. Nothing touches location or the network before a tap; on a later visit it
// resumes by itself only when live yardage was on before and the browser already grants location.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { accuracyYards } from '../../core/geo';
import { applyGreens, isHandSaved, matchGreens, type FoundGreen } from '../../core/greens';
import { hazardLine, holeYards } from '../../core/line-of-play';
import type { Course } from '../../core/types';
import { findCourse } from '../../data/courses';
import { failureLine, loadGolfFeatures, OSM_COPYRIGHT_URL, OverpassError } from '../../net/overpass';
import { useStore } from '../../store/use-store';
import {
  onForYardage, permissionGranted, rememberYardage, turnOff, turnOn, useLocation, yardageRemembered, type Fix,
} from '../location';
import { saveGreenHere } from './distance-sheet';

/** Farther than this from the green: not on this hole, so no number. */
export const NEAR_MAX_YD = 1500;
/** Worse than this: numbers dimmed and the signal called weak; a green can't be saved by hand. */
export const WEAK_ACC_YD = 30;
/** Hazards listed under the numbers, nearest first. */
export const MAX_HAZARDS = 3;

export function YardagePanel({ courseId, hole }: { courseId: string; hole: number }) {
  if ((globalThis as { claude?: unknown }).claude) return null;
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
  return <Live courseId={courseId} hole={hole} />;
}

type Load =
  | { s: 'idle' }
  | { s: 'loading' }
  | { s: 'failed'; line: string }
  | { s: 'unmapped' }
  | { s: 'found'; greens: Map<number, FoundGreen>; missing: number[]; mine: number[]; total: number }
  | { s: 'saved'; count: number };

function Live({ courseId, hole }: { courseId: string; hole: number }) {
  const loc = useLocation();
  const store = useStore();
  const course: Course | undefined = findCourse(courseId, store.data.courses);
  const h = course?.holes.find((x) => x.number === hole);
  const [load, setLoad] = useState<Load>({ s: 'idle' });

  // A later visit: resume without a tap only if it was on before and the browser already allows location.
  useEffect(() => {
    if (onForYardage() || !yardageRemembered()) return;
    let live = true;
    void permissionGranted().then((ok) => { if (ok && live) turnOn({ yardage: true }); });
    return () => { live = false; };
  }, []);
  useEffect(() => { setLoad((l) => (l.s === 'saved' || l.s === 'loading' ? l : { s: 'idle' })); }, [hole]);

  const on = () => { rememberYardage(true); turnOn({ yardage: true }); };
  const off = () => { rememberYardage(false); turnOff(); };

  if (!onForYardage() && loc.state !== 'blocked' && loc.state !== 'nofix') {
    return (
      <section class="yd yd-off" id="yardage" data-state="off" aria-label="Live yardage">
        <button class="btn btn-primary yd-on" id="yardage-on" onClick={on}><PinGlyph />Turn on live yardage</button>
        <p class="yd-hint">Yards to the green from where you stand.</p>
      </section>
    );
  }
  if (loc.state === 'blocked') {
    return (
      <section class="yd" id="yardage" data-state="blocked" aria-label="Live yardage">
        <p class="yd-line" id="yardage-blocked" role="status">Your phone is not letting this page use your location, so live
          yardage can't show. The Distance button's flag photo works without it.</p>
      </section>
    );
  }
  if (loc.state === 'nofix') {
    return (
      <section class="yd" id="yardage" data-state="nofix" aria-label="Live yardage">
        <p class="yd-line" id="yardage-nofix" role="status">{loc.message}</p>
        <button class="btn btn-line btn-block yd-gap" id="yardage-retry" onClick={on}>Try again</button>
      </section>
    );
  }
  if (loc.state !== 'live') {
    return (
      <section class="yd" id="yardage" data-state="waiting" aria-label="Live yardage">
        <p class="yd-wait" role="status">Finding you…</p>
        <Foot onOff={off} />
      </section>
    );
  }

  const fix = loc.fix;
  const acc = accuracyYards(fix.acc);
  const weak = acc > WEAK_ACC_YD;

  if (!course || !h) {
    return (
      <section class="yd" id="yardage" data-state="nocourse" aria-label="Live yardage">
        <p class="yd-line">This round's course is no longer in your list, so there is no green to measure to.</p>
        <Foot onOff={off} acc={acc} />
      </section>
    );
  }

  if (!h.green) {
    const pin = (
      <button class="btn btn-line yd-btn" id="yardage-save-pin" disabled={weak}
        onClick={() => saveGreenHere(store, course, hole, fix)}>I'm at the pin: save this green</button>
    );
    return (
      <section class="yd" id="yardage" data-state="no-green" aria-label="Live yardage">
        <div class="yd-head">
          <p class="yd-title" id="yardage-no-green">No green position for hole {hole}</p>
          <button class="btn-text yd-stop" id="yardage-off" onClick={off}>Turn off</button>
        </div>
        <Loader course={course} fix={fix} load={load} setLoad={setLoad} pin={pin} />
        {weak && <p class="yd-small" id="yardage-weak-save">Location is only good to ± {acc} yd. Wait for a better fix before saving a green.</p>}
      </section>
    );
  }

  const y = holeYards(fix, { green: h.green, greenShape: h.greenShape, hazards: h.hazards });
  const hazards = y.hazards.slice(0, MAX_HAZARDS);
  const fromMap = !!h.greenShape;
  if (y.centre > NEAR_MAX_YD) {
    return (
      <section class="yd" id="yardage" data-state="far" aria-label="Live yardage">
        <p class="yd-title" id="yardage-far">You are not near this hole</p>
        <p class="yd-small">Yardage shows once you are within {NEAR_MAX_YD.toLocaleString('en-US')} yd of the green.</p>
        <Foot onOff={off} acc={acc} osm={fromMap} />
      </section>
    );
  }
  return (
    <section class="yd" id="yardage" data-state="live" data-weak={weak} data-method={y.method} aria-label="Live yardage">
      <div class="yd-nums num">
        {y.front !== undefined ? <Side id="yardage-front" label="Front" v={y.front} /> : <span />}
        <div class="yd-centre">
          <small>{fromMap ? 'Middle' : 'To your pin'}</small>
          <b id="yardage-centre" aria-label={`${y.centre} yards to the ${fromMap ? 'middle of the green' : 'saved pin'}`}>{y.centre}</b>
        </div>
        {y.back !== undefined ? <Side id="yardage-back" label="Back" v={y.back} /> : <span />}
      </div>
      {hazards.length > 0 && (
        <ul class="yd-hz num" id="yardage-hazards" aria-label="Hazards on your line">
          {hazards.map((z, i) => <li key={i} id={`yardage-hazard-${i + 1}`} data-kind={z.kind}>{hazardLine(z)}</li>)}
        </ul>
      )}
      {weak && <p class="yd-weak" id="yardage-weak" role="status">Weak GPS signal</p>}
      <Foot onOff={off} acc={acc} osm={fromMap} />
    </section>
  );
}

function Side({ id, label, v }: { id: string; label: string; v: number }) {
  return <div class="yd-side"><small>{label}</small><b id={id}>{v}</b></div>;
}

function Foot({ onOff, acc, osm }: { onOff: () => void; acc?: number; osm?: boolean }) {
  return (
    <div class="yd-foot">
      <span>
        {acc !== undefined && <span class="num" id="yardage-acc">± {acc} yd</span>}
        {osm && <span class="yd-osm" id="yardage-osm">{acc !== undefined ? ' · ' : ''}Green positions ©{' '}
          <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></span>}
      </span>
      <button class="btn-text yd-stop" id="yardage-off" onClick={onOff}>Turn off</button>
    </div>
  );
}

/** "Load green positions", the confirmation line, and the unmapped / failed lines. */
function Loader({ course, fix, load, setLoad, pin }: { course: Course; fix: Fix; load: Load; setLoad: (l: Load) => void; pin: JSX.Element }) {
  const store = useStore();
  const go = async () => {
    setLoad({ s: 'loading' });
    let elements: Awaited<ReturnType<typeof loadGolfFeatures>>;
    try {
      elements = await loadGolfFeatures(fix.lat, fix.lon);
    } catch (e) {
      setLoad({ s: 'failed', line: e instanceof OverpassError ? failureLine(e.attempts) : failureLine([]) });
      return;
    }
    try {
      const numbers = course.holes.map((x) => x.number);
      const r = matchGreens(elements, fix, numbers);
      if (!r.greens.size) { setLoad({ s: 'unmapped' }); return; }
      const mine = course.holes.filter((x) => isHandSaved(x) && r.greens.has(x.number)).map((x) => x.number);
      setLoad({ s: 'found', greens: r.greens, missing: r.missing, mine, total: numbers.length });
    } catch {
      setLoad({ s: 'failed', line: failureLine([{ url: '', ms: 0, failure: { kind: 'unreadable' } }]) });
    }
  };
  const save = (replaceMine: boolean) => {
    if (load.s !== 'found') return;
    // Read the latest copy of the course: a green may have been saved by hand since the load.
    const latest = findCourse(course.id, store.data.courses) ?? course;
    store.saveCourse(applyGreens(latest, load.greens, replaceMine));
    setLoad({ s: 'saved', count: load.greens.size - (replaceMine ? 0 : load.mine.length) });
  };

  if (load.s === 'found') {
    const list = (ns: number[]) => ns.join(', ');
    return (
      <div class="yd-found" id="yardage-found" role="status">
        <p class="yd-found-line" id="yardage-found-line">Found {load.greens.size} of {load.total} greens</p>
        {load.missing.length > 0 && <p class="yd-small" id="yardage-missing">Missing: hole{load.missing.length > 1 ? 's' : ''} {list(load.missing)}. Stand at those pins once and save them.</p>}
        {load.mine.length > 0 && <p class="yd-small" id="yardage-mine">You saved hole{load.mine.length > 1 ? 's' : ''} {list(load.mine)} yourself. Those stay as they are unless you replace them.</p>}
        <div class="btn-row yd-gap">
          <button class="btn btn-quiet" id="yardage-cancel" onClick={() => setLoad({ s: 'idle' })}>Cancel</button>
          <button class="btn btn-primary" id="yardage-save-greens" onClick={() => save(false)}>Save greens</button>
        </div>
        {load.mine.length > 0 && <button class="btn btn-line btn-block yd-gap" id="yardage-replace-mine" onClick={() => save(true)}>Replace mine</button>}
        <p class="yd-small yd-osm">Green positions © <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></p>
      </div>
    );
  }
  if (load.s === 'unmapped') {
    return (
      <div class="yd-load">
        <p class="yd-line" id="yardage-unmapped" role="status">This course is not mapped in OpenStreetMap yet. Stand at each pin once and save it.</p>
        <div class="yd-two yd-gap">{pin}</div>
      </div>
    );
  }
  return (
    <div class="yd-load">
      <div class="yd-two">
        <button class="btn btn-primary yd-btn" id="yardage-load" disabled={load.s === 'loading'} onClick={() => void go()}>
          {load.s === 'loading' ? 'Loading…' : load.s === 'failed' ? 'Try loading again' : 'Load green positions'}
        </button>
        {pin}
      </div>
      {load.s === 'failed'
        ? <p class="yd-line yd-gap" id="yardage-load-failed" role="status">{load.line}</p>
        : load.s === 'saved'
          ? <p class="yd-small yd-ok" id="yardage-saved" role="status">Saved {load.count} green{load.count === 1 ? '' : 's'}.</p>
          : <p class="yd-small" id="yardage-privacy">Loading sends this course's rough location to OpenStreetMap. Nothing else leaves your phone.</p>}
    </div>
  );
}

function PinGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" />
    </svg>
  );
}

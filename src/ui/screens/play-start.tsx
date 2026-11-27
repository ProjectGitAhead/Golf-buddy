// Start a round: course, tee, length, date. Shows the course handicap and the score to beat today.
import { useMemo, useState } from 'preact/hooks';
import { computeHistory, playedTeeValues, targetScore } from '../../core/handicap';
import type { Round } from '../../core/types';
import { allCourses } from '../../data/courses';
import { useStore } from '../../store/use-store';
import { courseHandicapFor, createRound, formatDate, formatIndex, formatSigned, HOLES_LABEL, postedRounds, teeYards,
  todayISO } from '../round';

/** Accepts "12.4", "+1.2" (a plus handicap, stored as -1.2) or empty. Returns undefined for empty, NaN if invalid. */
export function parseIndex(text: string): number | undefined {
  const t = text.trim().replace(',', '.');
  if (!t) return undefined;
  const plus = t.startsWith('+');
  const n = Number(plus ? t.slice(1) : t);
  if (!Number.isFinite(n) || n < 0 || n > 54 || (plus && n > 10)) return NaN;
  return plus ? -n : n;
}

export function StartRound({ startCourseId, onStarted }: { startCourseId: string | null; onStarted: () => void }) {
  const store = useStore();
  const { rounds, imports, profile, courses: userCourses } = store.data;
  const courses = allCourses(userCourses);
  const hist = useMemo(() => computeHistory(Object.values(rounds), Object.values(imports), profile),
    [rounds, imports, profile]);

  const pick = startCourseId ?? profile?.homeCourseId;
  const [courseId, setCourseId] = useState(courses.find((c) => c.id === pick)?.id ?? courses[0]?.id ?? '');
  const course = courses.find((c) => c.id === courseId) ?? courses[0];
  const gender = profile?.gender ?? 'M';
  const tees = course ? [...course.tees].sort((a, b) => teeYards(b) - teeYards(a)) : [];
  const [teeId, setTeeId] = useState(profile?.defaultTeeId ?? '');
  const tee = tees.find((t) => t.id === teeId) ?? tees.find((t) => t.gender === gender) ?? tees[0];
  const [holes, setHoles] = useState<Round['holesPlayed']>('18');
  const [date, setDate] = useState(todayISO());
  const [indexText, setIndexText] = useState(
    profile?.startingIndex === undefined ? '' : formatIndex(profile.startingIndex));
  const parsed = parseIndex(indexText);
  const indexError = Number.isNaN(parsed);

  const index = hist.displayIndex;
  const ch = course && tee ? courseHandicapFor(index, course, tee, holes) : null;
  const target = useMemo(() => {
    if (!course || !tee) return null;
    const v = playedTeeValues(course.holes, tee, holes);
    return targetScore({ rounds: Object.values(rounds), imported: Object.values(imports), profile,
      rating: v.rating, slope: v.slope, par: v.par, holesPlayed: holes, date });
  }, [course, tee, holes, date, rounds, imports, profile]);
  const last = postedRounds(rounds)[0];
  const lastEntry = last ? hist.entries.find((e) => e.roundIds.includes(last.id)) : undefined;

  const saveStartingIndex = () => {
    if (indexError || parsed === profile?.startingIndex) return;
    store.saveProfile({ gender, ...store.data.profile, startingIndex: parsed, updatedAt: '' });
  };

  const start = () => {
    if (!course || !tee || indexError) return;
    const calculated = hist.indexSource === 'calculated';
    const r = createRound(course, tee, holes, date || todayISO(), calculated ? hist.currentIndex : parsed ?? null);
    store.saveRound(r);
    store.saveProfile({ gender, ...store.data.profile, ...(calculated ? {} : { startingIndex: parsed }),
      homeCourseId: course.id, defaultTeeId: tee.id, updatedAt: '' });
    onStarted();
  };

  if (!course) {
    return <p class="empty">Add a course in the Courses tab to start a round.</p>;
  }

  return (
    <div id="start-round">
      <h1 class="h1">New round</h1>
      <p class="lede">Pick the tee you are playing. Scores save on every tap.</p>
      <div class="stack">
        <label class="field"><span>Course</span>
          <select class="select" id="course-select" value={course.id}
            onChange={(e) => { setCourseId((e.target as HTMLSelectElement).value); setTeeId(''); }}>
            {courses.map((c) => <option value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div class="field"><span id="tee-label">Tee</span>
          <div class="seg wrap" role="group" aria-labelledby="tee-label">
            {tees.map((t) => (
              <button class="chip" id={`tee-${t.id}`} aria-pressed={t.id === tee?.id} onClick={() => setTeeId(t.id)}>
                {t.name}<small class="num">{teeYards(t) ? `${teeYards(t)} yds · ` : ''}{t.rating}/{t.slope}</small>
              </button>
            ))}
          </div>
        </div>
        <div class="field"><span id="holes-label">Holes</span>
          <div class="seg" role="group" aria-labelledby="holes-label">
            {(['18', 'F9', 'B9'] as Round['holesPlayed'][]).map((h) => (
              <button class="chip" id={`holes-${h}`} aria-pressed={holes === h} onClick={() => setHoles(h)}>{HOLES_LABEL[h]}</button>
            ))}
          </div>
        </div>
        <label class="field"><span>Date</span>
          <input class="input num" type="date" id="round-date" value={date} max={todayISO()}
            onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
        </label>

        <div class="card" id="ch-card">
          {ch !== null ? (
            <div class="ch-card">
              <b class="ch-big num" id="course-handicap">{ch}</b>
              <span class="ch-label">Course handicap</span>
              <span class="ch-sub">
                {hist.indexSource === 'starting' ? 'Starting index' : 'Index'} {formatIndex(index)} on the {tee?.name} tee
              </span>
            </div>
          ) : (
            <div>
              <b class="ch-label">No index yet</b>
              <p class="ch-sub" style="margin:4px 0 0">Every hole is capped at par + 5 until you have one. Post 3 rounds
                for a calculated index, or enter the index you already have.</p>
            </div>
          )}
          {hist.indexSource !== 'calculated' && (
            <label class="field" style="margin-top:12px"><span>Your current index (optional)</span>
              <input class="input num" id="starting-index" inputMode="decimal" placeholder="e.g. 14.2"
                value={indexText} aria-invalid={indexError}
                onInput={(e) => setIndexText((e.target as HTMLInputElement).value)} onBlur={saveStartingIndex} />
              {indexError && <p class="error">Enter an index from 0 to 54, or +0.1 to +10 for a plus handicap.</p>}
            </label>
          )}
          {target && (target.lowerIndex !== null || target.countingScore !== null) && (
            <div class="targets" id="targets">
              {target.lowerIndex !== null && <span><b class="num">{target.lowerIndex}</b> or better lowers your index</span>}
              {target.countingScore !== null && (
                <span><b class="num">{target.countingScore}</b> or better counts among your best scores</span>
              )}
              <span class="muted" style="font-size:13px">Adjusted gross, after the hole maximums.</span>
            </div>
          )}
        </div>

        <div class="cta">
          <button class="btn btn-primary btn-block" id="start-round-btn" disabled={!tee || indexError}
            onClick={start}>Start round</button>
        </div>

        {last && (
          <div class="card last-round" id="last-round">
            <div class="grow">
              <div style="font-weight:800">Last round</div>
              <div class="muted" style="font-size:14px">{last.snapshot.courseName} · {formatDate(last.date)}</div>
            </div>
            <div style="text-align:right">
              <b class="num" style="font-size:24px">{last.scores.reduce((a, s) => a + (s.strokes ?? 0), 0)}</b>
              {lastEntry && <div class="muted num" style="font-size:13px">diff {formatSigned(lastEntry.differential)}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

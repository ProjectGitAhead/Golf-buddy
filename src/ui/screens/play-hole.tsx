// One hole per screen: header facts, the stroke stepper, putts, fairway, penalties, sand, and the hole strip.
import { useState } from 'preact/hooks';
import type { ApproachMark, FairwayResult, HoleScore, Round } from '../../core/types';
import { findCourse } from '../../data/courses';
import { useStore } from '../../store/use-store';
import { Icon } from '../components/common';
import { formatToPar, holeFacts, scoreMark, scoreName, totals, type HoleFacts } from '../round';

export function HoleEntry({ round, onFinish }: { round: Round; onFinish: () => void }) {
  const store = useStore();
  const gender = store.data.profile?.gender ?? 'M';
  const course = findCourse(round.courseId, store.data.courses);
  const facts = holeFacts(round, course, gender);
  const firstOpen = facts.findIndex((f) => f.score.strokes === null);
  const [idx, setIdx] = useState(firstOpen === -1 ? facts.length - 1 : firstOpen);
  const f = facts[Math.min(idx, facts.length - 1)];
  const t = totals(facts);
  const last = idx >= facts.length - 1;

  const patch = (change: Partial<HoleScore>) => {
    const has = round.scores.some((s) => s.hole === f.hole.number);
    const scores = has
      ? round.scores.map((s) => (s.hole === f.hole.number ? { ...s, ...change } : s))
      : [...round.scores, { hole: f.hole.number, strokes: null, ...change }];
    store.saveRound({ ...round, scores });
  };
  const go = (i: number) => { setIdx(i); document.getElementById('main')?.scrollTo({ top: 0 }); };

  return (
    <div id="hole-screen" data-hole={f.hole.number}>
      <div class="round-bar">
        <span class="t">{round.snapshot.courseName} · {round.snapshot.teeName}</span>
        <button class="btn-text" id="open-scorecard" onClick={onFinish}>Scorecard</button>
      </div>
      <HoleHeader f={f} hasIndex={round.courseHandicap !== null} si={gender === 'W' ? f.hole.strokeIndexW ?? f.hole.strokeIndex : f.hole.strokeIndex} />
      <Strip facts={facts} current={idx} onPick={go} />
      <div class="running">
        <span id="running-thru">{t.thru ? `Thru ${t.thru}` : 'No holes yet'}</span>
        <span><b class="num" id="running-total">{t.thru ? t.strokes : '–'}</b>
          {' '}<span id="running-topar" class="num">{t.thru ? formatToPar(t.toPar) : ''}</span></span>
      </div>
      <StrokeStepper f={f} hasIndex={round.courseHandicap !== null}
        onSet={(strokes) => patch({ strokes, ...(typeof f.score.putts === 'number' && f.score.putts > strokes ? { putts: strokes } : {}) })} />
      <div class="detail">
        <div>
          <div class="lbl" id="putts-label">Putts</div>
          <div class="seg" role="group" aria-labelledby="putts-label">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <button class="chip num" id={`putts-${n}`} aria-pressed={f.score.putts === n}
                onClick={() => patch({ putts: f.score.putts === n ? undefined : n })}>{n}</button>
            ))}
          </div>
        </div>
        {f.hole.par >= 4 && (
          <div>
            <div class="lbl" id="fairway-label">Tee shot</div>
            <div class="seg" role="group" aria-labelledby="fairway-label">
              {(['left', 'hit', 'right'] as FairwayResult[]).map((v) => (
                <button class="chip" id={`fairway-${v}`} aria-pressed={f.score.fairway === v}
                  onClick={() => patch({ fairway: f.score.fairway === v ? undefined : v })}>
                  {v === 'hit' ? 'Fairway' : v === 'left' ? 'Left' : 'Right'}
                </button>
              ))}
            </div>
          </div>
        )}
        <div class="pair">
          <div>
            <div class="lbl" id="penalties-label">Penalties</div>
            <div class="mini" role="group" aria-labelledby="penalties-label">
              <button id="penalties-minus" aria-label="One penalty fewer" disabled={!f.score.penalties}
                onClick={() => patch({ penalties: Math.max(0, (f.score.penalties ?? 0) - 1) || undefined })}>{'−'}</button>
              <b class="num" id="penalties-value">{f.score.penalties ?? 0}</b>
              <button id="penalties-plus" aria-label="One more penalty"
                onClick={() => patch({ penalties: (f.score.penalties ?? 0) + 1 })}>+</button>
            </div>
          </div>
          <div>
            <div class="lbl">Bunker</div>
            <button class="chip" style="width:100%" id="sand-toggle" aria-pressed={!!f.score.sand}
              onClick={() => patch({ sand: f.score.sand ? undefined : true })}>{f.score.sand ? 'In sand' : 'No sand'}</button>
          </div>
        </div>
        <div class="approach-slot">
          <MarkApproachSlot round={round} hole={f.hole.number} onSave={(approach) => patch({ approach })} />
        </div>
      </div>
      <div class="hole-nav">
        {idx > 0
          ? <button class="btn btn-quiet" id="hole-prev" onClick={() => go(idx - 1)}><Icon name="back" />Prev</button>
          : <span />}
        {last
          ? <button class="btn btn-primary" id="finish-round" onClick={onFinish}>Finish round</button>
          : <button class="btn btn-primary" id="hole-next" onClick={() => go(idx + 1)}>Next hole<Icon name="chev" /></button>}
      </div>
    </div>
  );
}

/**
 * T3.1 slot: the "Mark approach" button and the green sheet (plan section 8) render here and save through
 * `onSave`. Until then it renders nothing, so the hole screen shows no control that does nothing.
 */
function MarkApproachSlot(_props: { round: Round; hole: number; onSave: (mark: ApproachMark) => void }) {
  return null;
}

function HoleHeader({ f, hasIndex, si }: { f: HoleFacts; hasIndex: boolean; si: number }) {
  const r = f.strokesReceived;
  return (
    <div class="hole-head" id="hole-header">
      <div class="hole-no"><small>Hole</small><b class="num" id="hole-number">{f.hole.number}</b></div>
      <div class="facts num">
        <div><small>Par</small><b id="hole-par">{f.hole.par}</b></div>
        <div><small>Yds</small><b id="hole-yards">{f.yards ?? '–'}</b></div>
        <div><small>SI</small><b id="hole-si">{si}</b></div>
        <div class="max"><small>Max</small><b id="hole-max">{f.max}</b></div>
        <div class="received" id="hole-received">
          {r > 0 && Array.from({ length: r }, () => <i />)}
          {r < 0 && Array.from({ length: -r }, () => <i class="back" />)}
          {!hasIndex ? 'No index yet: max is par + 5'
            : r > 0 ? `${r} stroke${r > 1 ? 's' : ''} received`
              : r < 0 ? `Give back ${-r} stroke${r < -1 ? 's' : ''}` : 'No stroke here'}
        </div>
      </div>
    </div>
  );
}

function StrokeStepper({ f, hasIndex, onSet }: { f: HoleFacts; hasIndex: boolean; onSet: (n: number) => void }) {
  const value = f.score.strokes;
  const shown = value ?? f.hole.par;
  const empty = value === null;
  return (
    <div>
      <div class="stepper">
        <button class="step" id="stroke-minus" aria-label="One stroke fewer" disabled={shown <= 1}
          onClick={() => onSet(Math.max(1, shown - 1))}>{'−'}</button>
        <button class="score-val" id="stroke-value" data-empty={empty} data-under={!empty && shown < f.hole.par}
          aria-label={empty ? `Record par, ${f.hole.par}` : `${shown} strokes`} onClick={() => onSet(shown)}>
          <b class="num">{shown}</b>
          <span>{empty ? 'Tap to record par' : scoreName(shown, f.hole.par)}</span>
        </button>
        <button class="step plus" id="stroke-plus" aria-label="One more stroke" disabled={shown >= 20}
          onClick={() => onSet(shown + 1)}>+</button>
      </div>
      {!empty && shown > f.max && (
        <p class="capped" id="stroke-capped">Counts as {f.max} for your handicap ({hasIndex ? 'net double bogey' : 'par + 5'})</p>
      )}
    </div>
  );
}

function Strip({ facts, current, onPick }: { facts: HoleFacts[]; current: number; onPick: (i: number) => void }) {
  const rows = [facts.slice(0, 9), facts.slice(9)].filter((r) => r.length);
  return (
    <div>
      {rows.map((row, r) => (
        <div class="strip" role="group" aria-label={r === 0 && facts[0].hole.number === 1 ? 'Front nine' : 'Back nine'}>
          {row.map((f, j) => {
            const i = r * 9 + j;
            return (
              <button id={`strip-hole-${f.hole.number}`} aria-current={i === current ? 'step' : undefined}
                aria-label={`Hole ${f.hole.number}${f.score.strokes ? `, ${f.score.strokes}` : ''}`} onClick={() => onPick(i)}>
                <small class="num">{f.hole.number}</small>
                <span class={`num mk ${scoreMark(f.score.strokes, f.hole.par)}`}>{f.score.strokes ?? '·'}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

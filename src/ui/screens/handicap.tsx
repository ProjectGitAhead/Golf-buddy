// Handicap tab: the index, low index, trend, every score with the counting ones marked, round and imported-score
// detail (reopen to edit, delete), "Add past score", the starting index, and how it is all calculated.
// Every number comes from `computeHistory`; nothing here recalculates handicap maths.
import { useState } from 'preact/hooks';
import { computeHistory, type HandicapHistory, type HistoryEntry } from '../../core/handicap';
import type { Round } from '../../core/types';
import { findCourse } from '../../data/courses';
import { useStore } from '../../store/use-store';
import { Confirm, Icon, Scorecard } from '../components/common';
import { activeRound, formatDate, formatIndex, formatSigned, HOLES_LABEL, holeFacts, newId, todayISO } from '../round';
import { parseIndex } from './play-start';
import { indexNote } from '../components/index-note';

type View = { name: 'list' } | { name: 'round'; id: string } | { name: 'import'; id: string };

const top = () => document.getElementById('main')?.scrollTo({ top: 0 });
const gross = (r: Round) => r.scores.reduce((a, s) => a + (s.strokes ?? 0), 0);

export function Handicap({ onEditRound }: { onEditRound: () => void }) {
  const store = useStore();
  const { rounds, imports, profile } = store.data;
  const hist = computeHistory(Object.values(rounds), Object.values(imports), profile);
  const [view, setView] = useState<View>({ name: 'list' });
  const show = (v: View) => { setView(v); top(); };

  if (view.name === 'round' && rounds[view.id]?.status === 'posted') {
    return <RoundDetail round={rounds[view.id]} hist={hist} onBack={() => show({ name: 'list' })}
      onOpen={(id) => show({ name: 'round', id })} onEdit={onEditRound} />;
  }
  if (view.name === 'import' && imports[view.id]) {
    return <ImportDetail id={view.id} hist={hist} onBack={() => show({ name: 'list' })} />;
  }

  return (
    <div id="handicap-screen">
      <h1 class="h1">Handicap</h1>
      <IndexCard hist={hist} />
      <ScoreList hist={hist} onOpen={show} />
      <AddPastScore />
      <StartingIndex hist={hist} />
      <HowCalculated />
      <StorageNote />
    </div>
  );
}

/** Where his scores live, true for the view he is in: the Claude artifact with db, or a browser on its own. */
function StorageNote() {
  const store = useStore();
  const text = store.sync !== 'local'
    ? 'Your scores are saved to your Claude account, so they are there wherever you open this page in Claude.'
    : store.localOk
      ? 'Your scores are kept in this browser on this phone only. Clearing the browser\'s data for this site deletes them.'
      : 'This browser is not letting the page save, so your scores last only until you close it.';
  return <p class="hint" id="storage-note" style="margin-top:16px" data-where={store.sync === 'local' ? 'browser' : 'account'}>{text}</p>;
}

// ----- index ----------------------------------------------------------------------------------------------------

function IndexCard({ hist }: { hist: HandicapHistory }) {
  const note = indexNote(hist);
  return (
    <div class="card idx-card" id="index-card">
      <div class="idx-top">
        <div>
          <div class="idx-label" id="handicap-index-label">
            {hist.indexSource === 'starting' ? 'Starting index' : 'Handicap Index'}
          </div>
          <div class="big-index"><b class="num" id="handicap-index">{formatIndex(hist.displayIndex)}</b></div>
        </div>
        {hist.lowIndex !== null && (
          <div class="idx-low"><small>Low index</small><b class="num" id="low-index">{formatIndex(hist.lowIndex)}</b></div>
        )}
      </div>
      <p class="idx-note" id="handicap-index-note">{note}</p>
      {hist.capApplied && (
        <p class="idx-note idx-cap" id="cap-note">
          {hist.capApplied === 'soft'
            ? 'Soft cap applied: the rise of more than 3.0 above your low index is halved.'
            : 'Hard cap applied: your index is held at 5.0 above your low index.'}
        </p>
      )}
      <Sparkline trend={hist.trend} />
      <p class="idx-unofficial" id="unofficial-note">
        Worked out by this app with the World Handicap System rules. It is not an official Handicap Index: only a golf
        club or association can issue one.
      </p>
    </div>
  );
}

function Sparkline({ trend }: { trend: HandicapHistory['trend'] }) {
  if (trend.length < 2) return null;
  const pts = trend.slice(-40);
  const vals = pts.map((p) => p.index);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { const mid = (hi + lo) / 2; lo = mid - 0.5; hi = mid + 0.5; }
  const W = 300, H = 64, pad = 6;
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (pts.length - 1);
  const y = (v: number) => pad + ((hi - v) * (H - 2 * pad)) / (hi - lo);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.index).toFixed(1)}`).join(' ');
  const first = pts[0], last = pts[pts.length - 1];
  return (
    <figure class="spark" id="index-trend">
      <div class="spark-plot">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Index trend: ${formatIndex(first.index)} on ${formatDate(first.date)}, ${formatIndex(last.index)} on ${formatDate(last.date)}`}>
        <polyline points={line} fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"
          stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </svg>
      <span class="spark-dot" style={`left:${((x(pts.length - 1) / W) * 100).toFixed(2)}%;top:${((y(last.index) / H) * 100).toFixed(2)}%`} />
      </div>
      <figcaption class="num">
        <span>{formatIndex(first.index)} · {formatDate(first.date)}</span>
        <span>{formatIndex(last.index)} · {formatDate(last.date)}</span>
      </figcaption>
    </figure>
  );
}

// ----- score list -----------------------------------------------------------------------------------------------

type Row =
  | { t: 'entry'; e: HistoryEntry; inIndex: boolean }
  | { t: 'held'; r: Round; text: string };

function ScoreList({ hist, onOpen }: { hist: HandicapHistory; onOpen: (v: View) => void }) {
  const store = useStore();
  const { rounds, imports } = store.data;
  const n = hist.entries.length;
  const rows: { date: string; row: Row }[] = hist.entries.map((e, i) => ({ date: e.date, row: { t: 'entry', e, inIndex: i >= n - 20 } }));
  // Posted rounds with no score of their own yet: a nine waiting for its partner, or a round that cannot be posted.
  const inEntries = new Set(hist.entries.flatMap((e) => e.roundIds));
  for (const r of Object.values(rounds)) {
    if (r.status !== 'posted' || inEntries.has(r.id)) continue;
    const reason = hist.notPosted.find((x) => x.roundId === r.id)?.reason;
    rows.push({ date: r.date, row: { t: 'held', r, text: hist.waitingNine === r.id ? 'Waiting for another nine' : reason || 'Not used in the index' } });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  // Keep the replay order within one date (newest entry first).
  const order = new Map(hist.entries.map((e, i) => [e.id, i]));
  rows.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1)
    : (b.row.t === 'entry' ? order.get(b.row.e.id) ?? 0 : n) - (a.row.t === 'entry' ? order.get(a.row.e.id) ?? 0 : n)));

  const counting = hist.countingIds.length;
  const firstOld = rows.findIndex((x) => x.row.t === 'entry' && !x.row.inIndex);
  return (
    <section>
      <h2 class="h2">Scores</h2>
      {rows.length === 0 ? (
        <p class="empty" id="scores-empty">Post a round from Play, or add a past score below.</p>
      ) : (
        <>
          <p class="list-intro" id="scores-intro">
            {counting
              ? <>Your 20 most recent scores make the index. The {counting === 1 ? 'one' : counting} marked <span class="counts-chip">Counts</span> {counting === 1 ? 'is' : 'are'} used.</>
              : 'Your 20 most recent scores make the index once you have 3.'}
          </p>
          <ul class="list" id="posted-rounds">
            {rows.map(({ row }, i) => [
              i === firstOld && <li class="list-split" id="older-scores">Older scores, no longer in the index</li>,
              row.t === 'entry' ? <EntryRow e={row.e} rounds={rounds} note={imports[row.e.id]?.note} onOpen={onOpen} />
                : <HeldRow r={row.r} text={row.text} onOpen={onOpen} />,
            ])}
          </ul>
        </>
      )}
    </section>
  );
}

function EntryRow({ e, rounds, note, onOpen }: {
  e: HistoryEntry; rounds: Record<string, Round>; note?: string; onOpen: (v: View) => void;
}) {
  const rs = e.roundIds.map((id) => rounds[id]).filter(Boolean);
  const last = rs[rs.length - 1];
  const title = e.kind === 'imported' ? 'Past score' : e.kind === 'combined-nine' ? 'Two nines combined' : last?.snapshot.courseName ?? 'Round';
  const sub = e.kind === 'imported' ? (note || 'Added by hand')
    : e.kind === 'combined-nine' ? rs.map((r) => `${r.snapshot.courseName} ${HOLES_LABEL[r.holesPlayed].toLowerCase()}`).join(' + ')
      : `${last?.snapshot.teeName ?? ''}${last && last.holesPlayed !== '18' ? ` · ${HOLES_LABEL[last.holesPlayed]}` : ''}`;
  const g = e.kind === 'imported' ? null : rs.reduce((a, r) => a + gross(r), 0);
  const open = () => onOpen(e.kind === 'imported' ? { name: 'import', id: e.id } : { name: 'round', id: last.id });
  return (
    <li data-entry={e.id} data-round={last?.id} data-counting={e.counting ? 'true' : 'false'}>
      <button class="li score-row" id={`score-${e.id.replace('+', '-')}`} onClick={open} disabled={e.kind !== 'imported' && !last}>
        <span class={`count-mark${e.counting ? ' on' : ''}`} aria-hidden="true" />
        <div class="grow">
          <div class="t">{title}</div>
          <div class="s">{formatDate(e.date)}{sub ? ` · ${sub}` : ''}</div>
          {(g !== null || e.totalAdjustment !== 0) && <div class="s num">
            {g !== null && `Gross ${g}${e.ags !== null && e.kind !== 'combined-nine' ? ` · adjusted ${e.ags}` : ''}`}
            {e.totalAdjustment ? `${g !== null ? ' · ' : ''}exceptional ${formatSigned(e.totalAdjustment)}` : ''}
          </div>}
        </div>
        <div class="end">
          <b class="num"><span class="sr">Differential </span>{formatSigned(e.adjustedDifferential)}</b>
          <span class={`badge${e.counting ? ' badge-count' : ''}`}>
            {e.counting ? 'Counts' : e.kind === 'imported' ? 'Imported' : 'Posted'}
          </span>
        </div>
      </button>
    </li>
  );
}

function HeldRow({ r, text, onOpen }: { r: Round; text: string; onOpen: (v: View) => void }) {
  return (
    <li data-round={r.id}>
      <button class="li score-row" id={`score-${r.id}`} onClick={() => onOpen({ name: 'round', id: r.id })}>
        <span class="count-mark" aria-hidden="true" />
        <div class="grow">
          <div class="t">{r.snapshot.courseName}</div>
          <div class="s">{formatDate(r.date)} · {r.snapshot.teeName}{r.holesPlayed !== '18' ? ` · ${HOLES_LABEL[r.holesPlayed]}` : ''}</div>
          <div class="s">{text}</div>
        </div>
        <div class="end"><b class="num">{gross(r)}</b><span class="badge warn">Posted</span></div>
      </button>
    </li>
  );
}

// ----- round detail ---------------------------------------------------------------------------------------------

function RoundDetail({ round, hist, onBack, onOpen, onEdit }: {
  round: Round; hist: HandicapHistory; onBack: () => void; onOpen: (id: string) => void; onEdit: () => void;
}) {
  const store = useStore();
  const { rounds, courses, profile } = store.data;
  const [confirm, setConfirm] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const entry = hist.entries.find((e) => e.roundIds.includes(round.id));
  // Course handicap and AGS from the replay (the stored round.courseHandicap is only for a round in progress).
  const replayed = hist.roundFacts[round.id];
  const ch = replayed?.courseHandicap ?? null;
  const facts = holeFacts(round, findCourse(round.courseId, courses), profile?.gender ?? 'M', ch);
  const partner = entry?.kind === 'combined-nine' ? entry.roundIds.find((id) => id !== round.id) : undefined;
  const partnerRound = partner ? rounds[partner] : undefined;
  const notPosted = hist.notPosted.find((x) => x.roundId === round.id);

  const edit = () => {
    const other = activeRound(rounds);
    if (other && other.id !== round.id) { setBlocked(true); return; }
    store.saveRound({ ...round, status: 'active' });
    onEdit();
  };

  return (
    <div id="round-detail" data-round={round.id}>
      <button class="back" id="detail-back" onClick={onBack}><Icon name="back" size={20} />Handicap</button>
      <h1 class="h1">{round.snapshot.courseName}</h1>
      <p class="lede">{round.snapshot.teeName} · {HOLES_LABEL[round.holesPlayed]} · {formatDate(round.date)}</p>
      <div class="card"><Scorecard facts={facts} /></div>

      <div class="tiles" style="margin-top:12px">
        <div class="tile"><small>Gross</small><b class="num" id="detail-gross">{gross(round)}</b>
          <span class="num">{round.snapshot.rating} / {round.snapshot.slope} · par {round.snapshot.par}</span></div>
        <div class="tile"><small>Adjusted gross</small><b class="num" id="detail-ags">{replayed?.ags ?? '–'}</b>
          <span>{ch === null ? 'Holes capped at par + 5' : `Net double bogey, course handicap ${ch}`}</span></div>
        <div class="tile"><small>Differential</small>
          <b class="num" id="detail-differential">{entry ? formatSigned(entry.differential) : '–'}</b>
          <span>{entry?.totalAdjustment ? `${formatSigned(entry.adjustedDifferential)} after exceptional-score adjustment` : entry ? 'As posted' : 'Not posted yet'}</span></div>
        <div class="tile"><small>Index after</small><b class="num" id="detail-index-after">{formatIndex(entry?.indexAfter ?? null)}</b>
          <span>{entry && entry.indexInEffect !== null ? `${formatIndex(entry.indexInEffect)} before this score` : 'No index before this score'}</span></div>
        {entry && (
          <div class="tile wide" id="detail-counting">
            <small>In your index</small>
            <b class="detail-status">{entry.counting ? 'Counts' : hist.entries.indexOf(entry) >= hist.entries.length - 20 ? 'In your last 20, not counting' : 'Older than your last 20'}</b>
            {entry.nineHoleDifferential !== undefined && entry.expectedNineHole !== undefined && (
              <span class="num" id="detail-nine">
                9-hole differential {formatSigned(entry.nineHoleDifferential)} + expected score for the other nine
                {' '}{formatSigned(entry.expectedNineHole)} (approximation) = {formatSigned(entry.differential)}
              </span>
            )}
            {entry.esrAdjustment !== 0 && (
              <span>Exceptional score: {formatSigned(entry.esrAdjustment)} applied to it and up to 19 scores before it.</span>
            )}
          </div>
        )}
      </div>

      <div class="stack" style="margin-top:14px">
        {entry?.incomplete && <p class="note note-quiet">Holes not entered counted as net par; this score is marked incomplete.</p>}
        {partner && (
          <p class="note note-quiet" id="detail-partner">Combined with your other nine
            {partnerRound ? ` (${partnerRound.snapshot.courseName}, ${formatDate(partnerRound.date)})` : ''} into one 18-hole score.
            {partnerRound && <button class="btn-text" id="open-partner" onClick={() => onOpen(partner)}>Open that nine</button>}
          </p>
        )}
        {hist.waitingNine === round.id && (
          <p class="note note-quiet">With no index yet, this nine is held. It is combined with your next 9-hole round into one 18-hole score, or scored on its own as soon as you have an index.</p>
        )}
        {notPosted && <p class="note" id="detail-not-posted">{notPosted.reason}</p>}
        {blocked && (
          <p class="note" id="edit-blocked">Finish or delete the round in progress on Play first, then edit this one.</p>
        )}
        <button class="btn btn-primary btn-block" id="edit-round" onClick={edit}>Edit scores</button>
        <p class="hint">Opens the round on Play. Post it again when you are done; until then it is left out of your index.</p>
        {confirm
          ? <Confirm idBase="detail-delete" text="Delete this round? Your index is recalculated without it." yes="Delete round"
              onNo={() => setConfirm(false)} onYes={() => { store.deleteRound(round.id); onBack(); }} />
          : <button class="btn-text danger" id="detail-delete" onClick={() => setConfirm(true)}>Delete this round</button>}
      </div>
    </div>
  );
}

function ImportDetail({ id, hist, onBack }: { id: string; hist: HandicapHistory; onBack: () => void }) {
  const store = useStore();
  const imp = store.data.imports[id];
  const entry = hist.entries.find((e) => e.kind === 'imported' && e.id === id);
  const [confirm, setConfirm] = useState(false);
  return (
    <div id="import-detail" data-import={id}>
      <button class="back" id="detail-back" onClick={onBack}><Icon name="back" size={20} />Handicap</button>
      <h1 class="h1">Past score</h1>
      <p class="lede">{formatDate(imp.date)}{imp.note ? ` · ${imp.note}` : ''}</p>
      <div class="tiles">
        <div class="tile"><small>Differential</small><b class="num" id="import-differential">{formatSigned(imp.differential)}</b>
          <span>Entered by hand</span></div>
        <div class="tile"><small>Index after</small><b class="num">{formatIndex(entry?.indexAfter ?? null)}</b>
          <span>{entry?.counting ? 'Counts toward your index' : 'Not one of your counting scores'}</span></div>
      </div>
      <div class="stack" style="margin-top:14px">
        {confirm
          ? <Confirm idBase="import-delete" text="Remove this past score? Your index is recalculated without it." yes="Remove score"
              onNo={() => setConfirm(false)} onYes={() => { store.deleteImport(id); onBack(); }} />
          : <button class="btn btn-line btn-block" id="import-delete" onClick={() => setConfirm(true)}>Remove this score</button>}
      </div>
    </div>
  );
}

// ----- add past score, starting index ---------------------------------------------------------------------------

/** "14.2", "-1.3" or "+1.3" (both meaning below zero, as a plus player's differential is written). */
function parseDifferential(text: string): number | null {
  const t = text.trim().replace(',', '.').replace('−', '-');
  if (!/^[+-]?\d{1,2}(\.\d)?$/.test(t)) return null;
  const n = Number(t.replace('+', '-'));
  return n < -10 || n > 60 ? null : n;
}

function AddPastScore() {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [diff, setDiff] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const parsed = parseDifferential(diff);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= todayISO();
  const save = () => {
    setTried(true);
    if (parsed === null || !dateOk) return;
    store.saveImport({ id: newId('i'), date, differential: parsed, ...(note.trim() ? { note: note.trim() } : {}) });
    setDiff(''); setNote(''); setTried(false); setOpen(false);
  };
  return (
    <section>
      <h2 class="h2">Add past score</h2>
      {!open ? (
        <>
          <p class="list-intro">Scores from before you used this app, as the Score Differential your club or association
            recorded. They count like any other score, by date.</p>
          <button class="btn btn-line btn-block" id="add-past-score" onClick={() => setOpen(true)}>Add past score</button>
        </>
      ) : (
        <div class="card stack" id="past-score-form">
          <label class="field"><span>Date played</span>
            <input class="input num" type="date" id="past-date" value={date} max={todayISO()} aria-invalid={tried && !dateOk}
              onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field"><span>Score Differential</span>
            <input class="input num" id="past-differential" inputMode="decimal" placeholder="e.g. 15.3" value={diff}
              aria-invalid={tried && parsed === null} onInput={(e) => setDiff((e.target as HTMLInputElement).value)} />
            {tried && parsed === null && <p class="error" id="past-differential-error">Enter a differential such as 15.3, or −1.2 for
              one below zero.</p>}
          </label>
          <label class="field"><span>Note (optional)</span>
            <input class="input" id="past-note" maxLength={60} placeholder="Course or event" value={note}
              onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          </label>
          <div class="btn-row">
            <button class="btn btn-quiet" id="past-cancel" onClick={() => { setOpen(false); setTried(false); }}>Cancel</button>
            <button class="btn btn-primary" id="past-save" onClick={save}>Add score</button>
          </div>
        </div>
      )}
    </section>
  );
}

function StartingIndex({ hist }: { hist: HandicapHistory }) {
  const store = useStore();
  const profile = store.data.profile;
  const saved = profile?.startingIndex;
  const [text, setText] = useState(saved === undefined ? '' : formatIndex(saved));
  const [done, setDone] = useState(false);
  const parsed = parseIndex(text);
  const invalid = Number.isNaN(parsed);
  const changed = !invalid && parsed !== saved;
  const save = () => {
    if (!changed) return;
    store.saveProfile({ gender: 'M', ...store.data.profile, startingIndex: parsed, updatedAt: '' });
    setDone(true);
  };
  return (
    <section>
      <h2 class="h2">Starting index</h2>
      <div class="card stack">
        <p class="hint" style="margin:0">
          {hist.indexSource === 'calculated'
            ? 'Your index is now calculated from your scores. The starting index was only used for your first scores, before there were 3.'
            : 'The index you already have. It is shown until you have 3 scores, and it sets the course handicap and hole maximums for the scores before then.'}
        </p>
        <label class="field"><span>Starting index</span>
          <input class="input num" id="profile-starting-index" inputMode="decimal" placeholder="e.g. 14.2" value={text}
            aria-invalid={invalid}
            onInput={(e) => { setText((e.target as HTMLInputElement).value); setDone(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
          {invalid && <p class="error">Enter an index from 0 to 54, or +0.1 to +10 for a plus handicap.</p>}
        </label>
        <div class="row">
          <button class="btn btn-line" id="profile-save" disabled={!changed} onClick={save}>
            {parsed === undefined && saved !== undefined ? 'Clear starting index' : 'Save'}
          </button>
          {done && !changed && <span class="muted" id="profile-saved" role="status">Saved</span>}
        </div>
      </div>
    </section>
  );
}

// ----- how it works ---------------------------------------------------------------------------------------------

function HowCalculated() {
  return (
    <details class="how" id="how-calculated">
      <summary>How this is calculated</summary>
      <div class="how-body">
        <p><b>Adjusted gross score.</b> Each hole counts at most net double bogey: par + 2 + the strokes you receive there.
          Before you have an index the most is par + 5. In an 18-hole round with 10 to 17 holes entered, a hole left
          blank counts as net par and the score is marked incomplete.</p>
        <p><b>Score Differential.</b> (113 ÷ slope) × (adjusted gross − course rating). The playing conditions
          adjustment is not available to this app and is taken as 0.</p>
        <p id="how-nine"><b>Nine-hole rounds.</b> The nine-hole differential is added to an expected score for the
          other nine, worked out as 0.52 × your index + 1.2. That formula is an approximation of the USGA's
          expected-score table, so a nine-hole score here can differ by a few tenths from your association's. Before
          you have an index, two nines are combined into one 18-hole score instead; a nine still waiting when your
          index first exists is scored on its own with that index.</p>
        <p><b>Handicap Index.</b> From your 20 most recent scores, by date: with 20, the average of the best 8. With
          fewer: 3 scores, best 1 minus 2.0; 4, best 1 minus 1.0; 5, best 1; 6, average of the best 2 minus 1.0; 7–8,
          best 2; 9–11, best 3; 12–14, best 4; 15–16, best 5; 17–18, best 6; 19, best 7. Rounded to the tenth; at
          most 54.0.</p>
        <p><b>Exceptional scores.</b> A differential 7.0 to 9.9 below the index you had when you played takes 1.0 off
          that score and up to 19 before it; 10.0 or more below takes 2.0 off. Past scores you add by hand are used as
          entered.</p>
        <p><b>Caps.</b> Once you have 20 scores, your low index is the lowest index of the 365 days before your latest
          score. A rise of more than 3.0 above it is halved (soft cap), and the index never goes more than 5.0 above it
          (hard cap).</p>
        <p><b>Replayed in order.</b> Every score is worked out again in date order with the index you had at the time,
          so editing, deleting or adding an older score updates everything after it.</p>
      </div>
    </details>
  );
}

// Finish: the scorecard, adjusted gross, differential and the index before and after, then "Post round".
import { useState } from 'preact/hooks';
import { adjustedGrossScore, computeHistory } from '../../core/handicap';
import type { Round } from '../../core/types';
import { findCourse } from '../../data/courses';
import { useStore } from '../../store/use-store';
import { Confirm, Scorecard } from '../components/common';
import { formatDate, formatIndex, formatSigned, formatToPar, HOLES_LABEL, holeFacts, totals } from '../round';

export function FinishRound({ round, onBack, onPosted, onDeleted }: {
  round: Round; onBack: () => void; onPosted: (id: string) => void; onDeleted: () => void;
}) {
  const store = useStore();
  const { rounds, imports, profile } = store.data;
  const gender = profile?.gender ?? 'M';
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Everything on this screen comes from the replay of the history with this round posted (one source of truth):
  // the course handicap, hole maximums and adjusted gross the posted score will use.
  const others = Object.values(rounds).filter((r) => r.id !== round.id);
  const before = computeHistory(others, Object.values(imports), profile);
  const after = computeHistory([...others, { ...round, status: 'posted' }], Object.values(imports), profile);
  const ch = after.roundFacts[round.id]?.courseHandicap ?? null;
  const facts = holeFacts(round, findCourse(round.courseId, store.data.courses), gender, ch);
  const t = totals(facts);
  const ags = adjustedGrossScore(round, ch, gender);
  const entry = after.entries.find((e) => e.roundIds.includes(round.id));
  const waiting = after.waitingNine === round.id;
  const notPosted = after.notPosted.find((n) => n.roundId === round.id);
  const canPost = ags.postable && !notPosted;
  const missing = facts.length - t.thru;

  return (
    <div id="finish-screen">
      <h1 class="h1">Scorecard</h1>
      <p class="lede">{round.snapshot.courseName} · {round.snapshot.teeName} · {HOLES_LABEL[round.holesPlayed]} · {formatDate(round.date)}</p>
      <div class="card"><Scorecard facts={facts} /></div>

      <div class="tiles" style="margin-top:12px">
        <div class="tile"><small>Gross</small><b class="num" id="finish-gross">{t.thru ? t.strokes : '–'}</b>
          <span class="num">{t.thru ? `${formatToPar(t.toPar)} · ${t.putts} putts` : 'No holes entered'}</span></div>
        <div class="tile"><small>Adjusted gross</small><b class="num" id="finish-ags">{ags.ags ?? '–'}</b>
          <span>{ch === null ? 'Holes capped at par + 5' : 'Holes capped at net double bogey'}</span></div>
        <div class="tile"><small>Differential</small>
          <b class="num" id="finish-differential">{entry ? formatSigned(entry.differential) : '–'}</b>
          <span class="num">{round.snapshot.rating} / {round.snapshot.slope}</span></div>
        <div class="tile"><small>Course handicap</small><b class="num" id="finish-ch">{ch ?? '–'}</b>
          <span>From your index on {formatDate(round.date)}</span></div>
        <div class="tile wide"><small>{after.indexSource === 'starting' ? 'Starting index' : 'Handicap Index'}</small>
          <b class="num" id="finish-index">{formatIndex(before.displayIndex)}<span class="arrow">{'→'}</span>{formatIndex(after.displayIndex)}</b>
          <span>{after.currentIndex === null
            ? `A calculated index needs 3 scores; this would be number ${after.entries.length}.`
            : 'Before and after posting this round.'}</span>
        </div>
      </div>

      <div class="stack" style="margin-top:14px">
        {missing > 0 && ags.postable && (
          <p class="note" id="finish-missing">{missing} hole{missing > 1 ? 's' : ''} not entered. {missing > 1 ? 'They count' : 'It counts'} as
            net par, and the score is marked incomplete.</p>
        )}
        {!canPost && <p class="note" id="finish-blocked">{notPosted?.reason ?? ags.reason}</p>}
        {waiting && <p class="note note-quiet">With no index yet, this nine is held. It is combined with your next 9-hole round into one 18-hole score, or scored on its own as soon as you have an index.</p>}
        {canPost && (
          <button class="btn btn-primary btn-block" id="post-round"
            onClick={() => { store.saveRound({ ...round, status: 'posted' }); onPosted(round.id); }}>Post round</button>
        )}
        <button class="btn btn-quiet btn-block" id="back-to-holes" onClick={onBack}>Back to the holes</button>
        {confirmDelete
          ? <Confirm idBase="delete-round" text="Delete this round and every score in it?" yes="Delete round"
              onNo={() => setConfirmDelete(false)} onYes={() => { store.deleteRound(round.id); onDeleted(); }} />
          : <button class="btn-text danger" id="delete-round" onClick={() => setConfirmDelete(true)}>Delete this round</button>}
      </div>
    </div>
  );
}

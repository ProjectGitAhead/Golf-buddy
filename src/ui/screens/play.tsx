// Play tab: start a round, enter it hole by hole, finish and post it.
import { useState } from 'preact/hooks';
import { computeHistory } from '../../core/handicap';
import { useStore } from '../../store/use-store';
import { formatDate, formatIndex, formatSigned } from '../round';
import { activeRound } from '../round';
import { FinishRound } from './play-finish';
import { HoleEntry } from './play-hole';
import { StartRound } from './play-start';

export function Play({ startCourseId, onStarted }: { startCourseId: string | null; onStarted: () => void }) {
  const store = useStore();
  const { rounds } = store.data;
  const active = activeRound(rounds);
  const [view, setView] = useState<'hole' | 'finish'>('hole');
  const [postedId, setPostedId] = useState<string | null>(null);

  const posted = postedId ? rounds[postedId] : undefined;
  if (posted && posted.status === 'posted') return <Posted roundId={posted.id} onDone={() => setPostedId(null)} />;

  if (active) {
    return view === 'finish'
      ? <FinishRound key={active.id} round={active} onBack={() => setView('hole')}
          onPosted={(id) => { setPostedId(id); setView('hole'); }} onDeleted={() => setView('hole')} />
      : <HoleEntry key={active.id} round={active} onFinish={() => setView('finish')} />;
  }
  return <StartRound startCourseId={startCourseId} onStarted={() => { setView('hole'); onStarted(); }} />;
}

function Posted({ roundId, onDone }: { roundId: string; onDone: () => void }) {
  const store = useStore();
  const { rounds, imports, profile } = store.data;
  const round = rounds[roundId];
  const hist = computeHistory(Object.values(rounds), Object.values(imports), profile);
  const entry = hist.entries.find((e) => e.roundIds.includes(roundId));
  const gross = round.scores.reduce((a, s) => a + (s.strokes ?? 0), 0);
  const waiting = hist.waitingNine === roundId;
  return (
    <div class="stack" id="posted-view">
      <h1 class="h1">Round posted</h1>
      <p class="lede">{round.snapshot.courseName} · {round.snapshot.teeName} · {formatDate(round.date)}</p>
      <div class="tiles">
        <div class="tile"><small>Gross</small><b class="num">{gross}</b></div>
        <div class="tile"><small>Differential</small>
          <b class="num" id="posted-differential">{entry ? formatSigned(entry.differential) : '–'}</b></div>
        <div class="tile wide"><small>{hist.indexSource === 'starting' ? 'Starting index' : 'Handicap Index'}</small>
          <b class="num" id="posted-index">{formatIndex(hist.displayIndex)}</b>
          {hist.indexSource !== 'calculated' && (
            <span>{hist.entries.length < 3
              ? `A calculated index needs 3 scores; you have ${hist.entries.length}.`
              : 'Calculated from your posted scores.'}</span>
          )}
        </div>
      </div>
      {waiting && <p class="note">With no index yet, this nine is held. It is combined with your next 9-hole round into one 18-hole score, or scored on its own as soon as you have an index.</p>}
      <button class="btn btn-primary btn-block" id="posted-done" onClick={onDone}>Done</button>
    </div>
  );
}

// Handicap tab. T2.1 shows the current index and the posted rounds; T2.2 builds out the full screen
// (low index, trend, counting scores, round detail with reopen / edit / delete, "Add past score", how it works).
import { computeHistory } from '../../core/handicap';
import { useStore } from '../../store/use-store';
import { formatDate, formatIndex, formatSigned, postedRounds } from '../round';

export function Handicap() {
  const store = useStore();
  const { rounds, imports, profile } = store.data;
  const hist = computeHistory(Object.values(rounds), Object.values(imports), profile);
  const posted = postedRounds(rounds);
  const scores = hist.entries.length;
  return (
    <div id="handicap-screen">
      <h1 class="h1">Handicap</h1>
      <div class="card" style="margin-top:12px">
        <div class="h2" style="margin-top:0">{hist.indexSource === 'starting' ? 'Starting index' : 'Handicap Index'}</div>
        <div class="big-index"><b class="num" id="handicap-index">{formatIndex(hist.displayIndex)}</b></div>
        <p class="muted" style="margin:8px 0 0" id="handicap-index-note">
          {hist.indexSource === 'calculated'
            ? `From your ${Math.min(scores, 20)} most recent score${scores === 1 ? '' : 's'}.`
            : `A calculated index needs 3 scores. You have ${scores}.`}
        </p>
      </div>
      <PostedRounds />
      {posted.length === 0 && <p class="empty">Posted rounds will be listed here.</p>}
    </div>
  );
}

/** Posted rounds, newest first, with gross score and differential. Shared by the Handicap and Shots tabs. */
export function PostedRounds({ detail }: { detail?: 'stats' }) {
  const store = useStore();
  const { rounds, imports, profile } = store.data;
  const hist = computeHistory(Object.values(rounds), Object.values(imports), profile);
  const posted = postedRounds(rounds);
  if (!posted.length) return null;
  return (
    <section>
      <h2 class="h2">Posted rounds</h2>
      <ul class="list" id="posted-rounds">
        {posted.map((r) => {
          const e = hist.entries.find((x) => x.roundIds.includes(r.id));
          const gross = r.scores.reduce((a, s) => a + (s.strokes ?? 0), 0);
          const putts = r.scores.reduce((a, s) => a + (s.putts ?? 0), 0);
          const fwHoles = r.snapshot.holes.filter((h) => h.par >= 4).map((h) => h.number);
          const fwTried = r.scores.filter((s) => fwHoles.includes(s.hole) && s.fairway).length;
          const fwHit = r.scores.filter((s) => fwHoles.includes(s.hole) && s.fairway === 'hit').length;
          return (
            <li class="li" data-round={r.id}>
              <div class="grow">
                <div class="t">{r.snapshot.courseName}</div>
                <div class="s">{formatDate(r.date)} · {r.snapshot.teeName}{r.holesPlayed !== '18' ? ` · ${r.holesPlayed === 'F9' ? 'Front' : 'Back'} 9` : ''}</div>
                {detail === 'stats'
                  ? <div class="s num">{putts ? `${putts} putts` : 'Putts not recorded'} · {fwTried ? `fairways ${fwHit}/${fwTried}` : 'fairways not recorded'}</div>
                  : <div class="s num">{e ? `Differential ${formatSigned(e.differential)}${e.counting ? ' · counts' : ''}`
                    : hist.waitingNine === r.id ? 'Waiting for another nine' : 'Not used in the index'}</div>}
              </div>
              <div class="end"><b class="num">{gross}</b><span class="badge">Posted</span></div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

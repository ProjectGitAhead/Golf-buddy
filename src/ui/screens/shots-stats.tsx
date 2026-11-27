// The stats half of the Shots tab: totals across posted rounds, scoring by par, and each round's line.
import { percent, roundStats, summarizeStats, type Ratio } from '../../core/stats';
import { useStore } from '../../store/use-store';
import { formatDate, HOLES_LABEL, postedRounds } from '../round';

const ratio = (r: Ratio) => (r.of ? `${r.hit} of ${r.of}` : 'Not recorded');
const pct = (r: Ratio) => { const p = percent(r); return p === null ? '–' : `${p}%`; };
const toPar = (n: number) => (Math.abs(n) < 0.005 ? 'level par' : n > 0 ? `+${n.toFixed(2)}` : `−${Math.abs(n).toFixed(2)}`);

export function RoundStats() {
  const store = useStore();
  const posted = postedRounds(store.data.rounds);
  if (!posted.length) return null;
  const s = summarizeStats(posted);
  const m = s.fairwayMisses;
  const misses = [m.left && `${m.left} left`, m.right && `${m.right} right`, m.short && `${m.short} short`, m.long && `${m.long} long`]
    .filter(Boolean).join(' · ');
  return (
    <section id="round-stats">
      <h2 class="h2">Round stats</h2>
      <div class="tiles">
        <div class="tile"><small>Fairways hit</small><b class="num" id="stat-fairways">{pct(s.fairways)}</b>
          <span class="num">{ratio(s.fairways)}{misses ? ` · missed ${misses}` : ''}</span></div>
        <div class="tile"><small>Greens in reg.</small><b class="num" id="stat-gir">{pct(s.gir)}</b>
          <span class="num">{s.gir.of ? `${s.gir.hit} of ${s.gir.of} holes with putts` : 'Needs putts entered'}</span></div>
        <div class="tile wide"><small>Putts per round</small>
          <b class="num" id="stat-putts">{s.puttsPer18 === null ? '–' : s.puttsPer18.toFixed(1)}</b>
          <span class="num">{s.puttsPerHole === null ? 'Enter putts on the hole screen to see this.'
            : `Per 18 holes: ${s.puttsPerHole.toFixed(2)} a hole, from ${s.puttHoles} hole${s.puttHoles === 1 ? '' : 's'} with putts`}</span></div>
      </div>

      <h2 class="h2">Scoring by par</h2>
      <div class="par-grid" id="stat-by-par">
        {([3, 4, 5] as const).map((par) => {
          const p = s.byPar[par];
          return (
            <div class="par-cell" data-par={par}>
              <small>Par {par}</small>
              <b class="num" id={`stat-par${par}`}>{p.average === null ? '–' : p.average.toFixed(2)}</b>
              <span class="num">{p.toPar === null ? 'No holes' : toPar(p.toPar)}</span>
              <span class="num">{p.holes} hole{p.holes === 1 ? '' : 's'}</span>
            </div>
          );
        })}
      </div>

      <h2 class="h2">By round</h2>
      <ul class="list" id="stats-rounds">
        {posted.map((r) => {
          const st = roundStats(r);
          return (
            <li class="li" data-round={r.id}>
              <div class="grow">
                <div class="t">{r.snapshot.courseName}</div>
                <div class="s">{formatDate(r.date)}{r.holesPlayed !== '18' ? ` · ${HOLES_LABEL[r.holesPlayed]}` : ''}</div>
                <div class="s num stat-line">
                  <span>FW {st.fairways.of ? `${st.fairways.hit}/${st.fairways.of}` : '–'}</span>
                  <span>GIR {st.gir.of ? `${st.gir.hit}/${st.gir.of}` : '–'}</span>
                  <span>Putts {st.puttHoles ? st.putts : '–'}</span>
                </div>
              </div>
              <div class="end"><b class="num">{st.gross}</b><span class="s">gross</span></div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Shots tab: the round stats (fairways, greens in regulation, putts, scoring by par) from posted rounds; T3.1 adds
// the approach heat map above them.
import { computeHistory } from '../../core/handicap';
import { useStore } from '../../store/use-store';
import { formatIndex, postedRounds } from '../round';
import { RoundStats } from './shots-stats';

export function Shots() {
  const store = useStore();
  const { rounds, imports, profile } = store.data;
  const hist = computeHistory(Object.values(rounds), Object.values(imports), profile);
  const count = postedRounds(rounds).length;
  return (
    <div id="shots-screen">
      <h1 class="h1">Shots</h1>
      <p class="lede">
        {hist.indexSource === 'none' ? 'No index yet' : `Index ${formatIndex(hist.displayIndex)}`} · {count} posted round{count === 1 ? '' : 's'}
      </p>
      <RoundStats />
      {count === 0 && <p class="empty">Fairways, greens and putts from your posted rounds appear here.</p>}
    </div>
  );
}

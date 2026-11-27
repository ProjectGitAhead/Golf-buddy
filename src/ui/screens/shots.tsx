// Shots tab. T2.1 shows the index and each posted round's putts and fairways; T2.2 adds the round stats
// (fairways, greens in regulation, putts, scoring by par) and T3.1 the approach heat map above them.
import { computeHistory } from '../../core/handicap';
import { useStore } from '../../store/use-store';
import { formatIndex, postedRounds } from '../round';
import { PostedRounds } from './handicap';

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
      <PostedRounds detail="stats" />
      {count === 0 && <p class="empty">Putts and fairways from your posted rounds appear here.</p>}
    </div>
  );
}

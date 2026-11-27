// Small shared pieces: icons, sync badge, in-page confirm, scorecard.
import type { ComponentChildren } from 'preact';
import type { SyncState } from '../../store/store';
import { formatToPar, scoreMark, type HoleFacts } from '../round';

type IconName = 'flag' | 'trend' | 'target' | 'map' | 'chev' | 'back';

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2.2, 'stroke-linecap': 'round' as const, 'stroke-linejoin': 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'flag': return <svg {...p}><path d="M6 21V3" /><path d="M6 4h11l-3 4 3 4H6" /></svg>;
    case 'trend': return <svg {...p}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>;
    case 'target': return <svg {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /></svg>;
    case 'map': return <svg {...p}><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></svg>;
    case 'chev': return <svg {...p}><path d="M9 6l6 6-6 6" /></svg>;
    case 'back': return <svg {...p}><path d="M15 6l-6 6 6 6" /></svg>;
  }
}

const SYNC_TEXT: Record<SyncState, string> = {
  local: 'Saved on this phone',
  offline: 'Saved on this phone',
  syncing: 'Saved on this phone',
  synced: 'Synced',
};

export function SyncBadge({ state, localOk }: { state: SyncState; localOk: boolean }) {
  // With neither local storage nor db, say so plainly: the data would not survive a reload.
  const text = !localOk && state !== 'synced' ? 'Not saved: storage is off' : SYNC_TEXT[state];
  return <span class="sync" data-state={state} id="sync-badge" role="status"><i />{text}</span>;
}

/** An in-page confirmation (alert/confirm do nothing inside an artifact). */
export function Confirm({ text, yes, onYes, onNo, idBase }: {
  text: string; yes: string; onYes: () => void; onNo: () => void; idBase: string;
}) {
  return (
    <div class="confirm" role="alertdialog" aria-label={text}>
      <p>{text}</p>
      <div class="btn-row">
        <button class="btn btn-quiet" id={`${idBase}-no`} onClick={onNo}>Keep it</button>
        <button class="btn btn-danger" id={`${idBase}-yes`} onClick={onYes}>{yes}</button>
      </div>
    </div>
  );
}

function Nine({ facts, label, total, grand }: {
  facts: HoleFacts[]; label: 'OUT' | 'IN'; total?: boolean; grand?: HoleFacts[];
}) {
  const sum = (fs: HoleFacts[], f: (x: HoleFacts) => number | undefined | null) =>
    fs.reduce((a, x) => a + (f(x) ?? 0), 0);
  const any = (fs: HoleFacts[], f: (x: HoleFacts) => number | undefined | null) => fs.some((x) => typeof f(x) === 'number');
  const cell = (fs: HoleFacts[], f: (x: HoleFacts) => number | undefined | null) => (any(fs, f) ? sum(fs, f) : '');
  const strokes = (x: HoleFacts) => x.score.strokes;
  const putts = (x: HoleFacts) => x.score.putts;
  const cols = total && grand ? 11 : 10;
  return (
    <table class="sc num">
      <colgroup><col style="width:52px" />{Array.from({ length: cols - 1 }, () => <col />)}</colgroup>
      <thead>
        <tr><th>HOLE</th>{facts.map((f) => <th>{f.hole.number}</th>)}<th class="tot">{label}</th>
          {total && grand && <th class="tot">TOT</th>}</tr>
      </thead>
      <tbody>
        <tr><td>PAR</td>{facts.map((f) => <td>{f.hole.par}</td>)}<td class="tot">{sum(facts, (x) => x.hole.par)}</td>
          {total && grand && <td class="tot">{sum(grand, (x) => x.hole.par)}</td>}</tr>
        <tr class="score"><td>SCORE</td>
          {facts.map((f) => <td><span class={`mk ${scoreMark(f.score.strokes, f.hole.par)}`}>{f.score.strokes ?? '·'}</span></td>)}
          <td class="tot">{cell(facts, strokes)}</td>{total && grand && <td class="tot">{cell(grand, strokes)}</td>}</tr>
        <tr><td>PUTTS</td>{facts.map((f) => <td>{f.score.putts ?? ''}</td>)}<td class="tot">{cell(facts, putts)}</td>
          {total && grand && <td class="tot">{cell(grand, putts)}</td>}</tr>
      </tbody>
    </table>
  );
}

/** The round as a paper scorecard: OUT / IN / TOT, circles for birdies or better, squares for bogeys or worse. */
export function Scorecard({ facts }: { facts: HoleFacts[] }) {
  const front = facts.filter((f) => f.hole.number <= 9);
  const back = facts.filter((f) => f.hole.number >= 10);
  const played = facts.filter((f) => typeof f.score.strokes === 'number');
  const toPar = played.reduce((a, f) => a + (f.score.strokes as number) - f.hole.par, 0);
  return (
    <div>
      {front.length > 0 && <Nine facts={front} label="OUT" total={back.length === 0} grand={facts} />}
      {back.length > 0 && <Nine facts={back} label="IN" total grand={facts} />}
      <div class="legend">
        <span><span class="mk mk-birdie">3</span> birdie</span>
        <span><span class="mk mk-bogey">5</span> bogey</span>
        <span>{played.length ? `${formatToPar(toPar)} through ${played.length}` : 'No holes entered'}</span>
      </div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return <section><h2 class="h2">{title}</h2>{children}</section>;
}

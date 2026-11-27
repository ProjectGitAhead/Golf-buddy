// The sentence under the index: which differentials make it, with their values, and any table adjustment.
// Reads only what computeHistory returned; the counting values are the entries it marked `counting`.
import { differentialsToUse, type HandicapHistory } from '../../core/handicap';

const fmt = (n: number) => (n < 0 ? `−${Math.abs(n).toFixed(1)}` : n.toFixed(1));

function list(values: string[]): string {
  return values.length <= 2 ? values.join(' and ') : `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

export function indexNote(hist: HandicapHistory): string {
  const scores = hist.entries.length;
  const recent = Math.min(scores, 20);
  const rule = differentialsToUse(scores);
  if (hist.indexSource === 'calculated' && rule) {
    const used = hist.entries.filter((e) => e.counting).map((e) => e.adjustedDifferential).sort((a, b) => a - b);
    const adj = rule.adjustment ? `, minus ${Math.abs(rule.adjustment).toFixed(1)} (the adjustment for ${recent} scores)` : '';
    if (used.length === 1) {
      return `Your best differential of your ${recent} scores, ${fmt(used[0])}${adj}.`;
    }
    const of = recent === 20 ? 'your 20 most recent scores' : `your ${recent} scores`;
    return `The average of your best ${used.length} differentials of ${of}: ${list(used.map(fmt))}${adj}.`;
  }
  if (hist.indexSource === 'starting') return `The index you entered, used until you have 3 scores. You have ${scores}.`;
  return `A calculated index needs 3 scores. You have ${scores}.`;
}

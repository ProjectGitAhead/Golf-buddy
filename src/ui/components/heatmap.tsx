// The approach heat map on the Shots screen (plan section 8): every mark on one pin-centred canvas, a
// kernel-density heat layer plus the dots, rings at 10 / 20 / 30 ft, filters, and the summary from 5 marks up.
// Colours come from the theme tokens (read from computed styles), so it redraws for light and dark.
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  SUMMARY_MIN, collectMarks, currentCourseId, densityGrid, summarize, type ApproachFilter, type MarkEntry,
} from '../../core/approach';
import type { Round } from '../../core/types';
import { useStore } from '../../store/use-store';
import { EXT_FT, FRINGE_D, GREEN_D } from './green-sheet';

const FILTERS: { id: ApproachFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'par3', label: 'Par 3s' },
  { id: 'course', label: 'This course' },
  { id: 'last5', label: 'Last 5' },
];
const GRID = 120;
const RINGS = [10, 20, 30];

let lastFilter: ApproachFilter = 'all';   // remembered while the page is open

type RGB = [number, number, number];

/** Parses the colour formats computed styles hand back for custom properties: #rgb, #rrggbb, rgb()/rgba(). */
export function parseColor(v: string, fallback: RGB = [128, 128, 128]): RGB {
  const s = v.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16)) as RGB;
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB;
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return fallback;
}
const css = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;

function draw(canvas: HTMLCanvasElement, entries: MarkEntry[], heat: boolean): void {
  const size = canvas.clientWidth;
  if (!size) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const st = getComputedStyle(canvas);
  const tok = (name: string, fb: RGB) => parseColor(st.getPropertyValue(name), fb);
  const surface = tok('--surface', [255, 255, 255]);
  const turf = tok('--turf', [27, 86, 54]);
  const turfSoft = tok('--turf-soft', [219, 231, 218]);
  const accent = tok('--accent', [185, 64, 15]);
  const ink = tok('--ink', [16, 25, 19]);
  const line = tok('--line-strong', [169, 162, 140]);
  const fringe = tok('--line', [211, 205, 186]);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = css(surface);
  ctx.fillRect(0, 0, size, size);

  // The green, in the same 0..100 units as the sheet's diagram.
  const u = size / 100;
  ctx.save();
  ctx.scale(u, u);
  ctx.fillStyle = css(fringe);
  ctx.fill(new Path2D(FRINGE_D));
  ctx.fillStyle = css(turfSoft);
  ctx.fill(new Path2D(GREEN_D));
  ctx.restore();

  // Density: one coloured pixel per grid cell, scaled up smoothly. Low density is turf, the core is the accent.
  if (heat && entries.length) {
    const g = densityGrid(entries.map((e) => e.mark), GRID, EXT_FT);
    const off = document.createElement('canvas');
    off.width = GRID; off.height = GRID;
    const octx = off.getContext('2d');
    if (octx) {
      const img = octx.createImageData(GRID, GRID);
      for (let i = 0; i < g.values.length; i++) {
        const t = g.values[i];
        if (t < 0.005) continue;
        const c = t < 0.45 ? turf : mix(turf, accent, Math.min(1, (t - 0.45) / 0.45));
        const a = Math.min(0.9, Math.sqrt(t) * 0.95);      // fades to nothing at the edge: no hard rim
        img.data.set([c[0], c[1], c[2], Math.round(a * 255)], i * 4);
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, 0, 0, size, size);
    }
  }

  // Rings and their labels, then the pin.
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = css(line, 0.9);
  for (const r of RINGS) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, (r / EXT_FT) * (size / 2), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = css(ink, 0.6);
  ctx.font = `700 ${Math.max(10, Math.round(size / 34))}px system-ui, -apple-system, sans-serif`;
  for (const r of RINGS) {
    const d = (r / EXT_FT) * (size / 2) * 0.7071;
    ctx.fillText(`${r}`, size / 2 + d + 3, size / 2 - d - 3);
  }
  ctx.fillStyle = css(ink);
  ctx.beginPath(); ctx.arc(size / 2, size / 2, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = css(ink); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(size / 2, size / 2); ctx.lineTo(size / 2, size / 2 - size * 0.095); ctx.stroke();
  ctx.fillStyle = css(accent);
  ctx.beginPath();
  ctx.moveTo(size / 2, size / 2 - size * 0.095);
  ctx.lineTo(size / 2 + size * 0.052, size / 2 - size * 0.076);
  ctx.lineTo(size / 2, size / 2 - size * 0.057);
  ctx.closePath(); ctx.fill();

  // Each mark as a dot; marks beyond the edge sit on it.
  const lim = EXT_FT * 0.96;
  for (const e of entries) {
    const k = Math.max(Math.abs(e.mark.xFt), Math.abs(e.mark.yFt)) > lim ? lim / Math.max(Math.abs(e.mark.xFt), Math.abs(e.mark.yFt)) : 1;
    const x = size / 2 + ((e.mark.xFt * k) / EXT_FT) * (size / 2);
    const y = size / 2 - ((e.mark.yFt * k) / EXT_FT) * (size / 2);
    ctx.beginPath();
    ctx.arc(x, y, heat ? 3.5 : 5, 0, Math.PI * 2);
    ctx.fillStyle = css(heat ? ink : surface);
    ctx.fill();
    ctx.lineWidth = heat ? 1.5 : 2.5;
    ctx.strokeStyle = css(heat ? surface : ink);
    ctx.stroke();
  }
}

function filterLabel(filter: ApproachFilter, n: number, rounds: number, courseName?: string): string {
  const m = `${n} mark${n === 1 ? '' : 's'}`;
  if (filter === 'course') return courseName ? `${m} at ${courseName}` : m;
  if (filter === 'par3') return `${m} on par 3s`;
  if (filter === 'last5') return `${m} from your last ${Math.min(5, rounds)} round${Math.min(5, rounds) === 1 ? '' : 's'}`;
  return `${m} from ${rounds} round${rounds === 1 ? '' : 's'}`;
}

export function ApproachHeatmap() {
  const store = useStore();
  const rounds: Round[] = Object.values(store.data.rounds);
  const [filter, setFilterState] = useState<ApproachFilter>(lastFilter);
  const setFilter = (f: ApproachFilter) => { lastFilter = f; setFilterState(f); };
  const courseId = currentCourseId(rounds);
  const courseName = rounds.find((r) => r.courseId === courseId)?.snapshot.courseName;
  const all = collectMarks(rounds);
  const entries = collectMarks(rounds, filter, courseId);
  const roundCount = new Set(entries.map((e) => e.roundId)).size;
  const heat = entries.length >= SUMMARY_MIN;
  const summary = summarize(entries.map((e) => e.mark));
  const beyond = entries.filter((e) => Math.max(Math.abs(e.mark.xFt), Math.abs(e.mark.yFt)) > EXT_FT * 0.96).length;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const key = entries.map((e) => `${e.mark.xFt},${e.mark.yFt}`).join(';');
  const redraw = useRef<() => void>(() => {});
  redraw.current = () => { if (canvasRef.current) draw(canvasRef.current, entries, heat); };

  useEffect(() => { redraw.current(); }, [key, heat]);
  useEffect(() => {
    const again = () => requestAnimationFrame(() => redraw.current());
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', again);
    const mo = new MutationObserver(again);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
    if (canvasRef.current) ro?.observe(canvasRef.current);
    return () => { mq?.removeEventListener?.('change', again); mo.disconnect(); ro?.disconnect(); };
  }, []);

  const toGo = SUMMARY_MIN - entries.length;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  return (
    <section id="approach-heatmap" class="hm">
      <h2 class="h2">Approach shots</h2>
      <div class="seg hm-filters" role="group" aria-label="Which approaches">
        {FILTERS.map((f) => (
          <button class="chip" id={`heat-filter-${f.id}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      <div class="hm-stage">
        <canvas ref={canvasRef} id="heatmap-canvas" class="hm-canvas" data-marks={entries.length} data-heat={heat}
          role="img" aria-label={`Approach map, pin in the centre, rings at 10, 20 and 30 feet. ${filterLabel(filter, entries.length, roundCount, courseName)}.`} />
        <span class="gs-dir gs-long">Long</span>
        <span class="gs-dir gs-short">Short</span>
        <span class="gs-dir gs-left">Left</span>
        <span class="gs-dir gs-right">Right</span>
      </div>
      <div class="hm-meta">
        <span id="heatmap-count" class="num">{filterLabel(filter, entries.length, roundCount, courseName)}</span>
        {heat && <span class="hm-legend" aria-hidden="true"><small>fewer</small><i /><small>more</small></span>}
      </div>
      {beyond > 0 && <p class="hm-line">{beyond} beyond {EXT_FT} ft {beyond === 1 ? 'sits' : 'sit'} on the edge.</p>}

      {all.length === 0 ? (
        <p class="hm-line" id="heatmap-empty">Mark approaches on the hole screen and they collect here.</p>
      ) : entries.length === 0 ? (
        <p class="hm-line" id="heatmap-empty">No marks match this filter yet.</p>
      ) : toGo > 0 ? (
        <p class="hm-line" id="heatmap-unlock">{toGo} more mark{toGo === 1 ? '' : 's'} {toGo === 1 ? 'unlocks' : 'unlock'} the pattern summary.</p>
      ) : (
        <div class="tiles hm-summary" id="heatmap-summary">
          <div class="tile"><small>From the pin</small><b class="num" id="heatmap-avg">{Math.round(summary.avgDistFt)} ft</b><span>average</span></div>
          <div class="tile"><small>On the green</small><b class="num" id="heatmap-on-green">{pct(summary.onGreenShare)}</b>
            <span>{Math.round(summary.onGreenShare * summary.count)} of {summary.count}</span></div>
          <div class="tile wide"><small>Pattern</small>
            <ul class="hm-lines" id="heatmap-pattern">{summary.lines.map((l) => <li>{l}</li>)}</ul></div>
        </div>
      )}
    </section>
  );
}

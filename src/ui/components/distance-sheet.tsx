// The "Distance" control on the hole screen and its sheet (plan section 12): a flagstick rangefinder that works from
// one photo everywhere, and GPS distance to a learned green plus shot measuring where the browser grants location.
// Nothing here touches the camera or location before a tap. The photo is decoded in memory, never stored or sent,
// and released when the sheet closes.
import { useEffect, useRef, useState } from 'preact/hooks';
import { readExif } from '../../core/exif';
import { accuracyYards, distanceYards } from '../../core/geo';
import { holeYards } from '../../core/line-of-play';
import {
  clampFlagFt, DEFAULT_FLAG_FT, effectiveF35, FLAG_FT_MAX, hasDigitalZoom, FLAG_FT_MIN, LENSES, measure, spanPx, type Point,
} from '../../core/rangefinder';
import type { Course } from '../../core/types';
import { findCourse } from '../../data/courses';
import { useStore } from '../../store/use-store';
import { locationBlocked, onForYardage, turnOff, turnOn, useLocation, type Fix } from '../location';

/** Hole-screen button plus the sheet it opens. */
export function DistanceControl({ courseId, hole }: { courseId: string; hole: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [hole]);
  return (
    <div>
      <button class="btn btn-line btn-block" id="distance-open" onClick={() => setOpen(true)}>
        <RangeGlyph />Distance
      </button>
      {open && <DistanceSheet courseId={courseId} hole={hole} onClose={() => setOpen(false)} />}
    </div>
  );
}

function RangeGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 21V4" /><path d="M7 4.5l7 2.5-7 2.5" /><path d="M3 21h18" /><path d="M14 15h7M18.5 12.5L21 15l-2.5 2.5" />
    </svg>
  );
}

function CameraGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

/** The lens he last picked for a photo without EXIF, kept for the visit. */
let lastLens: number | undefined;

type Mode = 'photo' | 'gps';

function DistanceSheet({ courseId, hole, onClose }: { courseId: string; hole: number; onClose: () => void }) {
  // Location refused this visit, or not there at all: the GPS tab is hidden for the rest of the visit.
  const [blockedAtOpen] = useState(locationBlocked());
  // GPS leads where location can work: the hosted copy, which has no `window.claude`. Inside Claude the page cannot
  // use location, so the flag photo leads there.
  const gpsFirst = !blockedAtOpen && !(globalThis as { claude?: unknown }).claude;
  const [mode, setMode] = useState<Mode>(gpsFirst ? 'gps' : 'photo');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.getElementById('distance-sheet')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const gpsChip = <button class="chip" id="distance-mode-gps" aria-pressed={mode === 'gps'} onClick={() => setMode('gps')}>GPS</button>;
  return (
    <div class="gs-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="gs-sheet ds-sheet" id="distance-sheet" role="dialog" aria-modal="true" aria-labelledby="distance-title" tabIndex={-1}>
        <div class="gs-head">
          <h2 id="distance-title">Hole {hole} distance</h2>
          <button class="btn-text" id="distance-close" onClick={onClose}>Close</button>
        </div>
        {!blockedAtOpen && (
          <div class="seg ds-modes" role="group" aria-label="How to measure">
            {gpsFirst && gpsChip}
            <button class="chip" id="distance-mode-photo" aria-pressed={mode === 'photo'} onClick={() => setMode('photo')}>Flag photo</button>
            {!gpsFirst && gpsChip}
          </div>
        )}
        {/* Both stay mounted while the sheet is open, so switching back keeps the photo and its marks. */}
        <div hidden={mode !== 'photo'}><Rangefinder /></div>
        {mode === 'gps' && <GpsPanel courseId={courseId} hole={hole} onUsePhoto={() => setMode('photo')} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Flagstick rangefinder (12.1)
// ---------------------------------------------------------------------------------------------------------------

interface Pic {
  src: CanvasImageSource; w: number; h: number; release: () => void;
  /** FocalLengthIn35mmFilm as written in EXIF (phones usually include digital zoom in it), and DigitalZoomRatio. */
  f35?: number; zoom?: number;
}
interface View { s: number; x0: number; y0: number }        // css px per image px; image point at the top-left corner
type Which = 'top' | 'base';

const MAX_SCALE = 8;
const LOUPE = 128;                                           // css px
const KNOB_DX = 64, KNOB_DY = 30;

/**
 * Decodes the photo at full resolution. Modern browsers apply the EXIF orientation while decoding, so everything is
 * measured in the decoded bitmap's own pixels. That is safe because the 35 mm-equivalent focal length relates to the
 * image diagonal, which is the same whichever way the photo is turned.
 */
async function decodePhoto(file: Blob): Promise<Pick<Pic, 'src' | 'w' | 'h' | 'release'>> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (bmp.width && bmp.height) return { src: bmp, w: bmp.width, h: bmp.height, release: () => bmp.close() };
      bmp.close();
    } catch { /* fall back to an <img> decode below */ }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  const release = () => { img.removeAttribute('src'); URL.revokeObjectURL(url); };
  try {
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, release };
  } catch (e) { release(); throw e; }
}

/** Draws the part of `src` that falls inside the output, at `scale` output px per image px, image point (x0,y0) top-left. */
function drawRegion(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number,
  x0: number, y0: number, scale: number, outW: number, outH: number) {
  const sx = Math.max(0, x0), sy = Math.max(0, y0);
  const ex = Math.min(w, x0 + outW / scale), ey = Math.min(h, y0 + outH / scale);
  if (ex <= sx || ey <= sy) return;
  ctx.drawImage(src, sx, sy, ex - sx, ey - sy, (sx - x0) * scale, (sy - y0) * scale, (ex - sx) * scale, (ey - sy) * scale);
}

const fitView = (w: number, h: number, cw: number, ch: number): View => {
  const s = Math.min(cw / w, ch / h);
  return { s, x0: (w - cw / s) / 2, y0: (h - ch / s) / 2 };
};

function Rangefinder() {
  const store = useStore();
  const flagFt = clampFlagFt(store.data.profile?.flagHeightFt ?? DEFAULT_FLAG_FT);
  const [pic, setPic] = useState<Pic | null>(null);
  const [loading, setLoading] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [marks, setMarks] = useState<Partial<Record<Which, Point>>>({});
  const [lens, setLens] = useState<number | undefined>(lastLens);
  const [dragging, setDragging] = useState<Which | null>(null);
  const [applyZoom, setApplyZoom] = useState(false);       // multiply by DigitalZoomRatio; off by default (see effectiveF35)

  const fileRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const picRef = useRef<Pic | null>(null);
  const seq = useRef(0);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<null | { kind: 'tap' | 'pan'; x: number; y: number; v: View }
    | { kind: 'pinch'; d: number; mx: number; my: number; v: View }>(null);
  const knob = useRef<{ which: Which; id: number; x: number; y: number; m: Point } | null>(null);
  // Handlers read the latest values through refs (pointer events arrive faster than renders).
  const live = useRef({ view, size, pic, marks });
  live.current = { view, size, pic, marks };

  // Release the decoded photo when the sheet closes.
  useEffect(() => () => { seq.current++; picRef.current?.release(); picRef.current = null; }, []);

  // Track the stage size.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(read);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, [!!pic]);

  const clampView = (v: View, p = live.current.pic, sz = live.current.size): View => {
    if (!p || !sz.w) return v;
    const minS = Math.min(sz.w / p.w, sz.h / p.h);
    const s = Math.min(Math.max(v.s, minS), Math.max(MAX_SCALE, minS));
    // Keep the centre of the asked-for view (so a zoom past the limits does not drift), and keep it on the photo.
    const cx = Math.min(p.w, Math.max(0, v.x0 + sz.w / (2 * v.s)));
    const cy = Math.min(p.h, Math.max(0, v.y0 + sz.h / (2 * v.s)));
    return { s, x0: cx - sz.w / (2 * s), y0: cy - sz.h / (2 * s) };
  };

  // Fit once the photo and the stage size are both known; keep the view valid when the stage resizes.
  useEffect(() => {
    if (!pic || !size.w || !size.h) return;
    setView((v) => (v ? clampView(v, pic, size) : fitView(pic.w, pic.h, size.w, size.h)));
  }, [pic, size.w, size.h]);

  // Draw only the visible region of the photo.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !pic || !view || !size.w) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(size.w * dpr), H = Math.round(size.h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = view.s * dpr < 2;
    drawRegion(ctx, pic.src, pic.w, pic.h, view.x0, view.y0, view.s * dpr, W, H);
  }, [pic, view, size.w, size.h]);

  // The loupe: the pixels under the mark being dragged, magnified with no smoothing so single pixels show.
  const loupeScale = view ? Math.min(12, Math.max(4, view.s * 3)) : 4;
  const dragMark = dragging ? marks[dragging] : undefined;
  useEffect(() => {
    const c = loupeRef.current;
    if (!c || !pic || !dragMark) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const S = Math.round(LOUPE * dpr);
    if (c.width !== S) { c.width = S; c.height = S; }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const k = loupeScale * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = false;
    drawRegion(ctx, pic.src, pic.w, pic.h, dragMark.x - S / (2 * k), dragMark.y - S / (2 * k), k, S, S);
    // Cross hair with a gap, so the pixel at the centre stays visible.
    const m = S / 2, g = 6 * dpr, l = 22 * dpr;
    ctx.lineCap = 'round';
    for (const [col, wdt] of [['rgba(0,0,0,.75)', 4 * dpr], ['#fff', 1.6 * dpr]] as const) {
      ctx.strokeStyle = col; ctx.lineWidth = wdt;
      ctx.beginPath();
      ctx.moveTo(m - l, m); ctx.lineTo(m - g, m); ctx.moveTo(m + g, m); ctx.lineTo(m + l, m);
      ctx.moveTo(m, m - l); ctx.lineTo(m, m - g); ctx.moveTo(m, m + g); ctx.lineTo(m, m + l);
      ctx.stroke();
    }
  }, [pic, dragMark?.x, dragMark?.y, loupeScale]);

  const pick = () => fileRef.current?.click();
  const onFile = async () => {
    const input = fileRef.current;
    const file = input?.files?.[0];
    if (!input || !file) return;
    input.value = '';                                   // drop the reference: the photo is not kept
    const my = ++seq.current;
    picRef.current?.release(); picRef.current = null;
    setPic(null); setView(null); setMarks({}); setFail(null); setApplyZoom(false); setLoading(true);
    let exif = null;
    try { exif = readExif(await file.slice(0, 256 * 1024).arrayBuffer()); } catch { exif = null; }
    try {
      const d = await decodePhoto(file);
      if (my !== seq.current) { d.release(); return; }
      const p: Pic = { ...d };
      if (exif?.focal35) { p.f35 = exif.focal35; if (hasDigitalZoom(exif.digitalZoom)) p.zoom = exif.digitalZoom; }
      picRef.current = p;
      setPic(p);
    } catch {
      if (my === seq.current) setFail("This photo can't be read. Try another one, or take a new photo.");
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };

  const setFlag = (ft: number) => {
    store.saveProfile({ gender: 'M', ...store.data.profile, flagHeightFt: clampFlagFt(ft), updatedAt: '' });
  };

  // ----- gestures on the photo: tap places a mark, one finger pans, two fingers pinch ------------------------------
  const local = (e: PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onDown = (e: PointerEvent) => {
    const v = live.current.view;
    if (!v) return;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    if (ptrs.current.size === 1) gesture.current = { kind: 'tap', x: p.x, y: p.y, v };
    else if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      gesture.current = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, v };
    }
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s = g.v.s * (d / g.d);
      const ix = g.v.x0 + g.mx / g.v.s, iy = g.v.y0 + g.my / g.v.s;   // image point that was under the fingers
      setView(clampView({ s, x0: ix - mx / s, y0: iy - my / s }));
    } else if (g.kind !== 'pinch') {
      const dx = p.x - g.x, dy = p.y - g.y;
      if (g.kind === 'tap' && Math.hypot(dx, dy) < 8) return;
      gesture.current = { ...g, kind: 'pan' };
      setView(clampView({ s: g.v.s, x0: g.v.x0 - dx / g.v.s, y0: g.v.y0 - dy / g.v.s }));
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const p = local(e);
    ptrs.current.delete(e.pointerId);
    const g = gesture.current;
    const { view: v, pic: pc, marks: mk } = live.current;
    if (g?.kind === 'tap' && e.type === 'pointerup' && v && pc) {
      const pt = { x: Math.min(pc.w, Math.max(0, v.x0 + p.x / v.s)), y: Math.min(pc.h, Math.max(0, v.y0 + p.y / v.s)) };
      if (!mk.top) setMarks({ top: pt });
      else if (!mk.base) setMarks({ ...mk, base: pt });
    }
    if (ptrs.current.size === 1 && v) {
      // One finger left after a pinch: carry on as a pan from here.
      const [q] = [...ptrs.current.values()];
      gesture.current = { kind: 'pan', x: q.x, y: q.y, v };
    } else if (ptrs.current.size === 0) gesture.current = null;
  };
  const onWheel = (e: WheelEvent) => {
    const v = live.current.view;
    if (!v) return;
    e.preventDefault();
    const p = local(e as unknown as PointerEvent);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY / 300));
  };
  const zoomAt = (x: number, y: number, k: number) => {
    const v = live.current.view;
    if (!v) return;
    const s = v.s * k;
    const ix = v.x0 + x / v.s, iy = v.y0 + y / v.s;
    setView(clampView({ s, x0: ix - x / s, y0: iy - y / s }));
  };
  const zoomButton = (k: number) => zoomAt(size.w / 2, size.h / 2, k);

  // ----- handles: the knob is offset from its mark so the finger never covers the flagstick --------------------
  const toCss = (m: Point) => ({ x: (m.x - view!.x0) * view!.s, y: (m.y - view!.y0) * view!.s });
  const knobPos = (which: Which, m: Point) => {
    const c = toCss(m);
    const dx = c.x > size.w - KNOB_DX - 30 ? -KNOB_DX : KNOB_DX;
    const dy = which === 'top' ? -KNOB_DY : KNOB_DY;
    return { x: Math.min(size.w - 26, Math.max(26, c.x + dx)), y: Math.min(size.h - 26, Math.max(26, c.y + dy)) };
  };
  const moveMark = (which: Which, m: Point) => {
    const pc = live.current.pic;
    if (!pc) return;
    setMarks((prev) => ({ ...prev, [which]: { x: Math.min(pc.w, Math.max(0, m.x)), y: Math.min(pc.h, Math.max(0, m.y)) } }));
  };
  const knobDown = (which: Which) => (e: PointerEvent) => {
    const m = live.current.marks[which];
    if (!m) return;
    e.stopPropagation();
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    knob.current = { which, id: e.pointerId, x: e.clientX, y: e.clientY, m };
    setDragging(which);
  };
  const knobMove = (e: PointerEvent) => {
    const k = knob.current, v = live.current.view;
    if (!k || k.id !== e.pointerId || !v) return;
    moveMark(k.which, { x: k.m.x + (e.clientX - k.x) / v.s, y: k.m.y + (e.clientY - k.y) / v.s });
  };
  const knobUp = (e: PointerEvent) => {
    if (knob.current?.id !== e.pointerId) return;
    knob.current = null;
    setDragging(null);
  };
  const knobKey = (which: Which) => (e: KeyboardEvent) => {
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const s = step[e.key];
    const m = marks[which];
    if (!s || !m || !view) return;
    e.preventDefault();
    const d = (e.shiftKey ? 10 : 1) / view.s;
    moveMark(which, { x: m.x + s[0] * d, y: m.y + s[1] * d });
  };

  // ----- the reading -----------------------------------------------------------------------------------------------
  const f35 = pic?.f35 ? effectiveF35(pic.f35, pic.zoom, applyZoom) : lens;
  const zoomX = pic?.zoom ? +pic.zoom.toFixed(2) : 0;
  const both = !!(marks.top && marks.base);
  const result = pic && both && f35
    ? measure({ flagFt, f35, width: pic.w, height: pic.h, heightPx: spanPx(marks.top!, marks.base!) }) : null;
  const lensLabel = LENSES.find((l) => l.mm === lens)?.label;
  const hint = !pic ? '' : !marks.top ? 'Zoom in on the flag, then tap the very top of the flagstick.'
    : !marks.base ? 'Now tap the bottom of the stick, where it meets the hole.'
    : 'Drag the round handles to fine-tune. The loupe shows the exact pixels.';
  const loupeLeft = dragMark && view ? toCss(dragMark).x > size.w / 2 : false;

  return (
    <div class="rf" id="rangefinder">
      {!pic && (
        <div class="rf-empty">
          <button class="btn btn-primary btn-block" id="rf-photo" disabled={loading} onClick={pick}>
            <CameraGlyph />{loading ? 'Opening the photo…' : 'Photograph the flag'}
          </button>
          {fail && <p class="gs-fail" id="rf-error" role="status">{fail}</p>}
          <ol class="rf-steps">
            <li>Zoom to the 2x or 3x lens and take the photo with the whole flagstick in view.</li>
            <li>Mark the top of the stick and the bottom at the hole.</li>
            <li>Read the yards. The photo is not kept.</li>
          </ol>
        </div>
      )}
      {pic && (
        <>
          <p class="gs-hint" id="rf-hint">{hint}</p>
          <div class="rf-stage" ref={stageRef} id="rf-stage" data-scale={view?.s} data-x0={view?.x0} data-y0={view?.y0}
            data-img-w={pic.w} data-img-h={pic.h}>
            <canvas ref={canvasRef} class="rf-canvas" id="rf-canvas" aria-label="Your photo. Tap to place a mark, drag to move, pinch to zoom."
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel} />
            {view && (
              <svg class="rf-overlay" width={size.w} height={size.h} aria-hidden="true">
                {both && (() => { const a = toCss(marks.top!), b = toCss(marks.base!); return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class="rf-span" />; })()}
                {(['top', 'base'] as Which[]).map((w) => {
                  const m = marks[w];
                  if (!m) return null;
                  const c = toCss(m), k = knobPos(w, m);
                  return (
                    <g class={`rf-mark rf-${w}`} id={`rf-mark-${w}`} data-ix={m.x} data-iy={m.y}>
                      <line x1={c.x} y1={c.y} x2={k.x} y2={k.y} class="rf-tether" />
                      <path d={`M${c.x - 20} ${c.y}H${c.x - 5}M${c.x + 5} ${c.y}H${c.x + 20}`} class="rf-tick-halo" />
                      <path d={`M${c.x - 20} ${c.y}H${c.x - 5}M${c.x + 5} ${c.y}H${c.x + 20}`} class="rf-tick" />
                    </g>
                  );
                })}
              </svg>
            )}
            {view && (['top', 'base'] as Which[]).map((w) => {
              const m = marks[w];
              if (!m) return null;
              const k = knobPos(w, m);
              return (
                <button class={`rf-knob rf-knob-${w}`} id={`rf-knob-${w}`} style={`left:${k.x}px;top:${k.y}px`}
                  data-active={dragging === w}
                  aria-label={`${w === 'top' ? 'Top of the flagstick' : 'Bottom of the flagstick'} handle. Drag, or use the arrow keys.`}
                  onPointerDown={knobDown(w)} onPointerMove={knobMove} onPointerUp={knobUp} onPointerCancel={knobUp} onKeyDown={knobKey(w)}>
                  <span>{w === 'top' ? 'Top' : 'Hole'}</span>
                </button>
              );
            })}
            {dragMark && (
              <div class="rf-loupe" id="rf-loupe" data-side={loupeLeft ? 'left' : 'right'}>
                <canvas ref={loupeRef} />
              </div>
            )}
            <div class="rf-zoom">
              <button id="rf-zoom-out" aria-label="Zoom out" onClick={() => zoomButton(0.5)}>{'−'}</button>
              <button id="rf-zoom-in" aria-label="Zoom in" onClick={() => zoomButton(2)}>+</button>
            </div>
          </div>

          {!pic.f35 && (
            <div class="rf-lens-pick">
              <div class="lbl" id="rf-lens-label">This photo doesn't say which lens. Which one did you use?</div>
              <div class="seg" role="group" aria-labelledby="rf-lens-label">
                {LENSES.map((l) => (
                  <button class="chip num" id={`rf-lens-${l.label.replace('.', '')}`} aria-pressed={lens === l.mm}
                    onClick={() => { lastLens = l.mm; setLens(l.mm); }}>{l.label}</button>
                ))}
              </div>
            </div>
          )}

          <div class="rf-readout" aria-live="polite" id="rf-readout">
            {result?.ok ? (
              <>
                <div class="rf-yards"><b class="num" id="rf-yards">{result.yards}</b><span>yd</span></div>
                <div class="rf-pm num" id="rf-pm">± {result.plusMinus} yd</div>
              </>
            ) : (
              <b class="rf-wait" id="rf-wait">
                {!both ? 'Place both marks to read the distance'
                  : !f35 ? 'Pick the lens to read the distance'
                  : 'The marks are too close together. Zoom in and drag them apart.'}
              </b>
            )}
          </div>
          <p class="rf-basis" id="rf-lens" data-source={pic.f35 ? (zoomX ? 'zoom' : 'photo') : lens ? 'guess' : 'none'}>
            {pic.f35
              ? zoomX
                ? applyZoom
                  ? `Approximate: lens ${Math.round(f35!)} mm (${pic.f35} mm from the photo x ${zoomX} zoom)`
                  : `Approximate: lens ${pic.f35} mm as the photo states it, zoomed ${zoomX}x`
                : `Lens ${pic.f35} mm, read from the photo`
              : lens ? `Approximate: lens guessed (${lensLabel}, ${lens} mm)` : 'Lens not known yet'}
            {` · ${flagFt} ft flagstick`}
          </p>
          {zoomX > 0 && (
            <div class="rf-zoomnote" id="rf-zoom-note">
              <p>This photo was zoomed {zoomX}x. Most phones already count that in the lens figure. If the distance looks
                too short, turn this on to apply the zoom.</p>
              <button class="chip" id="rf-apply-zoom" aria-pressed={applyZoom} onClick={() => setApplyZoom(!applyZoom)}>
                Apply {zoomX}x zoom: {applyZoom ? 'on' : 'off'}
              </button>
            </div>
          )}
          <div class="rf-actions">
            <button class="btn btn-quiet" id="rf-reset" disabled={!marks.top} onClick={() => setMarks({})}>Mark again</button>
            <button class="btn btn-line" id="rf-photo" onClick={pick}><CameraGlyph />New photo</button>
          </div>
          {fail && <p class="gs-fail" id="rf-error" role="status">{fail}</p>}
        </>
      )}

      <div class="rf-flag">
        <div class="lbl" id="rf-flag-label">Flagstick height</div>
        <div class="mini" role="group" aria-labelledby="rf-flag-label">
          <button id="rf-flag-minus" aria-label="Half a foot shorter" disabled={flagFt <= FLAG_FT_MIN} onClick={() => setFlag(flagFt - 0.5)}>{'−'}</button>
          <b class="num" id="rf-flag-value">{flagFt} ft</b>
          <button id="rf-flag-plus" aria-label="Half a foot taller" disabled={flagFt >= FLAG_FT_MAX} onClick={() => setFlag(flagFt + 0.5)}>+</button>
        </div>
      </div>
      <p class="rf-honest">Most flagsticks are 7 ft; ask the pro shop if unsure. Best inside about 200 yards and with the 2x or 3x lens.
        A wrong stick height or lens throws the number off.</p>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" id="rf-photo-input" class="sr"
        tabIndex={-1} aria-hidden="true" onChange={onFile} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// GPS (12.2)
// ---------------------------------------------------------------------------------------------------------------

const NO_LOCATION = "This page cannot use your phone's location here. The flagstick rangefinder works everywhere.";
const SAVE_MAX_ACC_YD = 30;

/** Saves where he stands as the green for one hole on his copy of the course (a hand-saved green has no outline). */
export function saveGreenHere(store: ReturnType<typeof useStore>, course: Course, hole: number, fix: Fix): void {
  // Same path as the course editor: a bundled course becomes the user's own copy (same id). Posted and active
  // rounds keep their own frozen snapshot, which this does not touch.
  store.saveCourse({ ...course, holes: course.holes.map((h) => {
    if (h.number !== hole) return h;
    const { greenShape: _drop, ...rest } = h;
    return { ...rest, green: { lat: fix.lat, lon: fix.lon } };
  }) });
}

function GpsPanel({ courseId, hole, onUsePhoto }: { courseId: string; hole: number; onUsePhoto: () => void }) {
  const store = useStore();
  const course: Course | undefined = findCourse(courseId, store.data.courses);
  const theHole = course?.holes.find((h) => h.number === hole);
  const green = theHole?.green;
  const fromMap = !!theHole?.greenShape;
  // The page's one location watcher, shared with live yardage on the hole screen.
  const gps = useLocation();
  const [ball, setBall] = useState<Fix | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [saved, setSaved] = useState(false);
  const sharedWithYardage = onForYardage();
  // Turned on from this sheet only: closing it stops location, as the sheet says.
  useEffect(() => () => { if (!onForYardage()) turnOff(); }, []);

  const saveGreen = (fix: Fix) => {
    if (!course) return;
    saveGreenHere(store, course, hole, fix);
    setConfirmReplace(false);
    setSaved(true);
  };

  if (gps.state === 'blocked') {
    return (
      <div class="gps" id="gps-panel">
        <p class="gs-fail" id="gps-blocked" role="status">{NO_LOCATION}</p>
        <button class="btn btn-primary btn-block ds-gap" id="gps-use-photo" onClick={onUsePhoto}><CameraGlyph />Use the flag photo</button>
      </div>
    );
  }

  const fix = gps.state === 'live' ? gps.fix : null;
  const accYd = fix ? accuracyYards(fix.acc) : 0;
  return (
    <div class="gps" id="gps-panel">
      {!fix && (
        <div class="gps-start">
          <p class="gs-hint">Your phone's location gives the distance to a green you have saved, and how far you hit a shot.
            Some apps don't let this page use location; the flag photo works everywhere.</p>
          <button class="btn btn-primary btn-block" id="gps-start" disabled={gps.state === 'waiting'} onClick={() => turnOn()}>
            {gps.state === 'waiting' ? 'Finding you…' : gps.state === 'nofix' ? 'Try again' : 'Use my location'}
          </button>
          {gps.state === 'nofix' && <p class="gs-fail" id="gps-nofix" role="status">{gps.message}</p>}
        </div>
      )}
      {fix && (
        <>
          <div class="gps-card" id="gps-green">
            {green ? (
              <>
                <small>To the green</small>
                <div class="rf-readout">
                  {/* The same line-of-play computation as live yardage on the hole screen. */}
                  <div class="rf-yards"><b class="num" id="gps-yards">{holeYards(fix, { green, greenShape: theHole?.greenShape, hazards: theHole?.hazards }).centre}</b><span>yd</span></div>
                  <div class="rf-pm num" id="gps-pm">± {accYd} yd</div>
                </div>
                <p class="rf-basis">{fromMap ? `To the middle of the green on hole ${hole}, from the map. The pin may be front or back.`
                  : `To where you saved the pin on hole ${hole}. The pin moves day to day.`}</p>
              </>
            ) : (
              <p class="gps-none" id="gps-no-green">No green saved for hole {hole} yet. Stand at the pin once and save it; from then on the
                yards show here.</p>
            )}
            {!course ? (
              <p class="gs-fail">This round's course is no longer in your list, so a green can't be saved.</p>
            ) : confirmReplace ? (
              <div class="confirm ds-gap" id="gps-replace-confirm">
                <p>Replace the saved green for hole {hole} with where you stand now?</p>
                <div class="btn-row">
                  <button class="btn btn-quiet" id="gps-replace-no" onClick={() => setConfirmReplace(false)}>Keep it</button>
                  <button class="btn btn-primary" id="gps-replace-yes" onClick={() => saveGreen(fix)}>Replace</button>
                </div>
              </div>
            ) : (
              <button class="btn btn-line btn-block ds-gap" id="gps-save-green" disabled={accYd > SAVE_MAX_ACC_YD}
                onClick={() => (green ? setConfirmReplace(true) : saveGreen(fix))}>
                {green ? "I'm at the pin: update this green" : "I'm at the pin: save this green"}
              </button>
            )}
            {accYd > SAVE_MAX_ACC_YD && <p class="rf-basis" id="gps-weak">Location is only good to ± {accYd} yd. Wait for a better fix before saving a green.</p>}
            {saved && !confirmReplace && <p class="rf-basis gps-ok" id="gps-saved" role="status">Green saved for hole {hole}.</p>}
          </div>

          <div class="gps-card" id="gps-shot">
            <small>Measure a shot</small>
            {ball ? (
              <div class="rf-readout">
                <div class="rf-yards"><b class="num" id="gps-walked">{distanceYards(ball, fix)}</b><span>yd walked</span></div>
                <div class="rf-pm num" id="gps-walked-pm">± {accuracyYards(ball.acc + fix.acc)} yd</div>
              </div>
            ) : (
              <p class="gps-none">Mark where you hit from, then walk to your ball.</p>
            )}
            <button class="btn btn-line btn-block ds-gap" id="gps-mark-ball" onClick={() => setBall(fix)}>
              {ball ? 'Mark again from here' : 'Mark my ball here'}
            </button>
          </div>
          <p class="rf-basis" id="gps-acc">{sharedWithYardage
            ? `Your location: ± ${accYd} yd. Live yardage keeps location on while you play.`
            : `Your location: ± ${accYd} yd. Location stops when you close this.`}</p>
        </>
      )}
    </div>
  );
}

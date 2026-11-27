// The "Mark approach" control on the hole screen and its green sheet (plan section 8): a top-down green with the
// pin at the centre, tap or drag to place the ball, or "Use a photo" to have Claude suggest the spot. Manual
// placement needs no network and no capability. The photo is held in memory for the one call and never stored.
import { useEffect, useRef, useState } from 'preact/hooks';
import { clampMark, describeMark } from '../../core/approach';
import type { ApproachMark } from '../../core/types';
import { prepareSample, readGreenPhoto, type PhotoFailure, type SampleFn } from '../../vision/green';

/** The diagram shows ±EXT_FT around the pin; marks further out sit on its edge (their readout stays true). */
export const EXT_FT = 40;
/** The drawn green: an ellipse this wide / deep (half-axes, ft). A tap inside it presets "On the green". */
const GREEN_RX = 33, GREEN_RY = 28;
const RINGS = [10, 20, 30];

const toUnit = (ft: number) => 50 + (ft / EXT_FT) * 50;
const edge = (m: { xFt: number; yFt: number }) => {
  const k = Math.max(Math.abs(m.xFt), Math.abs(m.yFt)) > EXT_FT * 0.95 ? (EXT_FT * 0.95) / Math.max(Math.abs(m.xFt), Math.abs(m.yFt)) : 1;
  return { x: toUnit(m.xFt * k), y: 100 - toUnit(m.yFt * k) };
};
const insideGreen = (m: { xFt: number; yFt: number }) => (m.xFt / GREEN_RX) ** 2 + (m.yFt / GREEN_RY) ** 2 <= 1;

/** The green's outline, slightly irregular so it reads as a green rather than a target. */
function greenPath(scale = 1): string {
  const pts: string[] = [];
  for (let i = 0; i <= 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const wobble = 1 + 0.05 * Math.sin(a * 3 + 0.6) + 0.03 * Math.cos(a * 5);
    const x = toUnit(Math.cos(a) * GREEN_RX * wobble * scale);
    const y = 100 - toUnit(Math.sin(a) * GREEN_RY * wobble * scale);
    pts.push(`${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `${pts.join('')}Z`;
}
export const GREEN_D = greenPath();
export const FRINGE_D = greenPath(1.12);

/** The static part of the green: fringe, putting surface, rings, pin. Shared by the sheet and the hole-screen chip. */
export function GreenArt({ labels = true }: { labels?: boolean }) {
  return (
    <g>
      <path d={FRINGE_D} class="gs-fringe" />
      <path d={GREEN_D} class="gs-green" />
      {RINGS.map((r) => <circle cx="50" cy="50" r={(r / EXT_FT) * 50} class="gs-ring" />)}
      {labels && RINGS.map((r) => (
        <text x={50 + (r / EXT_FT) * 50 * 0.7071 + 0.8} y={50 - (r / EXT_FT) * 50 * 0.7071 - 0.8} class="gs-ring-t">{r}</text>
      ))}
      <circle cx="50" cy="50" r="1.3" class="gs-hole" />
      <path d="M50 50V40.5" class="gs-stick" />
      <path d="M50 40.5l5.2 1.9-5.2 1.9z" class="gs-flag" />
    </g>
  );
}

function Ball({ mark, suggestion, mini }: { mark: { xFt: number; yFt: number }; suggestion?: boolean; mini?: boolean }) {
  const p = edge(mark);
  return (
    <g id={mini ? undefined : 'green-ball'} data-x={mark.xFt} data-y={mark.yFt}>
      {suggestion && <circle cx={p.x} cy={p.y} r="6" class="gs-suggest" />}
      <circle cx={p.x} cy={p.y} r={mini ? 6 : 2.7} class="gs-ball" style={mini ? 'stroke-width:2.4' : undefined} />
    </g>
  );
}

/** The hole-screen control: "Mark approach" when empty, the saved mark's state when there is one. */
export function ApproachControl({ hole, mark, onSave }: {
  hole: number; mark: ApproachMark | undefined; onSave: (mark: ApproachMark | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [hole]);
  return (
    <div>
      {mark ? (
        <button class="ap-row" id="approach-open" data-state="saved" onClick={() => setOpen(true)}>
          <svg viewBox="8 8 84 84" class="ap-mini" aria-hidden="true"><GreenArt labels={false} /><Ball mark={mark} mini /></svg>
          <span class="grow">
            <small>Approach</small>
            <b id="approach-summary">{describeMark(mark)}</b>
            <span>{mark.source === 'photo' ? 'From a photo' : 'Placed by hand'} · tap to move or remove</span>
          </span>
        </button>
      ) : (
        <button class="btn btn-line btn-block" id="approach-open" data-state="empty" onClick={() => setOpen(true)}>
          <TargetGlyph />Mark approach
        </button>
      )}
      {open && <GreenSheet hole={hole} initial={mark} onClose={() => setOpen(false)}
        onSave={(m) => { onSave(m); setOpen(false); }} />}
    </div>
  );
}

function TargetGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
      <ellipse cx="12" cy="13" rx="9" ry="7" /><path d="M12 13V3l5 2-5 2" /><circle cx="16.5" cy="15.5" r="1.6" fill="currentColor" stroke="none" />
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

/** Set for the rest of the visit once photos turned out to be impossible here (no capability, declined). */
let photoBlocked = false;

type Photo =
  | { state: 'idle' }
  | { state: 'reading' }
  | { state: 'suggested'; note: string; confidence?: number }
  | { state: 'failed'; failure: PhotoFailure };

export function GreenSheet({ hole, initial, onSave, onClose }: {
  hole: number; initial: ApproachMark | undefined; onSave: (m: ApproachMark | undefined) => void; onClose: () => void;
}) {
  const [mark, setMark] = useState<ApproachMark | undefined>(initial);
  const [greenSet, setGreenSet] = useState(!!initial);   // he chose on / off the green himself
  const [photo, setPhoto] = useState<Photo>({ state: 'idle' });
  const [blocked, setBlocked] = useState(photoBlocked);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ id: number; keepSource: boolean } | null>(null);
  const prepared = useRef<Promise<SampleFn | null> | null>(null);
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.getElementById('green-sheet')?.focus();
    return () => { document.removeEventListener('keydown', onKey); ctl.current?.abort(); };
  }, []);

  const close = () => { ctl.current?.abort(); onClose(); };

  const ftAt = (e: PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { xFt: ((e.clientX - r.left) / r.width - 0.5) * 2 * EXT_FT, yFt: (0.5 - (e.clientY - r.top) / r.height) * 2 * EXT_FT };
  };
  const place = (p: { xFt: number; yFt: number }, keepSource: boolean) => {
    setMark((prev) => {
      const source = keepSource && prev ? prev.source : 'manual';
      const next: ApproachMark = clampMark({
        xFt: p.xFt, yFt: p.yFt,
        onGreen: greenSet && prev ? prev.onGreen : insideGreen(p),
        source,
        ...(source === 'photo' && prev?.confidence !== undefined ? { confidence: prev.confidence } : {}),
      });
      return next;
    });
    if (!keepSource && photo.state === 'suggested') setPhoto({ state: 'idle' });
  };

  const onDown = (e: PointerEvent) => {
    if (photo.state === 'reading') return;
    const svg = svgRef.current!;
    const p = ftAt(e);
    let near = false;
    if (mark) {
      const r = svg.getBoundingClientRect();
      const b = edge(mark);
      near = Math.hypot(e.clientX - (r.left + (b.x / 100) * r.width), e.clientY - (r.top + (b.y / 100) * r.height)) < 30;
    }
    drag.current = { id: e.pointerId, keepSource: near };
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    if (!near) place(p, false);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    place(ftAt(e), drag.current.keepSource);
  };
  const onUp = (e: PointerEvent) => { if (drag.current?.id === e.pointerId) drag.current = null; };
  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const s = step[e.key];
    if (!s) return;
    e.preventDefault();
    const base = mark ?? { xFt: 0, yFt: 0 };
    place({ xFt: base.xFt + s[0], yFt: base.yFt + s[1] }, true);
  };

  // "Use a photo": the picker must open inside the tap, and `sample` is fetched inside the same tap.
  const pickPhoto = () => {
    const claude = (globalThis as { claude?: { use?: unknown } }).claude;
    if (!claude?.use) {
      photoBlocked = true; setBlocked(true);
      setPhoto({ state: 'failed', failure: { message: "Photo reading isn't available here. Tap the green to place your ball.", final: true } });
      return;
    }
    prepared.current = prepareSample();
    fileRef.current?.click();
  };
  const onFile = async () => {
    const input = fileRef.current;
    const file = input?.files?.[0];
    if (!input || !file) return;
    input.value = '';                    // drop the reference: the photo is not kept
    const c = new AbortController();
    ctl.current = c;
    setPhoto({ state: 'reading' });
    const out = await readGreenPhoto(file, prepared.current ?? prepareSample(), c.signal);
    if (c.signal.aborted || out.kind === 'cancelled') { if (ctl.current === c) setPhoto({ state: 'idle' }); return; }
    if (out.kind === 'failed') {
      if (out.failure.final) { photoBlocked = true; setBlocked(true); }
      setPhoto({ state: 'failed', failure: out.failure });
      return;
    }
    setMark(out.mark);
    setGreenSet(false);
    setPhoto({ state: 'suggested', note: out.note, confidence: out.mark.confidence });
  };
  const stopReading = () => { ctl.current?.abort(); setPhoto({ state: 'idle' }); };

  const setGreen = (on: boolean) => {
    if (!mark) return;
    setGreenSet(true);
    setMark({ ...mark, onGreen: on });
  };

  const changed = !initial || !mark || initial.xFt !== mark.xFt || initial.yFt !== mark.yFt
    || initial.onGreen !== mark.onGreen || initial.source !== mark.source;

  return (
    <div class="gs-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="gs-sheet" id="green-sheet" role="dialog" aria-modal="true" aria-labelledby="green-sheet-title" tabIndex={-1}>
        <div class="gs-head">
          <h2 id="green-sheet-title">Hole {hole} approach</h2>
          <button class="btn-text" id="green-close" onClick={close}>Close</button>
        </div>
        <p class="gs-hint" id="green-hint">
          {photo.state === 'reading' ? 'Claude is finding the flag and your ball. This can take up to a minute.'
            : photo.state === 'suggested' ? 'Suggested from your photo. Drag the ball if it is off, then save.'
            : mark ? 'Drag the ball to adjust, or tap somewhere else.' : 'Tap where your ball finished. You hit from the bottom.'}
        </p>
        <div class="gs-stage" data-reading={photo.state === 'reading'}>
          <svg ref={svgRef} viewBox="0 0 100 100" class="gs-svg" id="green-diagram" tabIndex={0} role="application"
            aria-label={`Green diagram. ${mark ? `Ball ${describeMark(mark)}.` : 'No ball placed.'} Arrow keys move the ball one foot.`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
            <GreenArt />
            {mark && <Ball mark={mark} suggestion={photo.state === 'suggested'} />}
          </svg>
          <span class="gs-dir gs-long">Long</span>
          <span class="gs-dir gs-short">Short</span>
          <span class="gs-dir gs-left">Left</span>
          <span class="gs-dir gs-right">Right</span>
          {photo.state === 'reading' && (
            <div class="gs-reading" role="status" id="green-reading">
              <span class="gs-spin" aria-hidden="true" />
              <b>Reading the photo…</b>
              <button class="btn btn-quiet" id="green-photo-stop" onClick={stopReading}>Stop</button>
            </div>
          )}
        </div>

        <div class="gs-readout" aria-live="polite">
          <b id="approach-readout" class="num">{mark ? describeMark(mark) : 'No ball placed'}</b>
          {mark && <span id="approach-source">
            {mark.source === 'photo'
              ? `From the photo${typeof mark.confidence === 'number' && mark.confidence < 0.5 ? ' · low confidence, check it' : ''}`
              : 'Placed by hand'}
          </span>}
        </div>
        {photo.state === 'suggested' && photo.note && <p class="gs-note" id="green-photo-note">{photo.note}</p>}
        {photo.state === 'failed' && <p class="gs-fail" id="green-photo-error" role="status">{photo.failure.message}</p>}

        <div class="seg gs-seg" role="group" aria-label="Where it finished">
          <button class="chip" id="approach-on-green" disabled={!mark} aria-pressed={!!mark && mark.onGreen} onClick={() => setGreen(true)}>On the green</button>
          <button class="chip" id="approach-off-green" disabled={!mark} aria-pressed={!!mark && !mark.onGreen} onClick={() => setGreen(false)}>Missed the green</button>
        </div>

        {!blocked && (
          <div class="gs-photo">
            <button class="btn btn-line btn-block" id="green-photo" disabled={photo.state === 'reading'} onClick={pickPhoto}>
              <CameraGlyph />{photo.state === 'suggested' || photo.state === 'failed' ? 'Try another photo' : 'Use a photo'}
            </button>
            <p>Stand where you hit from, with the flag and your ball in the frame. The photo is not kept.</p>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" capture="environment" id="green-photo-input" class="sr"
          tabIndex={-1} aria-hidden="true" onChange={onFile} />

        <div class="gs-actions">
          {initial
            ? <button class="btn btn-quiet" id="approach-remove" onClick={() => onSave(undefined)}>Remove</button>
            : <button class="btn btn-quiet" id="approach-cancel" onClick={close}>Cancel</button>}
          <button class="btn btn-primary" id="approach-save" disabled={!mark || !changed || photo.state === 'reading'}
            onClick={() => mark && onSave(mark)}>{initial ? 'Save changes' : 'Save mark'}</button>
        </div>
      </div>
    </div>
  );
}

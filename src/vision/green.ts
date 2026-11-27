// Reading a green photo through the `sample` capability (plan section 8): the prompt, the answer's validation,
// the downscale before sending, and the one call. The photo is never stored: it lives only in memory for the call.
import { clampMark } from '../core/approach';
import type { ApproachMark } from '../core/types';

/** The prompt sent with the photo. Self-contained: each `sample` call is memoryless. */
export const GREEN_PROMPT = [
  'The image is a photo of a golf green taken by the golfer who just hit an approach shot onto or near it.',
  'The golfer was asked to take it from the direction the shot came from, so the camera looks along the line of the shot.',
  'Find the flagstick (where it enters the hole) and the golfer\'s golf ball, and estimate where the ball is relative to the hole.',
  '',
  'Coordinate frame, in feet, from the camera\'s viewpoint, with the hole at (0, 0):',
  '- xFt: positive = the ball is to the RIGHT of the hole, negative = LEFT.',
  '- yFt: positive = the ball is BEYOND the hole (further from the camera, "long"), negative = SHORT of it (nearer the camera).',
  '',
  'Judge scale from known sizes: a flagstick is about 7 ft tall, the hole is 4.25 in wide, a golf ball is 1.68 in wide.',
  'Allow for perspective: distances along the line of sight look much shorter than the same distance across it.',
  'onGreen: true if the ball rests on the putting surface (short, smooth grass), false if it is on the fringe, rough, in a bunker or anywhere else.',
  'confidence: 0 to 1, how sure you are of the position.',
  'If you cannot see both the flagstick (or the hole) and a golf ball, set found to false and the numbers to 0.',
  'If there are several balls, use the one nearest the camera\'s line of sight to the hole and say so in note.',
  '',
  'Reply with only this JSON object and nothing else:',
  '{"found": true, "xFt": -6.5, "yFt": -12, "onGreen": true, "confidence": 0.7, "note": "one short sentence on what you saw"}',
].join('\n');

export type GreenReading =
  | { ok: true; mark: ApproachMark; note: string }
  | { ok: false; reason: 'not_found' | 'bad_answer'; note: string };

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Validates Claude's answer: found ball → a clamped photo mark; anything else → a reason. */
export function parseGreenAnswer(raw: unknown): GreenReading {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_answer', note: '' };
  const o = raw as Record<string, unknown>;
  const note = typeof o.note === 'string' ? o.note.slice(0, 200) : '';
  if (o.found === false || o.found === 'false') return { ok: false, reason: 'not_found', note };
  if (o.found !== true && o.found !== 'true') return { ok: false, reason: 'bad_answer', note };
  const x = num(o.xFt), y = num(o.yFt);
  if (x === null || y === null) return { ok: false, reason: 'bad_answer', note };
  const c = num(o.confidence);
  const confidence = c === null ? undefined : Math.round(Math.min(1, Math.max(0, c)) * 100) / 100;
  const onGreen = typeof o.onGreen === 'boolean' ? o.onGreen : Math.hypot(x, y) <= 30;
  const mark = clampMark<ApproachMark>({ xFt: x, yFt: y, onGreen, source: 'photo', ...(confidence !== undefined ? { confidence } : {}) });
  return { ok: true, mark, note };
}

/** The size a photo is drawn at before sending: longest side at most `max`, never upscaled. */
export function scaledSize(width: number, height: number, max = 1280): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Draws the photo into a canvas at most 1280 px on its longest side and returns a JPEG (quality 0.8). */
export async function downscalePhoto(file: Blob, max = 1280, quality = 0.8): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement;
  let w: number, h: number;
  let url: string | null = null;
  if (typeof createImageBitmap === 'function') {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    w = source.width; h = source.height;
  } else {
    url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('decode')); img.src = url as string; });
    source = img; w = img.naturalWidth; h = img.naturalHeight;
  }
  try {
    const size = scaledSize(w, h, max);
    const canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.drawImage(source, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', quality));
    canvas.width = 0; canvas.height = 0;               // let the pixels go straight away
    if (!blob) throw new Error('encode');
    return blob;
  } finally {
    if ('close' in source) source.close();
    if (url) URL.revokeObjectURL(url);
  }
}

// ---- the call ----

export interface SampleFn {
  json: (input: string, options?: { images?: Blob | Blob[]; signal?: AbortSignal }) => Promise<unknown>;
  limits: () => Promise<{ images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] } }>;
}
type ClaudeWindow = { claude?: { use?: (name: string) => Promise<unknown> } };

/** Why a photo could not be used. `final` failures hide the photo button for the rest of the visit. */
export interface PhotoFailure { message: string; final: boolean }

export type PhotoOutcome =
  | { kind: 'mark'; mark: ApproachMark; note: string }
  | { kind: 'failed'; failure: PhotoFailure }
  | { kind: 'cancelled' };

const TAP = 'Tap the green to place your ball.';
export const PHOTO_FAILURES = {
  unavailable: { message: `Photo reading isn't available here. ${TAP}`, final: true },
  declined: { message: `Claude wasn't allowed to read photos. ${TAP}`, final: true },
  notFound: { message: `Couldn't see both the flagstick and your ball. ${TAP}`, final: false },
  badAnswer: { message: `Couldn't read a position from that photo. ${TAP}`, final: false },
  badImage: { message: `That photo couldn't be opened. ${TAP}`, final: false },
  busy: { message: `Too many photo reads just now. ${TAP}`, final: false },
  failed: { message: `The photo read didn't go through. ${TAP}`, final: false },
} satisfies Record<string, PhotoFailure>;

/** Maps a rejected `sample` call to the line shown under the green. */
export function failureFor(code: unknown): PhotoFailure {
  switch (code) {
    case 'not_granted': return PHOTO_FAILURES.declined;
    case 'sampling_disabled': case 'not_declared': case 'capability_disabled': case 'capability_removed':
    case 'images_unavailable': return PHOTO_FAILURES.unavailable;
    case 'image_rejected': return PHOTO_FAILURES.badImage;
    case 'invalid_json': return PHOTO_FAILURES.badAnswer;
    case 'rate_limited': return PHOTO_FAILURES.busy;
    default: return PHOTO_FAILURES.failed;
  }
}

/**
 * Gets `sample` and checks this view can send images. Call it inside the tap handler (the first call to `sample`
 * may ask for consent, and only a tap may lead to that). Resolves null when photos cannot be read here.
 */
export async function prepareSample(): Promise<SampleFn | null> {
  const claude = (globalThis as unknown as ClaudeWindow).claude;
  if (!claude?.use) return null;
  try {
    const sample = (await claude.use('sample')) as SampleFn | null;
    if (!sample || typeof sample.json !== 'function' || typeof sample.limits !== 'function') return null;
    const limits = await sample.limits().catch(() => null);
    if (!limits?.images) return null;
    sampleLimits.set(sample, limits.images);
    return sample;
  } catch { return null; }
}
const sampleLimits = new WeakMap<object, { maxCount: number; maxInputBytes: number; mediaTypes: string[] }>();

/**
 * Reads one green photo with a `sample` from prepareSample: downscales, checks the view's image limits, asks
 * once. Never retries. The photo and the downscaled copy are only held in memory for the call.
 */
export async function readGreenPhoto(file: Blob, prepared: Promise<SampleFn | null> | SampleFn | null,
  signal?: AbortSignal): Promise<PhotoOutcome> {
  const sample = await prepared;
  if (signal?.aborted) return { kind: 'cancelled' };
  if (!sample) return { kind: 'failed', failure: PHOTO_FAILURES.unavailable };

  let blob: Blob;
  try { blob = await downscalePhoto(file); } catch { return { kind: 'failed', failure: PHOTO_FAILURES.badImage }; }
  if (signal?.aborted) return { kind: 'cancelled' };
  const lim = sampleLimits.get(sample);
  if (lim && ((lim.mediaTypes?.length && !lim.mediaTypes.includes(blob.type)) || (lim.maxInputBytes && blob.size > lim.maxInputBytes))) {
    return { kind: 'failed', failure: PHOTO_FAILURES.badImage };
  }

  let raw: unknown;
  try {
    raw = await sample.json(GREEN_PROMPT, { images: blob, signal });
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'cancelled') return { kind: 'cancelled' };
    return { kind: 'failed', failure: failureFor(code) };
  }
  const reading = parseGreenAnswer(raw);
  if (reading.ok) return { kind: 'mark', mark: reading.mark, note: reading.note };
  return { kind: 'failed', failure: reading.reason === 'not_found' ? PHOTO_FAILURES.notFound : PHOTO_FAILURES.badAnswer };
}

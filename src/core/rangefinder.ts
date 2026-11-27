// Flagstick rangefinder maths (plan section 12.1). Pure functions, no DOM.
//
// A flagstick of known height H that spans h pixels in a photo is at distance D = H x focalPx / h (pinhole camera).
// The focal length in pixels comes from the 35 mm-equivalent focal length: a full-frame sensor's diagonal is 43.27 mm,
// so focalPx = f35 x diagonalPx / 43.27. Using the diagonal makes this independent of orientation (portrait or
// landscape give the same diagonal) and of any proportional resize of the whole photo. It does NOT survive cropping.

/** Diagonal of a 36 x 24 mm full-frame sensor, mm. */
export const FULL_FRAME_DIAGONAL_MM = 43.27;
export const DEFAULT_FLAG_FT = 7;
export const FLAG_FT_MIN = 4;
export const FLAG_FT_MAX = 10;
/** The placement error the plus/minus assumes, image pixels per handle. */
export const PLACEMENT_ERROR_PX = 2;

/** Phone lenses he can pick when the photo carries no 35 mm-equivalent focal length. */
export const LENSES: { label: string; mm: number }[] = [
  { label: '0.5x', mm: 13 }, { label: '1x', mm: 26 }, { label: '2x', mm: 52 }, { label: '3x', mm: 77 }, { label: '5x', mm: 120 },
];

export interface Point { x: number; y: number }

/** DigitalZoomRatio at or below this counts as no zoom (phones write 1, 1.0 or 1.01; 0 means "not used"). */
export const ZOOM_NOTICE_RATIO = 1.05;

/** True when the photo says it was digitally zoomed. */
export function hasDigitalZoom(digitalZoom?: number): digitalZoom is number {
  return typeof digitalZoom === 'number' && digitalZoom > ZOOM_NOTICE_RATIO;
}

/**
 * The 35 mm-equivalent focal length to measure with. iPhones and many Android phones already fold digital zoom into
 * FocalLengthIn35mmFilm (1.5x on the 26 mm lens is written as 39 mm, with DigitalZoomRatio 1.5), so by default the
 * tag is used as written. `applyZoom` multiplies by the ratio, for a phone that leaves the zoom out; he turns it on.
 * (Plan 12.1 first said to always multiply; corrected at the T5.1 review.)
 */
export function effectiveF35(focal35: number, digitalZoom?: number, applyZoom = false): number {
  return applyZoom && hasDigitalZoom(digitalZoom) ? focal35 * digitalZoom : focal35;
}

/** Focal length in pixels for an image of `width` x `height` px. */
export function focalPx(f35: number, width: number, height: number): number {
  return (f35 * Math.hypot(width, height)) / FULL_FRAME_DIAGONAL_MM;
}

/** Pixel length between the two handles (the stick need not be exactly vertical in the frame). */
export function spanPx(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance in yards (unrounded) to a stick `flagFt` tall spanning `heightPx` in a photo with focal length `fPx`. */
export function distanceYd(flagFt: number, fPx: number, heightPx: number): number {
  return (flagFt * fPx) / heightPx / 3;
}

export type Measure =
  | { ok: true; yards: number; plusMinus: number; exact: number; focalPx: number }
  | { ok: false; reason: 'too-short' | 'bad-input' };

/**
 * The reading shown to him: whole yards, and a plus/minus from a `errPx` placement error at this handle spacing
 * (half the spread between the stick measured `errPx` shorter and `errPx` longer), at least 1 yd.
 */
export function measure(o: { flagFt: number; f35: number; width: number; height: number; heightPx: number; errPx?: number }): Measure {
  const err = o.errPx ?? PLACEMENT_ERROR_PX;
  if (!(o.flagFt > 0) || !(o.f35 > 0) || !(o.width > 0) || !(o.height > 0) || !Number.isFinite(o.heightPx)) {
    return { ok: false, reason: 'bad-input' };
  }
  if (o.heightPx <= err * 2) return { ok: false, reason: 'too-short' };
  const f = focalPx(o.f35, o.width, o.height);
  const exact = distanceYd(o.flagFt, f, o.heightPx);
  const far = distanceYd(o.flagFt, f, o.heightPx - err);
  const near = distanceYd(o.flagFt, f, o.heightPx + err);
  return { ok: true, yards: Math.round(exact), exact, plusMinus: Math.max(1, Math.round((far - near) / 2)), focalPx: f };
}

/** Flagstick height setting, kept to half feet inside the allowed range. */
export function clampFlagFt(ft: number): number {
  if (!Number.isFinite(ft)) return DEFAULT_FLAG_FT;
  return Math.min(FLAG_FT_MAX, Math.max(FLAG_FT_MIN, Math.round(ft * 2) / 2));
}

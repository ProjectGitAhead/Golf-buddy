import { afterEach, describe, expect, it, vi } from 'vitest';
import { GREEN_PROMPT, PHOTO_FAILURES, failureFor, parseGreenAnswer, prepareSample, readGreenPhoto, scaledSize } from './green';

describe('GREEN_PROMPT', () => {
  it('is self-contained: frame, scale references, the not-found rule and the JSON shape', () => {
    for (const s of ['photo of a golf green', 'RIGHT of the hole', 'BEYOND the hole', '7 ft tall', '4.25 in', '1.68 in',
      'set found to false', '"found"', '"xFt"', '"yFt"', '"onGreen"', '"confidence"', '"note"']) {
      expect(GREEN_PROMPT).toContain(s);
    }
  });
});

describe('parseGreenAnswer', () => {
  it('accepts a found ball as a photo mark', () => {
    const r = parseGreenAnswer({ found: true, xFt: -6.54, yFt: -12, onGreen: true, confidence: 0.72, note: 'Ball short left.' });
    expect(r).toEqual({ ok: true, note: 'Ball short left.', mark: { xFt: -6.5, yFt: -12, onGreen: true, source: 'photo', confidence: 0.72 } });
  });
  it('clamps distance to 150 ft and confidence to 0..1', () => {
    const r = parseGreenAnswer({ found: true, xFt: 0, yFt: 900, onGreen: false, confidence: 4 });
    expect(r.ok && r.mark).toMatchObject({ xFt: 0, yFt: 150, confidence: 1 });
  });
  it('takes numbers sent as strings and guesses onGreen from distance when missing', () => {
    const r = parseGreenAnswer({ found: 'true', xFt: '3', yFt: '-4' });
    expect(r.ok && r.mark).toEqual({ xFt: 3, yFt: -4, onGreen: true, source: 'photo' });
    const far = parseGreenAnswer({ found: true, xFt: 40, yFt: 0 });
    expect(far.ok && far.mark.onGreen).toBe(false);
  });
  it('reports found: false as not found', () => {
    expect(parseGreenAnswer({ found: false, xFt: 0, yFt: 0, note: 'No ball visible.' }))
      .toEqual({ ok: false, reason: 'not_found', note: 'No ball visible.' });
  });
  it('rejects anything else', () => {
    for (const bad of [null, 'text', [1], {}, { found: true }, { found: true, xFt: 'x', yFt: 1 }, { found: 'maybe', xFt: 1, yFt: 1 },
      { found: true, xFt: Infinity, yFt: 1 }]) {
      expect(parseGreenAnswer(bad)).toMatchObject({ ok: false, reason: 'bad_answer' });
    }
  });
});

describe('scaledSize', () => {
  it('fits the longest side to 1280 px and never upscales', () => {
    expect(scaledSize(4032, 3024)).toEqual({ width: 1280, height: 960 });
    expect(scaledSize(3024, 4032)).toEqual({ width: 960, height: 1280 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('failureFor', () => {
  it('maps codes to one line, hiding the photo button only for permanent ones', () => {
    expect(failureFor('not_granted')).toBe(PHOTO_FAILURES.declined);
    expect(failureFor('not_granted').final).toBe(true);
    expect(failureFor('images_unavailable').final).toBe(true);
    expect(failureFor('invalid_json')).toBe(PHOTO_FAILURES.badAnswer);
    expect(failureFor('rate_limited').final).toBe(false);
    expect(failureFor('something_new')).toBe(PHOTO_FAILURES.failed);
    for (const f of Object.values(PHOTO_FAILURES)) expect(f.message).toMatch(/Tap the green to place your ball\.$/);
  });
});

describe('prepareSample and readGreenPhoto without a usable capability', () => {
  afterEach(() => { delete (globalThis as { claude?: unknown }).claude; });
  const photo = new Blob(['x'], { type: 'image/jpeg' });

  it('falls back when window.claude is absent', async () => {
    expect(await prepareSample()).toBeNull();
    expect(await readGreenPhoto(photo, prepareSample())).toEqual({ kind: 'failed', failure: PHOTO_FAILURES.unavailable });
  });
  it('falls back when use("sample") resolves null or throws', async () => {
    (globalThis as { claude?: unknown }).claude = { use: async () => null };
    expect(await prepareSample()).toBeNull();
    (globalThis as { claude?: unknown }).claude = { use: async () => { throw new Error('x'); } };
    expect(await prepareSample()).toBeNull();
  });
  it('checks limits().images before anything is sent', async () => {
    const json = vi.fn();
    (globalThis as { claude?: unknown }).claude = { use: async () => ({ json, limits: async () => ({ maxPromptBytes: 1 }) }) };
    expect(await readGreenPhoto(photo, prepareSample())).toEqual({ kind: 'failed', failure: PHOTO_FAILURES.unavailable });
    expect(json).not.toHaveBeenCalled();
  });
  it('returns cancelled when stopped before the call', async () => {
    const ctl = new AbortController(); ctl.abort();
    expect(await readGreenPhoto(photo, null, ctl.signal)).toEqual({ kind: 'cancelled' });
  });
});

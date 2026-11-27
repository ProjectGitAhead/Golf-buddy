import { describe, expect, it } from 'vitest';
import { validateCourseForm } from '../ui/screens/courses-editor';
import { fitWithin } from './photo';
import { NOT_READ, parseScorecard, readScorecard, scanFailureLine, scorecardPrompt, type SampleFn } from './scorecard';

const PARS = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
const SI = [7, 3, 15, 1, 11, 9, 17, 5, 13, 8, 4, 16, 2, 12, 10, 18, 6, 14];
const SIW = [5, 3, 17, 1, 11, 9, 15, 7, 13, 6, 4, 18, 2, 12, 10, 16, 8, 14];
const YARDS = [380, 410, 165, 520, 395, 370, 180, 540, 400, 385, 420, 150, 530, 405, 360, 175, 515, 390];
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** A clean answer in the shape the prompt asks for. */
function card(over: Record<string, unknown> = {}, tee: Record<string, unknown> = {}) {
  return {
    found: true, name: 'Paradise Valley Golf Course', city: 'Fairfield', state: 'CA',
    holes: PARS.map((p, i) => ({ number: i + 1, par: p, strokeIndex: SI[i], strokeIndexW: null })),
    tees: [{ name: 'Blue', gender: 'M', rating: 71.8, slope: 133, yardages: [...YARDS],
      out: sum(YARDS.slice(0, 9)), in: sum(YARDS.slice(9)), total: sum(YARDS), ...tee }],
    ...over,
  };
}

describe('scorecard prompt', () => {
  it('is self-contained: describes the card, the JSON shape and the no-guessing rule', () => {
    const p = scorecardPrompt(2);
    expect(p).toContain('2 photos');
    for (const s of ['Par', 'HCP', '71.8/133', '"strokeIndexW"', '"yardages"', 'never guess a number', '{"found": false}']) {
      expect(p).toContain(s);
    }
    expect(scorecardPrompt(1)).toContain('a photo of');
  });
});

describe('parseScorecard', () => {
  it('turns a clean answer into an editor draft with no flags', () => {
    const r = parseScorecard(card());
    expect(r.found).toBe(true);
    expect(r.flags).toEqual({});
    expect(r.form.name).toBe('Paradise Valley Golf Course');
    expect(r.form.pars).toEqual(PARS.map(String));
    expect(r.form.si).toEqual(SI.map(String));
    expect(r.form.siW).toBeUndefined();
    expect(r.form.tees[0]).toMatchObject({ name: 'Blue', gender: 'M', rating: '71.8', slope: '133', yards: YARDS.map(String) });
    expect(r.form.verified).toBe(false);
    const v = validateCourseForm(r.form);
    expect(v.errors).toEqual({});
    expect(v.course?.tees[0].par).toBe(72);
  });

  it('flags every value that came back null, and never fills it in', () => {
    const c = card({ name: null }, { rating: null, slope: null });
    (c.holes[2] as Record<string, unknown>).par = null;
    (c.holes[4] as Record<string, unknown>).strokeIndex = null;
    (c.tees[0].yardages as (number | null)[])[6] = null;
    const r = parseScorecard(c);
    expect(r.flags['course-name-input']).toMatch(/not read/i);
    expect(r.flags['par-3']).toBe(NOT_READ);
    expect(r.flags['si-5']).toBe(NOT_READ);
    expect(r.flags['tee-0-rating']).toBe(NOT_READ);
    expect(r.flags['tee-0-slope']).toBe(NOT_READ);
    expect(r.flags['yards-0-7']).toBe(NOT_READ);
    expect(r.form.pars[2]).toBe('');
    expect(r.form.tees[0].rating).toBe('');
    // A nine with an unread hole is not compared with its printed total.
    expect(r.flags['yards-0-out']).toBeUndefined();
  });

  it('flags a par that is not 3 to 5', () => {
    const c = card();
    (c.holes[0] as Record<string, unknown>).par = 6;
    (c.holes[1] as Record<string, unknown>).par = 2;
    const r = parseScorecard(c);
    expect(r.flags['par-1']).toMatch(/Read as 6\. A par is almost always 3, 4 or 5/);
    expect(r.flags['par-2']).toMatch(/Read as 2/);
    expect(r.flags['par-3']).toBeUndefined();
  });

  it('flags stroke indexes that are not a 1-18 permutation: duplicates, missing and out of range', () => {
    const c = card();
    (c.holes[1] as Record<string, unknown>).strokeIndex = 7;   // 7 twice, 3 missing
    (c.holes[2] as Record<string, unknown>).strokeIndex = 19;  // 15 missing
    const r = parseScorecard(c);
    expect(r.flags['si-1']).toBe('Read as 7, same as hole 2. Each of 1 to 18 is used once. Missing: 3, 15.');
    expect(r.flags['si-2']).toBe('Read as 7, same as hole 1. Each of 1 to 18 is used once. Missing: 3, 15.');
    expect(r.flags['si-3']).toBe('Read as 19. A stroke index is 1 to 18.');
    expect(Object.keys(r.flags).filter((k) => k.startsWith('si-'))).toHaveLength(3);
  });

  it('reads and checks a women\'s handicap row when the card has one', () => {
    const c = card();
    c.holes.forEach((h, i) => { (h as Record<string, unknown>).strokeIndexW = SIW[i]; });
    (c.holes[17] as Record<string, unknown>).strokeIndexW = 5;  // 5 twice, 14 missing
    const r = parseScorecard(c);
    expect(r.form.siW).toHaveLength(18);
    expect(r.flags['siw-1']).toMatch(/Read as 5, same as hole 18/);
    expect(r.flags['siw-18']).toMatch(/Missing: 14\./);
    r.form.siW![17] = '14';
    const v = validateCourseForm(r.form);
    expect(v.errors).toEqual({});
    expect(v.course?.holes.map((h) => h.strokeIndexW)).toEqual(SIW);
  });

  it('flags slope outside 55-155 and rating outside 55-80', () => {
    expect(parseScorecard(card({}, { slope: 233 })).flags['tee-0-slope']).toBe('Read as 233. A slope is a whole number from 55 to 155.');
    expect(parseScorecard(card({}, { slope: 54 })).flags['tee-0-slope']).toMatch(/Read as 54/);
    expect(parseScorecard(card({}, { slope: 155 })).flags['tee-0-slope']).toBeUndefined();
    expect(parseScorecard(card({}, { rating: 7.18 })).flags['tee-0-rating']).toBe('Read as 7.18. A course rating is 55 to 80.');
    expect(parseScorecard(card({}, { rating: 80.4 })).flags['tee-0-rating']).toMatch(/Read as 80.4/);
    expect(parseScorecard(card({}, { rating: 55 })).flags['tee-0-rating']).toBeUndefined();
  });

  it('flags a yardage total that does not match the total printed on the card', () => {
    const y = [...YARDS];
    y[3] = 250;                                            // 520 misread as 250
    const r = parseScorecard(card({}, { yardages: y }));
    expect(r.flags['yards-0-out']).toBe(`Holes 1-9 add up to ${(sum(YARDS.slice(0, 9)) - 270).toLocaleString('en-US')} yards; `
      + `the card's OUT reads ${sum(YARDS.slice(0, 9)).toLocaleString('en-US')}. One hole was misread: check each against the card.`);
    expect(r.flags['yards-0-total']).toMatch(/All 18 holes add up to/);
    expect(r.flags['yards-0-in']).toBeUndefined();
    // No printed totals: nothing to compare.
    expect(parseScorecard(card({}, { yardages: y, out: null, in: null, total: null })).flags).toEqual({});
  });

  it('flags yardages outside 40-750 and tees with no name or gender', () => {
    const y = [...YARDS];
    y[0] = 3800;
    const r = parseScorecard(card({}, { yardages: y, name: '', gender: null, out: null, total: null }));
    expect(r.flags['yards-0-1']).toMatch(/Read as 3800/);
    expect(r.flags['tee-0-name']).toMatch(/not read/i);
    expect(r.flags['tee-0-gender']).toMatch(/men or women/);
  });

  it('keeps one tee per gender with its own rating, and accepts numbers sent as text', () => {
    const r = parseScorecard(card({ tees: [
      { name: 'White', gender: 'M', rating: '69.9', slope: '125', yardages: YARDS.map(String), out: '3,360', in: null, total: '6,690' },
      { name: 'White', gender: 'w', rating: 75, slope: 130, yardages: YARDS, out: null, in: null, total: null },
    ] }));
    expect(r.flags).toEqual({});
    expect(r.form.tees.map((t) => [t.name, t.gender, t.rating])).toEqual([['White', 'M', '69.9'], ['White', 'W', '75.0']]);
    expect(r.form.tees[0].id).not.toBe(r.form.tees[1].id);
  });

  it('survives junk: missing holes, wrong types and no tees all become flags', () => {
    const r = parseScorecard({ found: true, name: { evil: true }, holes: [{ number: 'x', par: 'four' }], tees: 'Blue' });
    expect(r.found).toBe(true);
    expect(r.form.pars).toHaveLength(18);
    expect(r.flags['par-1']).toBe(NOT_READ);
    expect(r.flags['par-18']).toBe(NOT_READ);
    expect(r.flags['add-tee']).toMatch(/No tee read/);
    expect(r.form.tees).toHaveLength(1);
    expect(r.form.name).toBe('');
  });

  it('reports no scorecard found', () => {
    expect(parseScorecard({ found: false }).found).toBe(false);
    expect(parseScorecard('a picture of a dog').found).toBe(false);
    expect(parseScorecard(null).found).toBe(false);
  });
});

describe('readScorecard', () => {
  const photo = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  const fake = (answer: unknown, seen: unknown[] = []): SampleFn => ({
    json: async (input, options) => { seen.push(input, options); if (answer instanceof Error) throw answer; return answer as never; },
    limits: async () => ({ images: { maxCount: 2, maxInputBytes: 1e7, mediaTypes: ['image/jpeg'] } }),
  });

  it('sends the prompt with the photos and parses the answer', async () => {
    const seen: unknown[] = [];
    const r = await readScorecard(fake(card(), seen), [photo, photo]);
    expect(seen[0]).toBe(scorecardPrompt(2));
    expect((seen[1] as { images: Blob[] }).images).toHaveLength(2);
    expect(r.form.tees[0].name).toBe('Blue');
  });

  it('rejects with not_found when the photo is not a scorecard, and passes sample errors through', async () => {
    await expect(readScorecard(fake({ found: false }), [photo])).rejects.toEqual({ code: 'not_found' });
    const failing: SampleFn = { json: () => Promise.reject({ code: 'not_granted', message: 'no' }), limits: async () => ({}) };
    await expect(readScorecard(failing, [photo])).rejects.toMatchObject({ code: 'not_granted' });
  });

  it('has one plain line for every failure', () => {
    for (const code of ['unavailable', 'images_unavailable', 'not_granted', 'rate_limited', 'not_found', 'invalid_json', 'upstream_error', undefined]) {
      const line = scanFailureLine(code);
      expect(line).toMatch(/Copy the numbers from the card/);
      expect(line.split('. ').length).toBeLessThanOrEqual(3);
    }
  });
});

describe('photo downscale size', () => {
  it('fits the long side within the limit and never upscales', () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});

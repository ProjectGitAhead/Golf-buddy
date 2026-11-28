// Course search against fixtures shaped like the OpenGolfAPI source (github.com/opengolfapi/api src/index.ts v2.0.1:
// search and state lists are `{ count, courses: golf_courses rows }`, the course is the row plus
// `scorecard: { hole_number, par, handicap_index }[]`, tees are `{ tees: golf_course_tees rows }`, holes are
// `{ holes: { hole_number, par, handicap_index, yardages, meters }[] }`). The Rancho Solano values are the open data's own
// (github.com/opengolfapi/data, opengolfapi-us.ndjson): 11 of 18 holes. No live answer was available, so the tee
// columns are the likeliest spellings and the parser reads several.
import { describe, expect, it } from 'vitest';
import { validateCourseForm } from '../ui/screens/courses-editor';
import {
  asScorecardAnswer, CourseSearchError, distanceText, draftFromCourse, loadCourse, NO_TEES, NOT_LISTED, OGA_BASE, parseCourseList,
  parseCourseRow, rewordFlag, searchByName, searchFailureLine, searchNear, statesNear, STATE_LIMIT, type CourseData,
} from './course-search';

const RANCHO_ID = '76c55499-5e08-4db3-aaa8-f97576dab4a6';
const RANCHO_ROW = {
  id: RANCHO_ID, course_name: 'Rancho Solano Golf Course', country: 'US', state: 'CA', city: 'Fairfield', course_type: 'Municipal',
  holes: 11, par_total: 72, phone: '2977414088', website: 'http://www.fairfieldgolf.com/', year_built: 1990,
  address: '3250 Rancho Solano Pkwy, Fairfield, CA 94534, USA', postal_code: '94534', latitude: 38.291069, longitude: -122.0732421,
  total_yardage: null, osm_id: null,
};
// The open data's scorecard for it, as the API's course endpoint names the columns.
const RANCHO_CARD = [[1, 5, 3], [4, 4, 13], [6, 4, 17], [7, 5, 5], [8, 3, 11], [11, 4, 2], [14, 4, 14], [15, 3, 18], [16, 4, 16], [17, 5, 12], [18, 4, 10]]
  .map(([hole_number, par, handicap_index]) => ({ hole_number, par, handicap_index }));
const PEBBLE_ROW = { id: '40977ee8-33ee-4195-b6a2-99a4ca83c2bc', course_name: 'Pebble Beach Golf Links', state: 'CA', city: 'Pebble Beach',
  latitude: 36.5607127882, longitude: -121.9295954704, par_total: 72 };

/** A course with a full card and two tees, one of them unrated: a stand-in for a well-covered course. */
const FULL: CourseData = {
  course: { id: 'full-1', name: 'Test Links', city: 'Town', state: 'CA', location: { lat: 38.5, lon: -121.5 } },
  holes: Array.from({ length: 18 }, (_, i) => ({ hole_number: i + 1, par: [4, 4, 3, 5, 4, 4, 3, 4, 5][i % 9], handicap_index: ((i * 7) % 18) + 1 })),
  tees: [
    { tee_name: 'Blue', gender: 'male', course_rating: 71.4, slope_rating: 128, total_yardage: 6500,
      yardages: Array.from({ length: 18 }, (_, i) => 300 + i * 10).map((y, i) => (i === 17 ? 6500 - (17 * 300 + 136 * 10) : y)) },
    { tee_name: 'White', gender: null, course_rating: null, slope_rating: null },
  ],
  holeYards: Array.from({ length: 18 }, (_, i) => ({ hole_number: i + 1, yardages: { White: 280 + i * 10 } })),
};

type Plan = Record<string, unknown | number | 'offline' | 'html'>;
/** A fetch answering by path (with query) from `plan`: an object is JSON 200, a number a status, 'offline' rejects. */
function api(plan: Plan) {
  const urls: string[] = [];
  const impl = ((url: string, init: RequestInit) => {
    urls.push(url);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    const u = new URL(url);
    expect(u.origin).toBe(OGA_BASE);
    const key = Object.keys(plan).find((k) => k === u.pathname + u.search || k === u.pathname);
    const how = key === undefined ? 404 : plan[key];
    if (how === 'offline') return Promise.reject(new TypeError('Load failed'));
    if (how === 'html') return Promise.resolve(new Response('<html>', { status: 200 }));
    if (typeof how === 'number') return Promise.resolve(new Response('{"error":"x"}', { status: how }));
    return Promise.resolve(new Response(JSON.stringify(how), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('reading course rows', () => {
  it('reads the API row (course_name, latitude / longitude, par_total) and the data download\'s GeoJSON feature', () => {
    expect(parseCourseRow(RANCHO_ROW)).toEqual({ id: RANCHO_ID, name: 'Rancho Solano Golf Course', city: 'Fairfield', state: 'CA',
      address: '3250 Rancho Solano Pkwy, Fairfield, CA 94534, USA', location: { lat: 38.291069, lon: -122.0732421 }, par: 72 });
    const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122.0732421, 38.291069] },
      properties: { id: RANCHO_ID, name: 'Rancho Solano Golf Course', state: 'CA', city: 'Fairfield', par: 72 } };
    expect(parseCourseRow(feature)).toMatchObject({ id: RANCHO_ID, name: 'Rancho Solano Golf Course', location: { lat: 38.291069, lon: -122.0732421 } });
  });
  it('every field but id and name is optional; bad values are dropped, not guessed', () => {
    expect(parseCourseRow({ id: 'a1', course_name: '  Spaced   Name ' })).toEqual({ id: 'a1', name: 'Spaced Name' });
    expect(parseCourseRow({ id: 'a1', course_name: 'X', latitude: 'north', longitude: 200, par_total: 7 })).toEqual({ id: 'a1', name: 'X' });
    expect(parseCourseRow({ id: 'a1', course_name: 'X', latitude: 0, longitude: 0 })).toEqual({ id: 'a1', name: 'X' });
    expect(parseCourseRow({ course_name: 'No id' })).toBeNull();
    expect(parseCourseRow({ id: '../etc', course_name: 'Bad id' })).toBeNull();
    expect(parseCourseRow('nope')).toBeNull();
  });
  it('a list is { courses } or a bare array; duplicates and unreadable rows go', () => {
    expect(parseCourseList({ count: 3, courses: [RANCHO_ROW, RANCHO_ROW, { id: 'x' }, PEBBLE_ROW] }).map((c) => c.id)).toEqual([RANCHO_ID, PEBBLE_ROW.id]);
    expect(parseCourseList([PEBBLE_ROW]).length).toBe(1);
    expect(parseCourseList({ error: 'boom' })).toEqual([]);
    expect(parseCourseList(null)).toEqual([]);
  });
});

describe('search by name', () => {
  it('asks /v1/courses/search with q and a limit, and reads the courses', async () => {
    const { impl, urls } = api({ '/v1/courses/search?q=rancho+solano&limit=25': { count: 1, courses: [RANCHO_ROW] } });
    const r = await searchByName('  rancho   solano ', { fetchImpl: impl });
    expect(urls).toEqual([`${OGA_BASE}/v1/courses/search?q=rancho+solano&limit=25`]);
    expect(r.map((c) => c.name)).toEqual(['Rancho Solano Golf Course']);
  });
  it('an empty answer is no results; under two letters asks nothing', async () => {
    const { impl, urls } = api({ '/v1/courses/search': { count: 0, courses: [] } });
    expect(await searchByName('zzzz', { fetchImpl: impl })).toEqual([]);
    expect(await searchByName('z', { fetchImpl: impl })).toEqual([]);
    expect(urls).toHaveLength(1);
  });
  it('failures carry the reason, and each has a plain line', async () => {
    const reason = async (how: unknown) => {
      const { impl } = api({ '/v1/courses/search': how });
      return searchByName('pebble', { fetchImpl: impl }).then(() => null, (e) => e as CourseSearchError);
    };
    expect((await reason('offline'))?.failure).toEqual({ kind: 'connect' });
    expect((await reason(429))?.failure).toEqual({ kind: 'limit' });
    expect((await reason(500))?.failure).toEqual({ kind: 'status', status: 500 });
    expect((await reason('html'))?.failure).toEqual({ kind: 'unreadable' });
    expect(searchFailureLine(await reason(429))).toMatch(/too many searches .* today/);
    expect(searchFailureLine(await reason(500))).toBe('The course list could not answer (status 500). Try again in a minute, or add the course by hand.');
    expect(searchFailureLine(await reason('offline'))).toBe("Couldn't reach the course list. Check that this phone is online and try again.");
  });
});

describe('near me', () => {
  it('chooses the state lists around the point', () => {
    expect(statesNear({ lat: 38.2604, lon: -122.0301 })).toEqual(['CA']);              // Fairfield
    expect(statesNear({ lat: 39.1, lon: -119.9 })).toEqual(['NV', 'CA']);              // Lake Tahoe, Nevada side
    expect(statesNear({ lat: 38.9, lon: -77.03 })[0]).toBe('DC');                      // Washington
    expect(statesNear({ lat: 51.5, lon: -0.1 })).toEqual([]);                          // London: not covered
  });
  it('asks each state for up to 500 courses and lists the near ones, nearest first, with the distance', async () => {
    const far = { ...PEBBLE_ROW };
    const near2 = { id: 'n2', course_name: 'Paradise Valley Golf Course', city: 'Fairfield', state: 'CA', latitude: 38.2706, longitude: -122.0047 };
    const { impl, urls } = api({ [`/v1/courses/state/CA?limit=${STATE_LIMIT}`]: { state: 'CA', count: 3, courses: [far, RANCHO_ROW, near2, { id: 'nl', course_name: 'No location' }] } });
    const r = await searchNear({ lat: 38.2604, lon: -122.0301 }, { fetchImpl: impl });
    expect(urls).toEqual([`${OGA_BASE}/v1/courses/state/CA?limit=500`]);
    expect(r.courses.map((c) => c.id)).toEqual(['n2', RANCHO_ID]);
    expect(r.courses[0].distanceM).toBeGreaterThan(2000);
    expect(r.courses[0].distanceM).toBeLessThan(3000);
    expect(r.capped).toEqual([]);
  });
  it('a state list that comes back full is reported, so the screen can say a course may be missing', async () => {
    const rows = Array.from({ length: STATE_LIMIT }, (_, i) => ({ id: `c${i}`, course_name: `C ${i}`, latitude: 33 + i / 1000, longitude: -117 }));
    const { impl } = api({ '/v1/courses/state/CA': { courses: rows } });
    expect((await searchNear({ lat: 38.26, lon: -122.03 }, { fetchImpl: impl })).capped).toEqual(['CA']);
  });
  it('one state failing is fine while another answers; all failing throws the reason', async () => {
    const ok = api({ '/v1/courses/state/NV': 500, '/v1/courses/state/CA': { courses: [{ ...RANCHO_ROW, latitude: 39.1, longitude: -120.0 }] } });
    expect((await searchNear({ lat: 39.1, lon: -119.9 }, { fetchImpl: ok.impl })).courses).toHaveLength(1);
    const bad = api({ '/v1/courses/state/NV': 429, '/v1/courses/state/CA': 429 });
    await expect(searchNear({ lat: 39.1, lon: -119.9 }, { fetchImpl: bad.impl })).rejects.toMatchObject({ failure: { kind: 'limit' } });
  });
  it('distances read in yards under a mile, then miles', () => {
    expect(distanceText(400)).toBe('440 yd');
    expect(distanceText(2400)).toBe('1.5 mi');
    expect(distanceText(40000)).toBe('25 mi');
  });
});

describe('one course to an editor draft', () => {
  it('asks for the course, its tees and its holes; only the course is required', async () => {
    const { impl, urls } = api({ [`/v1/courses/${RANCHO_ID}`]: { ...RANCHO_ROW, scorecard: RANCHO_CARD },
      [`/v1/courses/${RANCHO_ID}/tees`]: 500, [`/v1/courses/${RANCHO_ID}/holes`]: 'offline' });
    const d = await loadCourse(RANCHO_ID, { fetchImpl: impl });
    expect(urls.sort()).toEqual([`${OGA_BASE}/v1/courses/${RANCHO_ID}`, `${OGA_BASE}/v1/courses/${RANCHO_ID}/holes`, `${OGA_BASE}/v1/courses/${RANCHO_ID}/tees`]);
    expect(d.holes).toHaveLength(11);
    expect(d.tees).toEqual([]);
    const bad = api({ [`/v1/courses/${RANCHO_ID}`]: 404 });
    await expect(loadCourse(RANCHO_ID, { fetchImpl: bad.impl })).rejects.toMatchObject({ failure: { kind: 'status', status: 404 } });
  });

  it('Rancho Solano from the open data: 11 holes filled, the other 7 and every tee value flagged, nothing invented', () => {
    const { form, flags } = draftFromCourse({ course: parseCourseRow(RANCHO_ROW)!, holes: RANCHO_CARD, tees: [], holeYards: [] });
    expect(form.name).toBe('Rancho Solano Golf Course');
    expect([form.city, form.state]).toEqual(['Fairfield', 'CA']);
    expect(form.location).toEqual({ lat: 38.291069, lon: -122.0732421 });
    expect(form.verified).toBe(false);
    expect(form.pars).toEqual(['5', '', '', '4', '', '4', '5', '3', '', '', '4', '', '', '4', '3', '4', '5', '4']);
    expect(form.si[0]).toBe('3');
    for (const h of [2, 3, 5, 9, 10, 12, 13]) {
      expect(flags[`par-${h}`]).toBe(NOT_LISTED);
      expect(flags[`si-${h}`]).toBe(NOT_LISTED);
    }
    expect(flags['par-1']).toBeUndefined();
    // No tees in the data: one blank tee, flagged, with no rating, slope or yardage made up.
    expect(form.tees).toHaveLength(1);
    expect([form.tees[0].rating, form.tees[0].slope, ...form.tees[0].yards].every((v) => v === '')).toBe(true);
    expect(flags['add-tee']).toBeUndefined();
    expect(flags['tee-0-name']).toBe(NO_TEES);
    expect([flags['tee-0-rating'], flags['tee-0-slope'], flags['yards-0-1'], flags['yards-0-18']]).toEqual(Array(4).fill(NOT_LISTED));
    expect(form.sources?.[0]).toContain('OpenGolfAPI');
    expect(form.sources?.[0]).toBe(`OpenGolfAPI (opengolfapi.org, ODbL), course ${RANCHO_ID}`);
    expect(Object.values(flags).some((m) => /photo/i.test(m))).toBe(false);
  });

  it('a well-covered course: tee values filled where present, the unrated tee kept with rating and slope flagged', () => {
    const { form, flags } = draftFromCourse(FULL);
    expect(form.pars.every((p) => p !== '')).toBe(true);
    expect(form.tees.map((t) => [t.name, t.gender, t.rating, t.slope])).toEqual([['Blue', 'M', '71.4', '128'], ['White', 'M', '', '']]);
    expect(form.tees[0].yards[0]).toBe('300');
    expect(form.tees[1].yards[0]).toBe('280');              // from the holes endpoint, matched by tee name
    expect(flags['tee-1-rating']).toBe(NOT_LISTED);
    expect(flags['tee-1-slope']).toBe(NOT_LISTED);
    expect(flags['tee-1-gender']).toMatch(/^The course data does not say/);
    expect(Object.keys(flags).filter((k) => k.startsWith('tee-0') || k.startsWith('yards-0'))).toEqual([]);
    expect(Object.keys(flags).filter((k) => k.startsWith('par-') || k.startsWith('si-'))).toEqual([]);
    // Once he types the two values, the form saves as a course with its location kept.
    const typed = { ...form, tees: form.tees.map((t, k) => (k === 1 ? { ...t, rating: '69.8', slope: '121' } : t)) };
    const v = validateCourseForm(typed);
    expect(v.errors).toEqual({});
    expect(v.course?.location).toEqual(FULL.course.location);
    expect(v.course?.sources).toEqual(form.sources);
  });

  it('values the checks catch are flagged with what the data says', () => {
    const d: CourseData = { ...FULL, holes: FULL.holes.map((h, i) => (i === 0 ? { ...h, par: 7 } : i === 1 ? { ...h, handicap_index: 1 } : h)),
      tees: [{ ...FULL.tees[0], slope_rating: 190, total_yardage: 6000 }] };
    const { flags } = draftFromCourse(d);
    expect(flags['par-1']).toBe('Listed as 7. A par is almost always 3, 4 or 5: check the card.');
    expect(flags['si-2']).toMatch(/^Listed as 1, same as hole/);
    expect(flags['tee-0-slope']).toBe('Listed as 190. A slope is a whole number from 55 to 155.');
    expect(flags['yards-0-total']).toBe("All 18 holes add up to 6,500 yards; the listed total is 6,000. Check each hole against the card.");
  });

  it('tolerates other spellings and the flat hole_N_par columns', () => {
    const answer = asScorecardAnswer({ course: { id: 'x', name: 'X' }, holes: [{ hole: 3, par: '4', hcp: '9' }],
      tees: [{ name: 'Red', sex: 'F', rating: '68.2', slope: '115', hole_1_yardage: 250 }], holeYards: [] });
    expect(answer.holes).toEqual([{ number: 3, par: 4, strokeIndex: 9 }]);
    expect(answer.tees).toEqual([expect.objectContaining({ name: 'Red', gender: 'W', rating: 68.2, slope: 115 })]);
    expect((answer.tees as { yardages: (number | null)[] }[])[0].yardages[0]).toBe(250);
  });

  it('every scan reason is reworded for course data', () => {
    expect(rewordFlag('Not read from the photo. Copy it from the card.')).toBe(NOT_LISTED);
    expect(rewordFlag('Course name not read from the photo. Type it in.')).toBe('The course data has no name. Type it in.');
    expect(rewordFlag('Tee name not read from the photo.')).toBe('The course data has no name for this tee.');
    expect(rewordFlag('Read as 81. A course rating is 55 to 80.')).toBe('Listed as 81. A course rating is 55 to 80.');
  });
});

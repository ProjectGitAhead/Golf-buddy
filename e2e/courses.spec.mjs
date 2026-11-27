// Courses: the unverified note, adding a course by hand, editing a course without changing a posted round, and
// no horizontal scroll at 360 px on every screen, light and dark.
import { assert, eq, newPage, noHorizontalScroll, rancho, startRound, text } from './lib.mjs';

const stored = (page) => page.evaluate(() =>
  JSON.parse(localStorage.getItem('golf-buddy:v1') ?? 'null')?.data ?? { courses: {}, rounds: {} });

export default async function ({ browser, baseURL }) {
  const { page, context, errors } = await newPage(browser, baseURL, { width: 360 });
  try {
    await noHorizontalScroll(page, 'play start');
    // Rancho Solano ships unverified.
    await page.click('#tab-courses');
    await noHorizontalScroll(page, 'courses list');
    await page.click('#course-rancho-solano');
    assert(await page.isVisible('#course-unverified'), 'unverified course shows the check-the-card note');
    eq(await text(page, '#course-unverified'), 'Check these numbers against the card. Fix anything that differs with Edit.', 'note copy');
    await noHorizontalScroll(page, 'course detail');

    // Add a course by hand. Saving an empty form shows the problems and saves nothing.
    await page.click('#courses-back');
    await page.click('#add-course');
    await page.click('#save-course');
    assert(await page.isVisible('#editor-errors'), 'errors shown for an empty form');
    eq(Object.keys((await stored(page)).courses).length, 0, 'nothing saved from an invalid form');
    await noHorizontalScroll(page, 'course editor');
    await page.fill('#course-name-input', 'Paradise Valley');
    await page.fill('#course-city', 'Fairfield');
    await page.fill('#tee-0-name', 'Blue');
    await page.fill('#tee-0-rating', '69.5');
    await page.fill('#tee-0-slope', '125');
    const pars = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
    for (let i = 0; i < 18; i++) {
      await page.fill(`#par-${i + 1}`, String(pars[i]));
      await page.fill(`#si-${i + 1}`, String(i + 1));
      await page.fill(`#yards-0-${i + 1}`, String(pars[i] * 95));
    }
    await page.fill('#si-2', '1');                       // duplicate stroke index is refused
    await page.click('#save-course');
    assert(await page.isVisible('#editor-errors'), 'duplicate stroke index refused');
    await page.fill('#si-2', '2');
    await page.click('#save-course');
    await page.waitForSelector('#course-detail');
    eq(await text(page, '#course-name'), 'Paradise Valley', 'new course detail');
    const added = Object.values((await stored(page)).courses)[0];
    eq(added.tees[0].par, 72, 'tee par is the sum of hole pars');
    eq(added.holes[1].strokeIndex, 2, 'stroke index saved');
    await page.click('#courses-back');
    eq(await page.locator('#course-list li').count(), 2, 'list shows the bundled and the added course');

    // Post a quick round at Rancho Solano (par on every hole), then edit the course.
    await startRound(page, { teeId: 'white-m' });
    await noHorizontalScroll(page, 'hole screen');
    for (let i = 0; i < 18; i++) {
      await page.click('#stroke-value');
      if (i < 17) await page.click('#hole-next');
    }
    await page.click('#finish-round');
    await noHorizontalScroll(page, 'finish');
    const diffBefore = await text(page, '#finish-differential');
    await page.click('#post-round');
    await page.click('#posted-done');

    await page.click('#tab-courses');
    await page.click('#course-rancho-solano');
    await page.click('#edit-course');
    await page.fill('#par-1', '4');                       // hole 1 is a par 5 on the bundled card
    await page.fill('#tee-1-rating', '71.0');             // white tee (second on the card)
    await page.check('#course-verified');
    await page.click('#save-course');
    await page.waitForSelector('#course-detail');
    assert(!(await page.isVisible('#course-unverified')), 'verified course hides the note');
    const data = await stored(page);
    eq(data.courses['rancho-solano'].holes[0].par, 4, 'edited par saved');
    eq(data.courses['rancho-solano'].tees.find((t) => t.id === 'white-m').rating, 71, 'edited rating saved');
    const round = Object.values(data.rounds)[0];
    eq(round.snapshot.holes[0].par, rancho.holes[0].par, 'posted round keeps its snapshot par');
    eq(round.snapshot.rating, 70, 'posted round keeps its snapshot rating');

    await page.click('#tab-handicap');
    const row = (await page.locator('#posted-rounds li').first().textContent()) ?? '';
    assert(row.includes(`Differential ${diffBefore}`), `posted differential unchanged after the edit: ${row}`);
    await noHorizontalScroll(page, 'handicap');
    await page.click('#tab-shots');
    await noHorizontalScroll(page, 'shots');

    // Restoring the shipped numbers removes the edit.
    await page.click('#tab-courses');
    await page.click('#course-rancho-solano');
    await page.click('#remove-course');
    await page.click('#remove-course-yes');
    assert(await page.isVisible('#course-unverified'), 'restored course is unverified again');
    eq((await stored(page)).courses['rancho-solano'], undefined, 'user copy removed');
    eq(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }

  // Dark theme at 360 px: no horizontal scroll and the theme tokens apply.
  const dark = await newPage(browser, baseURL, { width: 360, dark: true });
  try {
    const bg = await dark.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    eq(bg, 'rgb(11, 17, 13)', 'dark body background');
    await noHorizontalScroll(dark.page, 'dark play start');
    await startRound(dark.page);
    await noHorizontalScroll(dark.page, 'dark hole screen');
  } finally {
    await dark.context.close();
  }
}

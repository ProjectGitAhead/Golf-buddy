# Golf Buddy v1: run sheet and task cards

## Run charter (approved 2026-11-27, in the owner's kickoff message)
Goal / done / out of scope: plan `plans/golf-buddy-v1.md` sections 1.
Builds on: empty repo (README only). Must not undo: nothing.
Access: repo `ProjectGitAhead/Golf-buddy`, branch `claude/vigilant-curie-yjgzl8`; Artifact publishing (private);
web search for course data. Off limits: `casino-stream-hub`, any paid run, anything sent or posted in the
owner's name. Secrets: none needed.
Models: overseer writes plan and cards and reviews · builder = `opus` · light = `sonnet` · reviewer = `opus`.
Autonomy: 3 (full run). Owner: "Work all the way through without approval. I gave you pre-approval for
everything until finished." Publishing the private artifact is included; merging the PR is left to the owner.
Limits: spend none. Review: the live artifact on his phone, plus the draft PR.

## Run sheet
- One checkout: `/home/user/Golf-buddy`, branch `claude/vigilant-curie-yjgzl8`. Parallel executors share it and
  own disjoint files (see each card's Files line).
- Ports: executor A preview 4610, executor B preview 4620. Overseer gate 4630.
- Review folder: `/tmp/claude-0/-home-user/24fc6364-1d94-5479-9217-f29e60caeeeb/scratchpad/review/<task>/`.
- Gate per task: `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e` (once it exists), fragment
  checks (no doctype / external URLs, size), one phone-width screenshot of changed screens.
- Status: T1.1 … T4.1 below; boxes ticked by the overseer only.

## Phase 1: foundations (T1.1 and T1.2 in parallel)

### T1.1 Project scaffold and WHS handicap engine
**Description:** Create the project (plan section 3): package.json scripts, tsconfig, esbuild build script that
emits `dist/golf-buddy.html` (fragment) and `dist/preview.html`, a placeholder `src/ui/app.tsx` that renders the
app name, `src/core/types.ts` exactly as plan section 4, and `src/core/handicap.ts` implementing every rule in
plan section 5 with vitest tests.
**Acceptance:**
- [x] `npm run typecheck`, `npm test`, `npm run build` all exit 0
- [x] `dist/golf-buddy.html` starts with `<title>Golf Buddy</title>`, has no doctype/html/head/body tags and no `http(s)://` URL
- [x] Tests cover: course handicap (18 and 9, plus handicap), stroke allocation (CH 0, 9, 18, 27, 40, -2; 9-hole re-rank), net double bogey and the par+5 rule, 18-hole differential, 9-hole differential with expected score, every row of the index table, rounding of negatives, exceptional score -1 and -2, soft cap, hard cap, max 54.0, imported differentials, `targetScore`
- [x] At least one test replays a 20+ round history end to end through `computeHistory`
**Verification:** [x] `npm test` · [x] `npm run typecheck` · [x] `npm run build`
**Dependencies:** none · **Files:** package.json, package-lock.json, tsconfig.json, .gitignore, scripts/build.mjs, src/core/types.ts, src/core/handicap.ts, src/core/handicap.test.ts, src/ui/app.tsx, src/main.tsx, dist/ · **Size:** M
**Risk:** none (the maths is checked by the overseer with independent worked examples) · **Screens:** none

### T1.2 Rancho Solano course data
**Description:** Research Rancho Solano Golf Course (Fairfield, California) and write
`src/data/courses/rancho-solano.json` to the `Course` type in plan section 4, following plan section 10. Use web
search; prefer the USGA course rating database (ncrdb.usga.org) and the course's own scorecard.
**Acceptance:**
- [x] Valid JSON matching `Course`: 18 holes, every tee has 18 yardages, pars sum to each tee's par, stroke indexes are a permutation of 1-18
- [x] Every tee the course lists is present with rating and slope; `sources` lists the URLs used
- [x] `verified` set by the rule in plan section 10; the report states plainly which values are confirmed by two sources and which are not
**Verification:** [x] a node one-liner in the report that checks the sums and the permutation
**Dependencies:** none · **Files:** src/data/courses/rancho-solano.json · **Size:** S
**Risk:** none · **Screens:** none

## Checkpoint 1
- [x] Gate green for T1.1 and T1.2 · [x] overseer's own worked WHS examples agree with the engine · [x] pushed

## Phase 2: the app

### T2.1 App shell, storage, courses and the round flow
**Description:** Build plan sections 2 (page contract), 6 (storage), and from section 7 the tab shell, the Play
screen in full (start round, hole entry, finish, post), and the Courses list / detail / hand editor. The
"Mark approach" button and "Scan a scorecard" are not in this card. Add `src/data/courses/index.ts`, and
Playwright e2e against `dist/preview.html`.
**Acceptance:**
- [ ] On a 390 px wide viewport: start a round at Rancho Solano, enter 18 holes, finish, post; the round shows as posted and survives a reload (localStorage path)
- [ ] The hole header shows par, yards, stroke index, strokes received and the hole maximum; totals and to-par update as scores change
- [ ] With `window.claude` absent the app works fully; with a mocked `claude.use('db')` (e2e) rounds are written under `data/users/<id>/rounds/<roundId>` and merged on load by `updatedAt`
- [ ] A course can be added and edited by hand; editing a course does not change a posted round (snapshot)
- [ ] No horizontal scroll at 360 px; light and dark both legible; fragment rules of plan section 2 hold; `dist/golf-buddy.html` under 1 MB
**Verification:** [ ] `npm run typecheck` · [ ] `npm test` · [ ] `npm run build` · [ ] `npm run e2e` (specs: round-flow, storage-sync, courses)
**Dependencies:** T1.1, T1.2 · **Files:** src/ui/**, src/store/**, src/data/courses/index.ts, src/main.tsx, scripts/build.mjs, e2e/**, playwright.config.mjs, package.json, dist/ · **Size:** M (large M; do not split further, the pieces share one shell)
**Risk:** none · **Screens:** play-start, play-hole, play-finish, courses, course-detail

### T2.2 Handicap screen, history and stats
**Description:** Plan section 7 Handicap and the stats half of Shots: index, low index, sparkline, last 20 with
counting scores marked, round detail with reopen / edit / delete (in-page confirm), "Add past score", starting
index in profile, "How this is calculated", target score on the start-round sheet, and `src/core/stats.ts`
(fairways, GIR, putts, scoring by par) with tests.
**Acceptance:**
- [ ] After 3 posted rounds the index shown equals `computeHistory`'s; before that the starting index (if set) is shown and labelled
- [ ] Counting scores are marked; deleting or editing a round recalculates everything
- [ ] Imported differentials can be added and removed and take part in the calculation
- [ ] The unofficial-index note and the 9-hole approximation note are present and accurate
**Verification:** [ ] `npm test` (stats.test.ts) · [ ] `npm run e2e` (spec: handicap) · [ ] typecheck · [ ] build
**Dependencies:** T2.1 · **Files:** src/ui/screens/handicap*.tsx, src/ui/screens/shots*.tsx, src/ui/components/**, src/core/stats.ts, src/core/stats.test.ts, src/ui/styles.css, e2e/handicap.spec.mjs, dist/ · **Size:** M
**Risk:** none · **Screens:** handicap, handicap-detail, shots-stats

## Checkpoint 2
- [ ] Gate green · [ ] artifact published and the link given to the owner · [ ] pushed, draft PR open

## Phase 3: the two signature features (T3.1 and T3.2 in parallel after T2.1)

### T3.1 Green photo and approach heat map
**Description:** Plan section 8: the "Mark approach" sheet on the hole screen (manual placement and photo via
`sample` with images), `src/vision/green.ts`, `src/core/approach.ts` (density grid, miss-pattern summary) with
tests, and the heat map on the Shots screen with its filters.
**Acceptance:**
- [ ] Manual: tap places the ball, drag moves it, the saved mark's `xFt` / `yFt` match the tap within 1 ft (e2e)
- [ ] Photo: with a mocked `sample.json` returning a mark, the suggestion appears, can be dragged, and saves with `source: 'photo'`; with `sample` null, rejected, or `found: false`, the sheet falls back to manual with one line of explanation and no retry loop
- [ ] Heat map renders marks from posted and active rounds; filters change the set; the summary lines are computed and appear only from 5 marks
- [ ] The photo is downscaled before sending and is not stored anywhere
**Verification:** [ ] `npm test` (approach.test.ts, green.test.ts) · [ ] `npm run e2e` (spec: approach) · [ ] typecheck · [ ] build
**Dependencies:** T2.1 · **Files:** src/vision/green.ts, src/vision/green.test.ts, src/core/approach.ts, src/core/approach.test.ts, src/ui/components/green-sheet.tsx, src/ui/components/heatmap.tsx, src/ui/screens/shots*.tsx (heat map section only), src/ui/screens/play*.tsx (the button and sheet hook only), src/ui/styles.css (one block at the end), e2e/approach.spec.mjs, dist/ · **Size:** M
**Risk:** none · **Screens:** green-sheet, shots-heatmap

### T3.2 Scorecard scan
**Description:** Plan section 9: "Scan a scorecard" in Courses, `src/vision/scorecard.ts` (prompt, parsing,
validation) with tests, result opened in the existing editor with the checks highlighted.
**Acceptance:**
- [ ] With a mocked `sample.json` returning a course, the editor opens pre-filled and marked "Check against the card"; nothing is saved before Save
- [ ] Each validation in plan section 9 has a unit test and a visible highlight
- [ ] With `sample` unavailable or failing, one plain line explains it and the hand editor opens empty
**Verification:** [ ] `npm test` (scorecard.test.ts) · [ ] `npm run e2e` (spec: scorecard) · [ ] typecheck · [ ] build
**Dependencies:** T2.1 · **Files:** src/vision/scorecard.ts, src/vision/scorecard.test.ts, src/ui/screens/courses*.tsx, src/ui/styles.css (one block at the end), e2e/scorecard.spec.mjs, dist/ · **Size:** S
**Risk:** none · **Screens:** course-scan-result

## Checkpoint 3
- [ ] Gate green on the combined tip · [ ] code reviewer on the whole diff; critical / high fixed · [ ] artifact republished · [ ] one functional read of the artifact's db · [ ] pushed, PR updated

## Phase 4

### T4.1 README (light)
**Description:** Replace README.md: what the app is, the commands, how it is published, where the handicap
rules live, the known approximations. Under 60 lines.
**Acceptance:**
- [ ] Commands in the README run as written
**Verification:** [ ] run each command once
**Dependencies:** T3.x · **Files:** README.md · **Size:** S · **Risk:** none · **Screens:** none

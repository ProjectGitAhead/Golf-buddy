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
- Status (2026-11-27): every card T1.1-T5.2 built and gated (166 unit tests, 9 e2e specs). Artifact live at version 6. Hosted copy now deploys to Fly.io from GitHub Actions (T5.3; nginx image and the deploy itself not run anywhere yet). Waiting on the owner: add the FLY_API_TOKEN repo secret and merge PR #1. Unverified on a real phone: db sync, photo reading, camera EXIF, GPS. Review findings not fixed (low, and M4 unconfirmed): see scratchpad review/checkpoint3-code-review.txt; tombstones are never pruned.

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
- [x] On a 390 px wide viewport: start a round at Rancho Solano, enter 18 holes, finish, post; the round shows as posted and survives a reload (localStorage path)
- [x] The hole header shows par, yards, stroke index, strokes received and the hole maximum; totals and to-par update as scores change
- [x] With `window.claude` absent the app works fully; with a mocked `claude.use('db')` (e2e) rounds are written under `data/users/<id>/rounds/<roundId>` and merged on load by `updatedAt`
- [x] A course can be added and edited by hand; editing a course does not change a posted round (snapshot)
- [x] No horizontal scroll at 360 px; light and dark both legible; fragment rules of plan section 2 hold; `dist/golf-buddy.html` under 1 MB
**Verification:** [x] `npm run typecheck` · [x] `npm test` · [x] `npm run build` · [x] `npm run e2e` (specs: round-flow, storage-sync, courses)
**Dependencies:** T1.1, T1.2 · **Files:** src/ui/**, src/store/**, src/data/courses/index.ts, src/main.tsx, scripts/build.mjs, e2e/**, playwright.config.mjs, package.json, dist/ · **Size:** M (large M; do not split further, the pieces share one shell)
**Risk:** none · **Screens:** play-start, play-hole, play-finish, courses, course-detail

### T2.2 Handicap screen, history and stats
**Description:** Plan section 7 Handicap and the stats half of Shots: index, low index, sparkline, last 20 with
counting scores marked, round detail with reopen / edit / delete (in-page confirm), "Add past score", starting
index in profile, "How this is calculated", target score on the start-round sheet, and `src/core/stats.ts`
(fairways, GIR, putts, scoring by par) with tests.
**Acceptance:**
- [x] After 3 posted rounds the index shown equals `computeHistory`'s; before that the starting index (if set) is shown and labelled
- [x] Counting scores are marked; deleting or editing a round recalculates everything
- [x] Imported differentials can be added and removed and take part in the calculation
- [x] The unofficial-index note and the 9-hole approximation note are present and accurate
**Verification:** [x] `npm test` (stats.test.ts) · [x] `npm run e2e` (spec: handicap) · [x] typecheck · [x] build
**Dependencies:** T2.1 · **Files:** src/ui/screens/handicap*.tsx, src/ui/screens/shots*.tsx, src/ui/components/**, src/core/stats.ts, src/core/stats.test.ts, src/ui/styles.css, e2e/handicap.spec.mjs, dist/ · **Size:** M
**Risk:** none · **Screens:** handicap, handicap-detail, shots-stats

## Checkpoint 2
- [x] Gate green · [x] artifact published and the link given to the owner · [x] pushed, draft PR open

## Phase 3: the two signature features (T3.1 and T3.2 in parallel after T2.1)

### T3.1 Green photo and approach heat map
**Description:** Plan section 8: the "Mark approach" sheet on the hole screen (manual placement and photo via
`sample` with images), `src/vision/green.ts`, `src/core/approach.ts` (density grid, miss-pattern summary) with
tests, and the heat map on the Shots screen with its filters.
**Acceptance:**
- [x] Manual: tap places the ball, drag moves it, the saved mark's `xFt` / `yFt` match the tap within 1 ft (e2e)
- [x] Photo: with a mocked `sample.json` returning a mark, the suggestion appears, can be dragged, and saves with `source: 'photo'`; with `sample` null, rejected, or `found: false`, the sheet falls back to manual with one line of explanation and no retry loop
- [x] Heat map renders marks from posted and active rounds; filters change the set; the summary lines are computed and appear only from 5 marks
- [x] The photo is downscaled before sending and is not stored anywhere
**Verification:** [x] `npm test` (approach.test.ts, green.test.ts) · [x] `npm run e2e` (spec: approach) · [x] typecheck · [x] build
**Dependencies:** T2.1 · **Files:** src/vision/green.ts, src/vision/green.test.ts, src/core/approach.ts, src/core/approach.test.ts, src/ui/components/green-sheet.tsx, src/ui/components/heatmap.tsx, src/ui/screens/shots*.tsx (heat map section only), src/ui/screens/play*.tsx (the button and sheet hook only), src/ui/styles.css (one block at the end), e2e/approach.spec.mjs, dist/ · **Size:** M
**Risk:** none · **Screens:** green-sheet, shots-heatmap

### T3.2 Scorecard scan
**Description:** Plan section 9: "Scan a scorecard" in Courses, `src/vision/scorecard.ts` (prompt, parsing,
validation) with tests, result opened in the existing editor with the checks highlighted.
**Acceptance:**
- [x] With a mocked `sample.json` returning a course, the editor opens pre-filled and marked "Check against the card"; nothing is saved before Save
- [x] Each validation in plan section 9 has a unit test and a visible highlight
- [x] With `sample` unavailable or failing, one plain line explains it and the hand editor opens empty
**Verification:** [x] `npm test` (scorecard.test.ts) · [x] `npm run e2e` (spec: scorecard) · [x] typecheck · [x] build
**Dependencies:** T2.1 · **Files:** src/vision/scorecard.ts, src/vision/scorecard.test.ts, src/ui/screens/courses*.tsx, src/ui/styles.css (one block at the end), e2e/scorecard.spec.mjs, dist/ · **Size:** S
**Risk:** none · **Screens:** course-scan-result

## Checkpoint 3
- [x] Gate green on the combined tip · [x] code reviewer on the whole diff; critical / high fixed · [x] artifact republished · [x] one functional read of the artifact's db · [x] pushed, PR updated

## Phase 4

### T4.1 README (light)
**Description:** Replace README.md: what the app is, the commands, how it is published, where the handicap
rules live, the known approximations. Under 60 lines.
**Acceptance:**
- [x] Commands in the README run as written
**Verification:** [x] run each command once
**Dependencies:** T3.x · **Files:** README.md · **Size:** S · **Risk:** none · **Screens:** none

## Phase 5: distance finder (added at the owner's request)

### T5.1 Distance finder: flagstick rangefinder and GPS
**Description:** Plan section 12: a "Distance" button on the hole screen opening a sheet with the flagstick
rangefinder (12.1) and, where location is granted, GPS distance to a learned green and shot measuring (12.2).
**Acceptance:**
- [x] Rangefinder: with a test JPEG carrying EXIF (generated in the e2e), placing the handles gives the expected yards within 1 yd; without EXIF the lens picker appears and the result is labelled approximate
- [x] Handles can be placed precisely on a phone: pinch or button zoom, pan, and a loupe while dragging (e2e drags; overseer looks at the screenshots)
- [x] `rangefinder.ts`, `exif.ts`, `geo.ts` unit-tested (worked examples, both orientations, digital zoom, big- and little-endian EXIF, missing tags)
- [x] GPS: with geolocation mocked (Playwright permission + position), saving a green then moving shows the right yards; shot measure shows the walked distance; with geolocation refused, the one-line explanation shows and nothing loops
- [x] Nothing calls geolocation or opens the camera before a tap; the photo is not stored; fragment rules still hold
**Verification:** [x] `npm test` (rangefinder, exif, geo) · [x] `npm run e2e` (spec: distance) · [x] typecheck · [x] build
**Dependencies:** T2.1 · **Files:** src/core/rangefinder.ts, src/core/exif.ts, src/core/geo.ts (+ tests), src/core/types.ts (two optional fields only), src/ui/components/distance-sheet.tsx, src/ui/screens/play-hole.tsx (the button and sheet hook only), src/ui/styles.css (one block at the end), e2e/distance.spec.mjs · **Size:** M
**Risk:** none · **Screens:** distance-rangefinder, distance-gps

### T5.2 Hosted copy on GitHub Pages
**Description:** Plan section 13: `dist/site/` output (full page, manifest, icons, service worker) and the Pages
workflow.
**Acceptance:**
- [x] `npm run build` writes `dist/site/index.html`, `manifest.webmanifest`, three icons and `sw.js`; `dist/golf-buddy.html` is unchanged in rules (fragment spec still passes, no service worker text in it)
- [x] Served from a sub-path (`/Golf-buddy/`), the site loads, registers the worker, and loads again with the network cut (e2e, Playwright offline mode)
- [x] The workflow file is valid (parsed with a YAML parser in the report) and uses only the steps in plan section 13
- [x] Storage note on the Handicap screen is true in both contexts
**Verification:** [x] `npm run e2e` (spec: site) · [x] typecheck · [x] `npm test` · [x] build
**Dependencies:** T5.1 merged · **Files:** scripts/build.mjs, scripts/site/** (wrapper, sw template, icon svg), .github/workflows/pages.yml, e2e/site.spec.mjs, e2e runner (sub-path serving only), src/ui/screens/handicap.tsx (the storage note only), README.md (a "Hosted copy" section), dist/ · **Size:** M
**Risk:** none (public site: confirm no personal data in the build) · **Screens:** none

### T5.3 Deploy the hosted copy to Fly.io from GitHub Actions (light)
**Description:** Plan section 14: `fly.toml`, `Dockerfile`, `deploy/nginx.conf`, `.dockerignore`,
`.github/workflows/fly.yml`; switch `pages.yml` to manual dispatch only; README "Hosted copy" section updated.
**Acceptance:**
- [x] `fly.toml` parses as TOML and `fly.yml` / `pages.yml` parse as YAML; contents match plan section 14
- [x] `nginx.conf` is syntax-checked (`nginx -t` in a container if docker is available, otherwise stated as not checked) and serves `dist/site` on 8080 with the headers listed
- [x] The existing gate still passes (typecheck, tests, build, 9 e2e specs)
- [x] README states the owner's three steps and the site URL
**Verification:** [x] parsers · [x] gate
**Dependencies:** T5.2 · **Files:** fly.toml, Dockerfile, .dockerignore, deploy/nginx.conf, .github/workflows/fly.yml, .github/workflows/pages.yml, README.md · **Size:** S · **Risk:** none · **Screens:** none

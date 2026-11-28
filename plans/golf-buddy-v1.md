# Golf Buddy v1: personal handicap app (plan)

Owner: Skyler. Written 2026-11-27 by the overseer. Task cards: `plans/golf-buddy-v1-todo.md`.

## 1. Goal

A phone app Skyler can use during the round he is about to play: record every hole, keep a running Handicap Index
by the real World Handicap System (WHS) rules, carry full course data (starting with Rancho Solano, Fairfield CA;
the owner said "Rancho Solana"), and two features of its own: a green photo that becomes an approach heat map, and
a scorecard photo that imports any course.

Done = the app is published as a private Claude Artifact he opens on his phone, his data survives reloads, and the
handicap maths is covered by tests against worked WHS examples.

Out of scope for v1: accounts or sharing, GPS distances, official GHIN posting (the app's index is unofficial; say
so once on the Handicap screen), playing-handicap allowances for match formats, a native app.

## 2. How it reaches the phone

The app is one self-contained HTML fragment published with the Artifact tool (private page on claude.ai, opens in
the Claude phone app or a browser). The overseer publishes; executors only build `dist/golf-buddy.html`.

Runtime capabilities declared at publish: `{ db: {}, user: {}, sample: { images: true } }`.
- `db`: durable storage, private per person under `data/users/<userId>/…`.
- `sample` with images: the page asks Claude to read a photo (green photo, scorecard photo).
- No camera capability exists: photos come from `<input type="file" accept="image/*" capture="environment">`.

Type definitions (authoritative, read before calling a capability):
`/tmp/claude-0/bundled-skills/2.1.332/4c61d6ba5288351f050125b297e0eab3/artifact-capabilities/0.2.99/`
(`claude.d.ts`, `db.d.ts`, `sample.d.ts`, `user.d.ts`).

### Artifact page contract (every UI task obeys this)
- `dist/golf-buddy.html` is a fragment: starts with `<title>Golf Buddy</title>` and
  `<meta name="claude:viewport-fit-sides" content="cover">`, then one `<style>`, markup, one `<script>`.
  No doctype, `<html>`, `<head>` or `<body>` tags. Everything inlined; no external requests at all (no CDN, no
  fonts host, no fetch). Use a system font stack. Under 1 MB.
- Capabilities only through `const x = await window.claude?.use?.("db")`; it resolves `null` (or `claude` is
  absent, as in local preview) and the app must work fully without it. Never block first paint on it. The first
  capability call can show a consent prompt, so call `sample` only from a tap.
- `alert/confirm/prompt` do nothing: confirmations are in-page. No `<a download>`, no service worker, no
  `window.print`, no `mailto:`. Routing only by plain `#name` hashes (ASCII letters, digits, hyphens; not
  `settings`, `sidebar`, `customize`, `upgrade`, `downloads`, `comment-*`), or keep view state in memory.
- Theme: every colour is a token defined on bare `:root` (light), redefined under
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…; color-scheme: dark} }` and again
  under `:root[data-theme="dark"]`. `body` sets an explicit token background.
- Layout: works at 360-430 px wide, no horizontal page scroll; side gutter
  `padding-left: max(16px, env(safe-area-inset-left, 0px))` (same on the right) on one outer wrapper, vertical
  padding via `padding-block`; keep the skeleton's `:root` safe-area padding; size the app with `height: 100%`
  on `html`/`body`, never `100vh`; anything fixed to the bottom adds `env(safe-area-inset-bottom, 0px)`.
- Text from storage or from Claude's answers is set with `textContent` / JSX text, never as HTML.
- Every form control has a stable `id`.

## 3. Stack and layout

TypeScript, Preact (bundled, small), esbuild, vitest for unit tests, Playwright (pre-installed globally: do not
install it or run `playwright install`; `require('playwright')` works) for e2e against the local preview.

```
src/core/        pure logic, no DOM: types.ts, handicap.ts, stats.ts, approach.ts   (+ *.test.ts)
src/data/        courses/rancho-solano.json, courses/index.ts
src/store/       store.ts (local-first storage + db sync)
src/ui/          app.tsx, screens/*.tsx, components/*.tsx, styles.css
src/vision/      green.ts, scorecard.ts (prompts + parsing for `sample`)
scripts/build.mjs   esbuild bundle -> dist/golf-buddy.html (fragment) + dist/preview.html (full page for local use)
e2e/*.spec.mjs      Playwright specs, run with `npm run e2e`
```
`npm run build` · `npm test` (vitest) · `npm run typecheck` (tsc --noEmit) · `npm run e2e` ·
`npm run preview` (static server for `dist/` on `$PORT`, default 4610). `dist/` is committed (the overseer
publishes from it).

## 4. Data model (`src/core/types.ts`; both phase-1 executors build to exactly this)

```ts
type Gender = 'M' | 'W';
interface Hole { number: number; par: number; strokeIndex: number; strokeIndexW?: number }
interface Tee {
  id: string; name: string; gender: Gender;
  rating: number; slope: number; par: number;          // 18-hole values
  frontRating?: number; frontSlope?: number; backRating?: number; backSlope?: number;
  yardages: number[];                                    // length 18, hole order
}
interface Course {
  id: string; name: string; city?: string; state?: string;
  holes: Hole[];                                         // length 18
  tees: Tee[];
  sources?: string[]; verified: boolean; updatedAt: string;
}
type FairwayResult = 'hit' | 'left' | 'right' | 'short' | 'long';
interface ApproachMark {            // where the ball finished relative to the pin, seen from where it was hit
  xFt: number;                      // + right of the pin, - left
  yFt: number;                      // + past the pin (long), - short
  onGreen: boolean; source: 'photo' | 'manual'; confidence?: number;
}
interface HoleScore {
  hole: number; strokes: number | null;
  putts?: number; fairway?: FairwayResult; penalties?: number; sand?: boolean;
  approach?: ApproachMark;
}
interface Round {
  id: string; date: string;                              // ISO date
  courseId: string; teeId: string;
  snapshot: { courseName: string; teeName: string; rating: number; slope: number; par: number;
              holes: Hole[] };                           // frozen at start; for 9-hole rounds the 9-hole values
  holesPlayed: '18' | 'F9' | 'B9';
  pcc: number;                                           // -1..3, default 0
  scores: HoleScore[];
  status: 'active' | 'posted';
  courseHandicap: number | null;                         // at the time of play
  updatedAt: string;
}
interface ImportedDifferential { id: string; date: string; differential: number; note?: string }
interface Profile { name?: string; gender: Gender; startingIndex?: number; homeCourseId?: string;
                    defaultTeeId?: string; updatedAt: string }
```

## 5. Handicap rules to implement (`src/core/handicap.ts`)

All pure functions, all unit-tested. Rounding: to the nearest tenth, .5 rounds up (toward +infinity, so -1.25
becomes -1.2). Course handicap rounds to a whole number the same way.

1. **Course Handicap** = `HI x slope / 113 + (rating - par)`. Nine holes: `(HI / 2) x slope9 / 113 +
   (rating9 - par9)`. A missing 9-hole rating falls back to `rating / 2` and the 18-hole slope.
2. **Strokes per hole.** CH >= 0: one stroke on each hole with `strokeIndex <= CH`, a second where
   `strokeIndex <= CH - 18`, and so on. CH < 0: give a stroke back starting from stroke index 18 downward.
   For a 9-hole round the nine holes are re-ranked 1-9 by their stroke index and the 9-hole CH is allocated.
3. **Adjusted Gross Score.** Hole maximum = net double bogey = `par + 2 + strokes received`. No index yet:
   maximum = `par + 5`. A hole not played in an 18-hole round with 10-17 holes played counts net par
   (`par + strokes received`) and the round is flagged `incomplete: true`; under 9 holes cannot be posted.
4. **Score Differential (18)** = `(113 / slope) x (AGS - rating - PCC)`.
5. **Nine-hole rounds** (WHS 2024): `diff9 = (113 / slope9) x (AGS9 - rating9 - PCC / 2)`; the posted 18-hole
   differential = `diff9 + expected9`, where `expected9 = 0.52 x HI + 1.2` (the published approximation of the
   USGA expected-score table; name it as an approximation in a code comment and on the Handicap screen's "how
   this is calculated" note). With no index yet, a 9-hole round waits and is combined with the next 9-hole
   round (sum of the two `diff9`).
6. **Handicap Index** from the most recent 20 differentials (app rounds + imported differentials, by date):

   | Scores | Use | Adjustment |
   |---|---|---|
   | 3 | lowest 1 | -2.0 |
   | 4 | lowest 1 | -1.0 |
   | 5 | lowest 1 | 0 |
   | 6 | average of lowest 2 | -1.0 |
   | 7-8 | lowest 2 | 0 |
   | 9-11 | lowest 3 | 0 |
   | 12-14 | lowest 4 | 0 |
   | 15-16 | lowest 5 | 0 |
   | 17-18 | lowest 6 | 0 |
   | 19 | lowest 7 | 0 |
   | 20 | lowest 8 | 0 |

   Fewer than 3: no calculated index; show `Profile.startingIndex` if set (labelled "starting index"), else "-".
   Maximum 54.0.
7. **Exceptional score.** A differential 7.0-9.9 below the index in effect when it was played: -1.0 applied to
   each of the most recent 20 differentials including that one; 10.0 or more: -2.0. Adjustments accumulate and
   stay with the scores they were applied to.
8. **Caps** (once 20 scores exist): Low Index = lowest index in the 365 days before the latest score. Soft cap:
   any rise beyond 3.0 above the Low Index is halved. Hard cap: never more than 5.0 above the Low Index.
9. `computeHistory(rounds, imported, profile)` replays scores in date order and returns, per score: AGS,
   differential, ESR adjustment, index after it, whether it is one of the counting scores now; plus current
   index, low index, cap applied, and the trend series. `targetScore(...)`: the gross score today (course, tee)
   that would lower the index, and the one that would count among the best 8.

## 6. Storage (`src/store/store.ts`)

Local-first, because phone signal on a course is poor. Every change writes to `localStorage` at once (try/catch;
the app renders without it) and is queued to `db`. Documents: `data/users/<id>/profile/main`,
`…/rounds/<roundId>`, `…/courses/<courseId>` (only user-added or edited courses; bundled ones ship in the page),
`…/imports/<id>`. On load: paint from local, then merge from `db` per document by `updatedAt` (newest wins),
and push anything local that `db` lacks. A small sync badge shows "Saved on this phone" / "Synced". One write
at a time per document, only on change; a 10 s timeout on loading; never reload the page. No photos are stored,
only the marks derived from them.

## 7. Screens

Bottom tab bar: **Play · Handicap · Shots · Courses**.
- **Play**: no active round: "Start round" (course, tee, 18 / front 9 / back 9, date; shows course handicap and
  the target score). Active round: one hole per screen. Header: hole, par, yards, stroke index, strokes
  received, and the net-double-bogey maximum. Big +/- stroke stepper preset to par, putts stepper, fairway
  (left / hit / right, hidden on par 3s), penalties, sand. "Mark approach" opens the green sheet (section 8).
  Prev / next, a tappable 18-hole strip, running total and to-par. "Finish round" shows the scorecard (circles
  for birdies or better, squares for bogeys or worse), AGS, differential and the index before and after, then
  "Post round". Posted rounds can be reopened and edited from Handicap.
- **Handicap**: index (large), low index, trend sparkline, last 20 with the counting scores marked, per-round
  detail, "Add past score" (imported differential, or starting index in profile), "How this is calculated".
- **Shots**: approach heat map (section 8) and round stats: fairways hit, greens in regulation (computed:
  `strokes - putts <= par - 2`), putts per round, scoring average by par 3 / 4 / 5.
- **Courses**: list, detail (tees, ratings, hole table), add or edit by hand, "Scan a scorecard" (section 9).

Design direction: built for sunlight and one thumb. High contrast, large numerals with tabular figures, tap
targets at least 48 px, the scorecard's own vernacular (circle / square notation, OUT / IN / TOT rows). A calm
turf-and-chalk palette with one accent; both themes designed. No emoji, no gradients as decoration.

## 8. Green photo and approach heat map

- From a hole: "Mark approach" opens a sheet with a top-down green diagram: pin at the centre, rings at 10, 20
  and 30 ft, labels Short / Long / Left / Right as seen from where the shot was hit. Tap or drag to place the
  ball. This works with no network and no capability.
- "Use a photo": pick or take a photo (downscaled in a canvas to max 1280 px, JPEG ~0.8). `src/vision/green.ts`
  sends it through `sample.json` with `images` and asks for strict JSON:
  `{ found: boolean, xFt: number, yFt: number, onGreen: boolean, confidence: 0..1, note: string }`,
  ball relative to the flagstick, from the camera's viewpoint (the hint text tells him to shoot from the
  direction he hit from). The result is validated and clamped (within 150 ft), drawn on the diagram as a
  suggestion he can drag, then saved with `source: 'photo'`. Any failure (no capability, declined, bad JSON,
  `found: false`) drops to manual placement with one plain line of explanation. Never loops, never auto-retries.
- **Heat map** (`src/core/approach.ts` + Shots screen): all marks on one pin-centred canvas, a kernel-density
  heat layer plus the individual dots, rings at 10 / 20 / 30 ft. Filters: all / par 3 only / this course / last
  5 rounds. Under it: average distance from the pin, share on green, and the miss pattern in words, true to
  the data (for example "58% of misses finish short, 41% left"), only shown from 5 marks up.

## 9. Scorecard scan ("any course I play")

Courses > "Scan a scorecard": one or two photos. `src/vision/scorecard.ts` asks `sample.json` for a `Course`
shaped object (holes with par and stroke index, each tee with name, rating, slope, yardages). The parsed result
opens in the course editor marked "Check against the card", with missing or implausible values highlighted
(par not 3-5, stroke indexes not a 1-18 permutation, slope outside 55-155, rating outside 55-80, yardage total
mismatch). Nothing is saved until he taps Save. Manual entry is always available and is the same editor.

## 10. Rancho Solano data

`src/data/courses/rancho-solano.json`, a `Course` with every tee the course lists: rating, slope, par, per-hole
yardage, par and stroke index (men's; women's where published), front / back ratings if published. `sources`
lists the URLs used. `verified: true` only if rating and slope come from the USGA course rating database or the
course's own scorecard and two sources agree on the hole table; otherwise `false`, and the course detail screen
shows "Check these numbers against the card" so he can fix them in the editor on the first tee.

## 11. Demand note

`docs/sales/PRODUCT-INSIGHTS.md` belongs to SpinHUD and does not cover this app; the demand is the owner's own
request for a personal tool.

## Executor rules

- Work only in `/home/user/Golf-buddy` on branch `claude/vigilant-curie-yjgzl8`. Never touch
  `/home/user/casino-stream-hub`. Do not push, open PRs or publish artifacts; the overseer does.
- Stay inside your card's Files line. Another executor may be working in the same checkout: stage only your own
  paths (`git add <paths>`, never `git add -A` / `git commit -a`), and retry once if the index is locked.
- No paid services, no API keys, no network calls from the app. `npm install` of the dev dependencies named in
  section 3 is fine.
- Run your card's Verification and fix what fails before reporting. Commit with a clear message ending with:
  `Co-Authored-By: Claude <noreply@anthropic.com>` and a blank line before it. No model names anywhere in the repo.
- Every user-facing line is final copy and true to the code. No lorem ipsum, no "coming soon".
- Report in at most 15 lines; the full account goes to the report file named in your brief.

## 12. Distance finder (added 2026-11-27 at the owner's request)

Owner: "track distance from myself and the hole ... basically have a distance finder."

Constraint: inside the Claude artifact frame `navigator.geolocation` is refused without a prompt, and no location
capability exists. So the feature has two methods behind one "Distance" button on the hole screen, and the copy
never promises GPS where it cannot work.

### 12.1 Flagstick rangefinder (works everywhere, including the artifact)
- Take or choose a photo of the flag (`<input type="file" accept="image/*" capture="environment">`). The photo is
  NOT downscaled for measuring: decode it at full resolution (`createImageBitmap`), show it in a pannable,
  pinch-zoomable canvas with a magnifier loupe above the finger while dragging.
- Two handles: top of the flagstick and its base at the cup. Distance = `flagHeightFt x focalPx / heightPx`,
  where `focalPx = f35 x diagonalPx / 43.27` (35 mm-equivalent focal length, full-frame diagonal 43.27 mm), using
  the pixel dimensions of the original image. Result in yards (whole numbers), with a plus/minus computed from a
  2 px placement error at the current handle spacing.
- `f35` comes from the photo's EXIF (`FocalLengthIn35mmFilm` 0xA405, times `DigitalZoomRatio` 0xA404 when
  present; handle orientation). A small EXIF reader lives in `src/core/exif.ts` (JPEG APP1 only, no library).
  When EXIF is missing, he picks the lens (0.5x = 13 mm, 1x = 26 mm, 2x = 52 mm, 3x = 77 mm, 5x = 120 mm) and the
  result is labelled "approximate: lens guessed".
- Flagstick height is a setting on the sheet, default 7 ft, remembered in the profile (`flagHeightFt`).
- Pure maths in `src/core/rangefinder.ts`, unit-tested with worked examples (a 7 ft stick 42 px tall in a
  4032 x 3024 photo at 26 mm is 168 yd; check both orientations).
- The photo is never stored or sent anywhere. Copy states the honest accuracy: best inside about 200 yards and
  with the 2x or 3x lens.

### 12.2 GPS (active only where the browser grants location)
- On opening the sheet, never call geolocation by itself; a "Use my location" button does (one call from the tap).
  If it is refused or unavailable, show one line: "This page cannot use your phone's location here. The flagstick
  rangefinder works everywhere." and hide the GPS section for the visit.
- Green positions are learned: `Hole.green?: { lat: number; lon: number }` (optional field added to
  `src/core/types.ts`), saved on the user's copy of the course when he taps "I'm at the pin: save this green".
  With a saved green: live distance in yards to it (`watchPosition`, high accuracy, stopped when the sheet
  closes), with the reported accuracy shown as plus/minus yards.
- Shot measure: "Mark my ball here", walk to the ball, the sheet shows the distance walked; works with no saved
  green.
- Haversine in `src/core/geo.ts`, unit-tested.

### 12.3 Out of scope here
Hosting the app outside Claude (needed for GPS to be usable) is a separate decision for the owner; bundled green
coordinates for Rancho Solano; hazards and layups; slope adjustment.

## 13. Hosted copy on GitHub Pages (owner, 2026-11-27: "Yes host it on GitHub Pages so GPS works")

- `npm run build` also writes `dist/site/`: `index.html` (the same bundle as the artifact, as a full page with
  doctype, viewport meta with `viewport-fit=cover`, theme-color, the reset the artifact skeleton provides),
  `manifest.webmanifest` (name "Golf Buddy", `display: standalone`, relative `start_url` and `scope` so it works
  under `/Golf-buddy/`), icons (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, generated by the build
  from an inline SVG of the app's flag mark; no new dependency if Playwright's Chromium can rasterise it at build
  time, otherwise commit the PNGs), and `sw.js`.
- `sw.js`: a small service worker so the hosted copy opens with no signal: network-first for `index.html` with
  fallback to cache, cache-first for the icons and manifest, versioned cache name from the build hash, old caches
  deleted on activate. Registered only by the site wrapper (never in `dist/golf-buddy.html`, where service
  workers are not allowed), and only when `location.protocol` is `https:` or the host is `localhost`.
- `.github/workflows/pages.yml`: on push to `main` (and manual dispatch): `npm ci`, `npm run typecheck`,
  `npm test`, `npm run build`, upload `dist/site` with `actions/upload-pages-artifact`, deploy with
  `actions/deploy-pages`. Permissions `pages: write`, `id-token: write`, `contents: read`. e2e is not run in CI
  (Playwright is not a dependency of the repo).
- In the hosted copy `window.claude` is absent: data lives in the phone's browser storage only, the photo-reading
  features show their existing "not available" line, GPS works. The hosted copy and the Claude artifact do not
  share data. The Handicap screen's storage note says where the data lives in each case, truthfully.
- The owner turns Pages on once (repo Settings > Pages > Source: GitHub Actions) and merges the PR; the site is
  public at `https://projectgitahead.github.io/Golf-buddy/`. No personal data is in the build.

## 14. Hosted copy on Fly.io (owner, 2026-11-27: "You can use my fly.io account to host it")

This session has no Fly CLI, no Fly token and no network route to Fly, and secrets never pass through chat. So
the deploy runs in GitHub Actions with a token the owner stores as the repo secret `FLY_API_TOKEN`. Fly becomes
the hosted copy; the GitHub Pages workflow stays in the repo but runs only when started by hand
(`workflow_dispatch`), so pushes to `main` do not fail while Pages is switched off.

- `fly.toml` at the repo root: `app = "projectgitahead-golf-buddy"`, `primary_region = "sjc"`, `[build]`
  dockerfile, `[http_service]` `internal_port = 8080`, `force_https = true`, `auto_stop_machines = "stop"`,
  `auto_start_machines = true`, `min_machines_running = 0`; one `shared-cpu-1x` machine with 256 MB.
- `Dockerfile`: `nginx:alpine` serving `dist/site/` on 8080 from a small `deploy/nginx.conf`: `index.html`,
  `sw.js` and `manifest.webmanifest` with `Cache-Control: no-cache`; icons cacheable for a day; gzip on;
  `X-Content-Type-Options: nosniff`; a `Permissions-Policy` that allows `geolocation=(self)` and `camera=(self)`;
  unknown paths return 404. `.dockerignore` keeps everything except `dist/site` and `deploy/` out of the image.
- `.github/workflows/fly.yml`: on push to `main` and manual dispatch: checkout, node 22, `npm ci`, typecheck,
  test, build, `superfly/flyctl-actions/setup-flyctl`, then `flyctl apps create <app> --org "$FLY_ORG"` only if
  `flyctl status` says the app does not exist (`FLY_ORG` from the repo variable of that name, default
  `personal`), then `flyctl deploy --remote-only --ha=false`. `FLY_API_TOKEN` from secrets. If the secret is
  empty the job stops at its first step with a plain message instead of a confusing failure. Concurrency group
  `fly-deploy`.
- The site is at `https://projectgitahead-golf-buddy.fly.dev/`; it is public and holds no personal data. Cost:
  one machine that stops when idle.
- Owner's steps: create a Fly deploy token (`fly tokens create org` or the Fly dashboard > Tokens), add it at
  GitHub repo Settings > Secrets and variables > Actions as `FLY_API_TOKEN`, merge the PR.

## 15. Live yardage to the hole (owner, 2026-11-27)

Owner: "give me current yardage from the hole wherever the user is standing. So they can see how far away they
are from the hole and decide what club to hit."

Applies where location works (the hosted copy; decided by `window.claude` being absent AND geolocation being
granted, never by hostname). In the Claude artifact nothing changes.

### 15.1 Green positions from OpenStreetMap
- `src/net/overpass.ts`: one Overpass query for `golf=green` (ways / relations, with geometry) and `golf=hole`
  ways (with `ref` and geometry) inside a 1,500 m radius of the player's position. `fetch` with a 15 s abort,
  first `https://overpass-api.de/api/interpreter`, then `https://overpass.kumi.systems/api/interpreter` once on
  failure; no other retries. Only ever called from a tap, only in the hosted copy. This is the app's single
  network call: the fragment rule "no external URL" is relaxed for these two endpoint strings and the
  attribution link only (update the build check and `e2e/fragment.spec.mjs` to allow exactly those).
- `src/core/greens.ts` (pure, unit-tested with a fixture): for each `golf=hole` way with a numeric `ref` 1-18,
  the green is the `golf=green` polygon containing or nearest to the way's last node (within 60 m). When the
  same `ref` appears more than once (two courses side by side), keep the set of holes whose tees are nearest
  the player. Output per hole: centre (polygon centroid) and outline (simplified to at most 40 points).
- Types: `Hole.green` (centre, exists) plus optional `Hole.greenShape?: [number, number][]` on its own line.
  Saved on the user's copy of the course, like a learned green; a posted round's snapshot is not changed.
- Before saving, one line reports what was found ("Found 18 of 18 greens") and lists missing holes; holes
  already saved by hand are kept unless he chooses "Replace mine". If nothing is found: "This course is not
  mapped in OpenStreetMap yet. Stand at each pin once and save it." and the learn-as-you-play path remains.
- Attribution, always visible next to the yardage when OSM positions are in use: "Green positions (c)
  OpenStreetMap contributors".
- Privacy copy on the button's hint: loading sends the course's rough location to the OpenStreetMap Overpass
  service; nothing else leaves the phone.

### 15.2 Live yardage on the hole screen
- A yardage panel directly under the hole header (not inside the Distance sheet): centre yardage very large,
  front and back smaller on either side, and the GPS accuracy as plus/minus yards. Front / back = the nearest
  and farthest outline points from the player; with no outline (learned green) only the centre shows.
- States: (1) "Turn on live yardage" button (first use; the tap requests location); (2) live numbers; (3) "No
  green position for hole N" with "Load green positions" and "I'm at the pin: save this green"; (4) more than
  1,500 yd away: "You are not near this hole" instead of a number; (5) accuracy worse than 30 yd: numbers
  shown dimmed with "Weak GPS signal".
- One `watchPosition` (high accuracy) for the whole round, shared by the panel and the Distance sheet, started
  by the first tap; on later visits it starts by itself only if `navigator.permissions` reports `granted`.
  Paused while the page is hidden and when no round is active; never more than one watcher.
- A screen wake lock is requested while yardage is live and released when it stops (rejection tolerated).
- Yardage updates must not re-render the whole hole screen (score entry stays responsive).
- The service worker ignores cross-origin requests.

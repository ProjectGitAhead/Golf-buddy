# Golf Buddy

A personal golf round tracker and World Handicap System (WHS) index calculator. You pick a course, score a round hole
by hole, post it, and the app works out your handicap index. It also shows round stats (fairways, greens in
regulation, putts, scoring by par), an approach heat map, and can read a scorecard or a green from a photo. All data
stays in the viewer's own account storage; there is no server of ours.

## Commands

```bash
npm install          # once
npm run typecheck    # tsc --noEmit
npm test             # vitest unit tests (src/)
npm run build        # writes dist/golf-buddy.html (fragment), dist/preview.html and dist/site/ (hosted copy)
npm run preview      # builds and serves a local preview page
npm run e2e          # builds, serves dist/ on port 4610 (E2E_PORT to change), runs every e2e/*.spec.mjs
npm run icons        # redraws the hosted copy's PNG icons from scripts/site/icon.svg (needs Playwright)
```

## How it is published

The overseer publishes `dist/golf-buddy.html` as a private Claude Artifact with the capabilities `db`, `user` and
`sample-with-images`. Nobody else publishes it. `dist/` is committed, so rebuild and commit it with any UI change.

## Hosted copy

The same app also runs as a web page, because a page inside Claude cannot use the phone's location. Fly.io is the
host: `https://projectgitahead-golf-buddy.fly.dev/`. There, GPS distances work and the Distance sheet opens on GPS;
the flag photo rangefinder works too, but reading a green or a scorecard from a photo needs Claude and is not
available. Add it to the home screen from the browser's share menu; a small service worker (`scripts/site/sw.js`)
lets it open with poor or no signal and fetches the newest version whenever the network answers. The hosted copy
and the Claude artifact keep separate data: scores in the hosted copy stay in that phone's browser.

Owner's three steps (once):

1. Create a Fly deploy token (`fly tokens create org`, or the Fly dashboard > Tokens).
2. Add it as the GitHub repo secret `FLY_API_TOKEN` (Settings > Secrets and variables > Actions).
   If the app does not exist yet the workflow tries to create it, which needs an organisation token and the repository
   variable `FLY_ORG` set to your organisation's slug (`fly orgs list`; default `personal`). Otherwise create the app
   once yourself (`fly apps create projectgitahead-golf-buddy`) and use a token that covers it.
3. Merge to `main`. `.github/workflows/fly.yml` then builds, creates the app if needed and deploys.

- `npm run build` writes `dist/site/` (page, manifest, icons, `sw.js`) from `scripts/site/`. The `Dockerfile` serves
  it with nginx on port 8080 (`deploy/nginx.conf`); `fly.toml` holds the Fly settings (one small machine that stops
  when idle). Without the secret the workflow stops at its first step with a plain message.
- Map lookup: the nginx config also serves `POST /api/osm`, which forwards the app's green and hazard query to the
  four public OpenStreetMap Overpass servers in turn (fail-over on 406, 429, 5xx and time-outs), with a `User-Agent`
  naming this app, a 16 KB body limit, about 6 requests a minute per phone (`Fly-Client-IP`), and good answers
  cached on the machine's disk for a day (keyed by the query; the cache is lost when the machine is replaced). The
  app asks `/api/osm` first and the public servers directly only if it fails; where it does not exist (GitHub Pages,
  local preview) it answers 404 and the app goes straight to the public servers. The `Dockerfile` runs `nginx -t`, so
  a bad config stops the deploy. `node scripts/check-nginx.mjs` runs `nginx -t` and a local fail-over, cache and
  rate-limit test against stand-in servers when an `nginx` binary is installed (it cannot test TLS, DNS or the real
  servers).
- Find a course (hosted copy only): Courses > Find a course searches OpenGolfAPI (`api.opengolfapi.org`, no key,
  1,000 requests a day per address; data under the ODbL, credited on screen) by name, or near you by asking for your
  state's list (your position is not sent). A pick opens the course editor pre-filled; anything the data lacks
  (often ratings, slopes and yardages) is flagged for you to type from the card, as with a scanned card. Saving it
  loads its greens, bunkers and water from OpenStreetMap around the course's own coordinates (2,500 m) and stores
  them on the course; a course's page can load them again later. The response shapes were built from OpenGolfAPI's
  source and data schema, not checked against a live answer.
- GitHub Pages is still available: turn on Pages (repo Settings > Pages > Source: GitHub Actions), then run the
  Pages workflow (`.github/workflows/pages.yml`) by hand from the Actions tab. It no longer runs on push.

## Where things live

- `src/core/handicap.ts`: all handicap rules (plan section 5 in `plans/golf-buddy-v1.md`), with tests beside it.
- `src/core/types.ts`: the data model (plan section 4).
- `src/vision/`: photo and green reading. `src/ui/`: screens and styles. `e2e/`: browser specs.
- `plans/`: the plan and the task list.

## Known approximations

- 9-hole rounds use an expected score of `0.52 x index + 1.2`.
- Holes not played in a posted round are counted at net par.
- The index is unofficial. It follows the WHS rules but is not issued by any golf association.
- Rancho Solano course data is unverified; check it against the real scorecard.

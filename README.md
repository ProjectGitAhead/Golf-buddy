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

The same app also runs as a web page at `https://projectgitahead.github.io/Golf-buddy/`, because a page inside
Claude cannot use the phone's location. There, GPS distances work and the Distance sheet opens on GPS; the flag
photo rangefinder works too, but reading a green or a scorecard from a photo needs Claude and is not available. Add it to the home screen from the browser's share menu;
a small service worker (`scripts/site/sw.js`) lets it open with poor or no signal and fetches the newest version
whenever the network answers. Scores in the hosted copy stay in that phone's browser and are not shared with the
Claude version.

- `npm run build` writes `dist/site/` (page, manifest, icons, `sw.js`) from `scripts/site/`. Every URL in it is
  relative, so it works under the `/Golf-buddy/` sub-path; `npm run preview` serves it at `/Golf-buddy/`.
- `.github/workflows/pages.yml` runs on every push to `main` (or by hand): `npm ci`, typecheck, tests, build, then
  deploys `dist/site/` to GitHub Pages. One-time setup: repo Settings > Pages > Source: GitHub Actions.

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

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
npm run build        # writes dist/golf-buddy.html (fragment) and dist/preview.html
npm run preview      # builds and serves a local preview page
npm run e2e          # builds, serves dist/ on port 4610 (E2E_PORT to change), runs every e2e/*.spec.mjs
```

## How it is published

The overseer publishes `dist/golf-buddy.html` as a private Claude Artifact with the capabilities `db`, `user` and
`sample-with-images`. Nobody else publishes it, and nothing here pushes or deploys. `dist/` is committed, so rebuild
and commit it with any UI change.

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

# Golf Buddy as a phone app (iOS + Android)

Status: **draft, waiting for the owner's approval.** Nothing here is built yet.
Owner's request (2026-11-28): a real phone app whose data stays put, that runs better, on both stores; first a
build he can test himself and share with others.

## 1. What is wrong today, and what fixes it

| Today | Why | In the app |
|---|---|---|
| Scores can vanish or differ between visits | The hosted copy keeps everything in the browser's `localStorage`. Safari deletes that after about 7 days without a visit, the home-screen icon and the Safari tab each hold their own copy, and the Claude artifact holds a third. | Data is written to the app's own storage on the phone, which the system does not clear, and (phase 3) to an account so it survives a reinstall or a new phone. |
| Slow or blank start on the course | The page is fetched from Fly (the machine sleeps when idle); with weak signal the service worker waits up to 3 s before using its cached copy. | The app's files ship inside the app. It opens with no network at all. |
| GPS and camera ask again, screen dims mid-round | Browser permissions and browser power rules. | Native location and camera permissions, granted once; screen kept awake on the hole screen. |

The cause in row 1 is read from the code and from how Safari is known to behave; it has not been reproduced on the
owner's phone. Phase 1 starts by confirming it there.

## 2. Approach: wrap the existing app with Capacitor

Keep the one Preact + TypeScript codebase and put it in a native shell (Capacitor) that produces a real Xcode
project and a real Android Studio project. Chosen over the alternatives because:

- **Rewrite in React Native or Flutter:** every screen, the handicap engine's UI, the heat map and the rangefinder
  would be rebuilt. Weeks of work and two codebases to keep equal, for an app this size with no gain the owner
  would notice.
- **Stay a home-screen web app (PWA):** cannot go in the App Store, and does not fix the storage problem on iPhone.
- **Capacitor:** the app is already one self-contained 214 KB page with no server of its own, which is the easy
  case. The handicap rules, store merge logic and all 12 e2e specs carry over unchanged.

One build then has three outputs: the Claude artifact (unchanged), the hosted web copy (unchanged, stays as the
"try it without installing" link), and the native app.

## 3. Phases

Each phase ends with something the owner can hold and check. A phase starts only after the one before is approved.

### Phase 1: the app on the owner's own phone (no accounts, no fees for Android)
- Add Capacitor; `npm run build` also writes the native web bundle; `ios/` and `android/` projects committed.
- **Storage adapter.** `src/store/store.ts` talks to `localStorage` directly today. Put a small interface in front
  of it (`read` / `write` of the one `golf-buddy:v1` document) with two implementations: browser (as now) and
  native (a file in the app's data folder, written atomically). The merge rules do not change.
- **Backup file.** "Export my data" and "Import" on the Handicap screen, in all three copies. This is how scores
  already in the hosted copy move into the app, and it is the safety net until phase 3.
- Native location (replaces the browser watcher behind `src/ui/location.ts`), native camera for the flag photo,
  keep-awake on the hole screen, safe-area and back-button handling, app icon and splash from the existing SVG.
- Remember the open tab and hole so returning to the app lands where it was left.
- **Result:** an Android `.apk` built by GitHub Actions on every merge, and an iPhone build installed from Xcode
  on the owner's Mac.

### Phase 2: share it with others
- **Android:** a download link to the signed `.apk` (GitHub release). Anyone can install it; no account needed.
  Later the same build goes to Play "internal testing" (invite by email, up to 100 people).
- **iPhone:** TestFlight. Needs the Apple Developer Program (see section 5). Up to 100 testers added by email at
  once; a public invite link for up to 10,000 after Apple's short beta review. Builds expire after 90 days.
- In-app "Send feedback" (opens an email with the app version filled in) and a version line on the Handicap screen.
- **Result:** two links the owner can send to anyone.

### Phase 3: account and sync (data survives a new phone, and works across phone and web)
- The store already syncs to a database through a small interface (`DbLike`: documents, collections, live
  updates) with per-hole merging and deletion markers. That interface has the same shape as Google's Firestore,
  so the work is a thin adapter plus sign-in, not a new sync engine.
- Recommended: **Firebase Auth + Firestore** (free tier covers this many times over). Sign in with Apple, Google
  or an email link. Each user can read and write only their own documents (security rules, with tests).
- Signing in is optional: the app keeps working fully on the phone without it.
- In-app "Delete my account and data" (Apple requires it for any app with accounts).
- **Result:** sign in on a second phone or the web copy and the same rounds are there.

### Phase 4: photo reading in the app (optional, has a running cost)
- Reading a scorecard or a green from a photo uses Claude through the artifact today and is switched off
  everywhere else. In the app it needs a small server of ours (on the existing Fly account) that holds the API
  key, accepts only signed-in users and caps use per user per day.
- Cost is per photo read. The owner approves a monthly cap before this is built. Until then the app ships without
  it, exactly like the hosted copy.

### Phase 5: store release
- Store listing text, screenshots, privacy policy page, data-safety forms, location and camera purpose texts.
- Wording check: the index is unofficial. "Handicap Index" and "WHS" are trademarks of the golf governing
  bodies; the listing and the screens should say "handicap estimate" and carry the existing "not issued by any
  golf association" line. Check that the name "Golf Buddy" is free on both stores, or pick a subtitle.
- Google Play: new personal developer accounts must run a closed test with at least 12 testers for 14 days
  before going public. Phase 2's testers count, so start the clock then.
- Apple review, then release. Updates after that: merge, CI builds, upload, review (about a day).

## 4. What stays the same
- Handicap rules, data model, course data, green lookup from OpenStreetMap, heat map, rangefinder.
- The Claude artifact and the Fly web copy keep working from the same source.
- Gate for every task: `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e`. Added: an Android build
  in CI, and store tests for the native storage adapter and for export / import.

## 5. What the owner has to do or decide

| # | Item | When | Cost |
|---|---|---|---|
| 1 | Approve this plan (or change it) | now | none |
| 2 | Install Xcode on the Mac, plug in the iPhone once | phase 1 | none |
| 3 | Enrol in the Apple Developer Program (personal or company name shows as the seller) | before phase 2 | $99 per year |
| 4 | Create a Google Play developer account | before phase 5 (phase 2 if Play testing is wanted) | $25 once |
| 5 | Firebase for accounts, or keep the app on-phone only with backup files | before phase 3 | free tier |
| 6 | Photo reading in the app: yes with a monthly cap, or leave it out | before phase 4 | per use |
| 7 | App name and who the listed developer is | before phase 5 | none |

Signing keys and store passwords go in the Mac's Keychain and GitHub secrets only, never in the repo or chat.

## 6. Risks
- **Apple may reject a thin web wrapper.** Mitigation: native location, camera, offline start and keep-awake make
  it behave as an app, and it is fully usable without a network.
- **iPhone builds need a Mac.** Phase 1 uses the owner's Mac; CI builds for iPhone (GitHub's macOS runners) are
  added in phase 2 so sharing does not depend on that Mac.
- **Two copies of the data during the change-over.** The backup file moves scores across once; after phase 3 the
  account is the single source and the same merge rules already tested in `store.test.ts` apply.
- **Play's 14-day test** sets the earliest public Android date; it runs alongside phases 3 to 5.

## 7. Task outline (cards are written after approval)

| Task | Phase | Size | Executor |
|---|---|---|---|
| P1.1 Storage adapter behind the store, browser implementation, tests | 1 | M | Opus |
| P1.2 Export / import backup file, all three copies | 1 | S | Opus |
| P1.3 Capacitor projects, build output, native storage, Android CI build | 1 | M | Opus |
| P1.4 Native location, camera, keep-awake, safe areas, icon and splash | 1 | M | Opus |
| P1.5 Remember tab and hole; confirm the data-loss cause on a real phone | 1 | S | Sonnet |
| P2.1 Signed Android release link; TestFlight upload from CI | 2 | M | Opus |
| P2.2 Feedback link and version line | 2 | S | Sonnet |
| P3.1 Firestore adapter for `DbLike`, security rules and tests | 3 | M | Opus |
| P3.2 Sign-in, sign-out, delete account | 3 | M | Opus |
| P4.1 Photo-reading server with per-user caps | 4 | M | Opus |
| P5.1 Listing, privacy policy, wording check, submissions | 5 | M | Opus (copy), Sonnet (forms) |

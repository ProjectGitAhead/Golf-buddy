// The one location watcher for the whole page (plan section 15.2), shared by the yardage panel and the Distance
// sheet. It never starts by itself on a first visit: `turnOn()` is called from a tap. While it is on, the watch runs
// only while something on screen uses it (`useLocation`) and the page is visible; hiding the page pauses it and
// showing it again resumes it. There is never more than one `watchPosition` at a time. A screen wake lock is held
// while numbers are live (refusal tolerated).
import { useEffect, useState } from 'preact/hooks';
import { validFix, type LatLon } from '../core/geo';

export interface Fix extends LatLon { acc: number }
export type LocationState =
  | { state: 'off' }
  | { state: 'waiting' }
  | { state: 'live'; fix: Fix }
  | { state: 'nofix'; message: string }
  | { state: 'blocked' };

export const NO_FIX_WAIT_MS = 20_000;
const REMEMBER_KEY = 'golf-buddy:live-yardage';

let current: LocationState = { state: 'off' };
let wanted = false;              // turned on by a tap this visit (or resumed because permission was already granted)
let users = 0;                   // mounted components that use the location
let watchId: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let hadFix = false;
let wake: { release: () => Promise<void> } | null = null;
const listeners = new Set<() => void>();

const geo = () => (typeof navigator !== 'undefined' ? navigator.geolocation : undefined);
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function set(next: LocationState) {
  current = next;
  if (next.state === 'live') void holdWake(); else void dropWake();
  for (const fn of listeners) fn();
}

export function locationState(): LocationState { return current; }
export function locationBlocked(): boolean { return current.state === 'blocked' || !geo(); }

function clear() {
  if (watchId !== null) { try { geo()?.clearWatch(watchId); } catch { /* gone */ } }
  watchId = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

function watch() {
  if (watchId !== null) return;
  const g = geo();
  if (!g) { wanted = false; set({ state: 'blocked' }); return; }
  hadFix = false;
  if (current.state !== 'waiting') set({ state: 'waiting' });
  timer = setTimeout(() => {
    clear(); wanted = false;
    set({ state: 'nofix', message: 'No location after 20 seconds. Step into the open and try again.' });
  }, NO_FIX_WAIT_MS);
  try {
    watchId = g.watchPosition(
      (p) => {
        const fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
        if (!validFix(fix)) return;
        if (timer) { clearTimeout(timer); timer = null; }
        hadFix = true;
        set({ state: 'live', fix });
      },
      (err) => {
        if (err.code === 1) { clear(); wanted = false; set({ state: 'blocked' }); return; }  // refused, or not allowed here
        if (hadFix) return;                       // a passing glitch mid-watch: keep the last fix and keep watching
        clear(); wanted = false;
        set({ state: 'nofix', message: 'Your phone has no location fix yet. Step into the open and try again.' });
      },
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  } catch { clear(); wanted = false; set({ state: 'blocked' }); }
}

/** Starts or pauses the watch to match: wanted, used and visible. */
function sync() {
  if (wanted && users > 0 && visible()) { watch(); return; }
  const was = watchId !== null;
  clear();
  if (!wanted) { if (current.state === 'live' || current.state === 'waiting') set({ state: 'off' }); }
  else if (was) set({ state: 'waiting' });        // paused: an old fix is never shown as current after a resume
}

let forYardage = false;          // live yardage asked for it: it stays on for the round, not just while a sheet is open

/** From a tap: turn location on (one geolocation call). Does nothing once it was refused this visit. */
export function turnOn(opts: { yardage?: boolean } = {}): void {
  if (current.state === 'blocked') return;
  if (opts.yardage) forYardage = true;
  wanted = true;
  if (current.state === 'nofix') set({ state: 'off' });
  sync();
}

/** Turns location off until the next tap. */
export function turnOff(): void {
  wanted = false;
  forYardage = false;
  sync();
}

/** Live yardage turned location on for this visit (so closing the Distance sheet does not stop it). */
export const onForYardage = () => wanted && forYardage;

/** Remembers on this phone that live yardage is on, so a later visit can resume it without a tap. */
export function rememberYardage(on: boolean): void {
  try { if (on) localStorage.setItem(REMEMBER_KEY, '1'); else localStorage.removeItem(REMEMBER_KEY); } catch { /* private mode */ }
}
export function yardageRemembered(): boolean {
  try { return localStorage.getItem(REMEMBER_KEY) === '1'; } catch { return false; }
}

/** True only when the browser says location is already granted to this page (no prompt would show). */
export async function permissionGranted(): Promise<boolean> {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return p?.state === 'granted';
  } catch { return false; }
}

async function holdWake() {
  if (wake || !visible()) return;
  const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
  if (!wl) return;
  try {
    const lock = await wl.request('screen');
    if (current.state === 'live' && watchId !== null) wake = lock; else void lock.release().catch(() => {});
  } catch { /* refused: low battery, or not allowed */ }
}

async function dropWake() {
  const lock = wake;
  wake = null;
  if (lock) { try { await lock.release(); } catch { /* already released */ } }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!visible()) void dropWake();               // the browser drops the lock when hidden anyway
    sync();
    if (visible() && current.state === 'live' && watchId !== null) void holdWake();
  });
}

/**
 * The location as a component sees it. While mounted the component counts as a user, so the watch runs (if on);
 * when the last user goes, the watch pauses. Only the component that calls this re-renders on a new fix.
 */
export function useLocation(): LocationState {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    users++;
    sync();
    return () => {
      listeners.delete(fn);
      users--;
      sync();
    };
  }, []);
  return current;
}

import { useEffect, useState } from 'preact/hooks';
import { Store, startSync } from './store';

/** The one store the app uses. */
export const store = new Store();

let started = false;
/** Starts db sync once, after first paint. */
export function startStoreSync(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void startSync(store); }, 0);
}

/** Re-renders the calling component whenever the store changes. */
export function useStore(): Store {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), []);
  return store;
}

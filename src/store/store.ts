// Local-first storage (plan section 6).
//
// Every change is written to localStorage at once (when it is available) and queued to the `db` capability.
// On load the page paints from local data; once `db` answers, each document is merged, anything db lacks or holds
// older is pushed, and from then on one `onSnapshot` listener per collection merges what other devices write.
// Other tabs of this page are merged through the window `storage` event, and every local save merges with what is
// stored rather than replacing it.
//
// Merging: newest `updatedAt` wins per document, except rounds, which merge per hole (each hole from the copy
// that changed it last; a hole with strokes beats an empty one when a timestamp is missing; round-level fields
// from the newer copy). Deletions are tombstone documents `{ deleted: true, updatedAt }`: a tombstone newer than a
// copy wins on every device, an edit newer than the tombstone wins. Before each write the db copy is read and
// merged, so a view that missed updates never overwrites newer scores.
//
// db layout (a document path has an even number of segments, so the per-user documents sit under one
// per-user "golf" document):
//   data/users/<id>/golf/profile/main
//   data/users/<id>/golf/rounds/<roundId>
//   data/users/<id>/golf/courses/<courseId>   (only courses the user added or edited)
//   data/users/<id>/golf/imports/<id>

import type { Course, HoleScore, ImportedDifferential, Profile, Round } from '../core/types';

export type Kind = 'profile' | 'rounds' | 'courses' | 'imports';
export const KINDS: Kind[] = ['profile', 'rounds', 'courses', 'imports'];
const PROFILE_ID = 'main';

export interface AppData {
  profile: Profile | null;
  rounds: Record<string, Round>;
  courses: Record<string, Course>;
  imports: Record<string, ImportedDifferential>;
}

/** local: no db on this view · syncing: loading or writing · synced: db holds everything · offline: db unreachable */
export type SyncState = 'local' | 'syncing' | 'synced' | 'offline';

// The slice of the db capability this store uses (see the capability's db.d.ts).
export interface DbDocSnapshot { id: string; exists: boolean; data(): Record<string, unknown> | undefined }
export interface DbQuerySnapshot { docs: DbDocSnapshot[]; metadata?: { fromCache?: boolean } }
export interface DbDocRef {
  get(): Promise<DbDocSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}
export interface DbCollectionRef {
  get(): Promise<DbQuerySnapshot>;
  doc(id: string): DbDocRef;
  onSnapshot?(next: (snap: DbQuerySnapshot) => void, error?: (e: { code?: string }) => void): () => void;
}
export interface DbLike { doc(path: string): DbDocRef; collection(path: string): DbCollectionRef }

interface Stamped { updatedAt: string }
type Docs = Record<string, Stamped>;
type Tombs = Record<string, string>;

interface Persisted {
  data: AppData;
  tombstones: Tombs;   // "<kind>/<id>" -> deletedAt
}

export const STORAGE_KEY = 'golf-buddy:v1';

const emptyData = (): AppData => ({ profile: null, rounds: {}, courses: {}, imports: {} });

function safeLocalStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** A timestamp strictly after `prev`, so two edits in one millisecond still order correctly. */
function stamp(prev?: string): string {
  let t = Date.now();
  if (prev) { const p = Date.parse(prev); if (!Number.isNaN(p) && p >= t) t = p + 1; }
  return new Date(t).toISOString();
}

function newer(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '') > (b ?? '');
}

/** JSON with sorted keys (undefined values dropped): equal content gives equal text on every device. */
export function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => (val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val as object).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
    : val));
}

/** Newer `updatedAt` wins; equal stamps with different content are settled by content, the same on every device. */
function pickNewer<T extends { updatedAt?: string }>(a: T, b: T): T {
  if (newer(a.updatedAt, b.updatedAt)) return a;
  if (newer(b.updatedAt, a.updatedAt)) return b;
  return canon(a) >= canon(b) ? a : b;
}

/** Picks one hole from two copies of a round. A hole saved before per-hole timestamps counts as changed when its
 *  round last changed; and a score is never lost to an empty hole when either side lacks its own timestamp. */
function pickHole(a: HoleScore, roundA: Round, b: HoleScore, roundB: Round): HoleScore {
  const filledA = typeof a.strokes === 'number';
  const filledB = typeof b.strokes === 'number';
  if (filledA !== filledB && (!a.updatedAt || !b.updatedAt)) return filledA ? a : b;
  const ta = a.updatedAt ?? roundA.updatedAt;
  const tb = b.updatedAt ?? roundB.updatedAt;
  if (newer(ta, tb)) return a;
  if (newer(tb, ta)) return b;
  return canon(a) >= canon(b) ? a : b;
}

/** Merges two copies of one round: each hole from the copy that changed it last, round fields from the newer copy.
 *  Commutative, so every device converges on the same round. */
export function mergeRound(a: Round, b: Round): Round {
  if (a === b || canon(a) === canon(b)) return a;
  const base = pickNewer(a, b);
  const other = base === a ? b : a;
  const holes = new Map<number, HoleScore>();
  for (const s of base.scores) holes.set(s.hole, s);
  for (const s of other.scores) {
    const h = holes.get(s.hole);
    holes.set(s.hole, h ? pickHole(h, base, s, other) : s);
  }
  const scores = [...holes.values()].sort((x, y) => x.hole - y.hole);
  return { ...base, scores, updatedAt: newer(a.updatedAt, b.updatedAt) ? a.updatedAt : b.updatedAt };
}

function isValidDoc(kind: Kind, body: unknown): body is Stamped {
  if (!body || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  if (typeof o.updatedAt !== 'string') return false;
  if (kind === 'rounds') return typeof o.id === 'string' && Array.isArray(o.scores) && typeof o.snapshot === 'object';
  if (kind === 'courses') return typeof o.id === 'string' && Array.isArray(o.holes) && Array.isArray(o.tees);
  if (kind === 'imports') return typeof o.id === 'string' && typeof o.differential === 'number';
  return true;
}

function isTombstone(body: unknown): body is { deleted: true; updatedAt: string } {
  const o = body as Record<string, unknown> | undefined;
  return !!o && o.deleted === true && typeof o.updatedAt === 'string';
}

/** Splits db documents into live copies and tombstones; anything malformed is ignored. */
function parseDocs(kind: Kind, snaps: DbDocSnapshot[]): { docs: Docs; tombs: Tombs } {
  const docs: Docs = {};
  const tombs: Tombs = {};
  for (const d of snaps) {
    if (!d.exists) continue;
    const body = d.data();
    if (isTombstone(body)) tombs[d.id] = body.updatedAt;
    else if (isValidDoc(kind, body)) docs[d.id] = JSON.parse(JSON.stringify(body)) as Stamped;
  }
  return { docs, tombs };
}

export interface MergeResult<T> {
  merged: Record<string, T>;
  push: string[];                       // ids whose live copy db needs (db lacks it, or holds something else)
  remove: string[];                     // ids whose tombstone db needs (deleted, and db does not say so yet)
  tombstones: Record<string, string>;   // tombstones in force, by id
}

/**
 * Merges one collection. Live copies: newest `updatedAt` wins, or `combine` (rounds: per hole). A tombstone (local
 * or remote, the newer of the two) beats any copy not changed after it; a copy changed after it wins.
 */
export function mergeDocs<T extends Stamped>(local: Record<string, T>, remote: Record<string, T>,
  tombstones: Tombs, remoteTombs: Tombs = {}, combine?: (a: T, b: T) => T): MergeResult<T> {
  const merged: Record<string, T> = {};
  const push: string[] = [];
  const remove: string[] = [];
  const tombs: Tombs = {};
  const ids = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(tombstones),
    ...Object.keys(remoteTombs)]);
  for (const id of ids) {
    const l = local[id];
    const r = remote[id];
    const lt = tombstones[id];
    const rt = remoteTombs[id];
    const t = newer(lt, rt) ? lt : rt;
    const live = l && r ? (combine ? combine(l, r) : pickNewer(l, r)) : l ?? r;
    if (t && (!live || !newer(live.updatedAt, t))) {
      tombs[id] = t;
      if (rt !== t) remove.push(id);
      continue;
    }
    if (!live) continue;
    merged[id] = live;
    if (!r || (live !== r && canon(live) !== canon(r))) push.push(id);
  }
  return { merged, push, remove, tombstones: tombs };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pick = <T>(rec: Record<string, T>, ids: string[]): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const id of ids) if (id in rec) out[id] = rec[id];
  return out;
};

/** The hole as the player sees it (without its timestamp), to tell whether a save changed it. */
const holeContent = (s: HoleScore) => { const { updatedAt: _u, ...rest } = s; return canon(rest); };

export interface StoreOptions {
  storage?: Storage | null;
  storageKey?: string;
  writeDelayMs?: number;     // coalesces a burst of taps into one write per document
  loadTimeoutMs?: number;
}

export class Store {
  private state: Persisted;
  private listeners = new Set<() => void>();
  private storage: Storage | null;
  private key: string;
  private writeDelay: number;
  private loadTimeout: number;
  private db: DbLike | null = null;
  private base = '';
  private loading = false;
  private connectArgs: { db: DbLike; uid: string } | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inflight = new Set<string>();
  private again = new Set<string>();
  private failed = new Set<string>();
  private running = new Map<string, Promise<void>>();
  private subs = new Map<Kind, () => void>();
  private status: SyncState = 'local';
  /** False when localStorage refused a write (private mode, full): the data then lives only in memory and db. */
  localOk = true;

  constructor(opts: StoreOptions = {}) {
    this.storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;
    this.key = opts.storageKey ?? STORAGE_KEY;
    this.writeDelay = opts.writeDelayMs ?? 600;
    this.loadTimeout = opts.loadTimeoutMs ?? 10_000;
    this.state = this.read() ?? { data: emptyData(), tombstones: {} };
  }

  // ----- reading ------------------------------------------------------------------------------------------------

  get data(): AppData { return this.state.data; }
  get sync(): SyncState { return this.status; }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // ----- writing ------------------------------------------------------------------------------------------------

  /** Saves a round. Every hole whose content changed from the stored copy gets the save's timestamp. */
  saveRound(round: Round): Round {
    const prev = this.state.data.rounds[round.id];
    const now = stamp(prev?.updatedAt);
    const scores = round.scores.map((s) => {
      const p = prev?.scores.find((x) => x.hole === s.hole) ?? { hole: s.hole, strokes: null };
      return holeContent(s) === holeContent(p) ? (p.updatedAt ? { ...s, updatedAt: p.updatedAt } : s)
        : { ...s, updatedAt: now };
    });
    const r = { ...round, scores, updatedAt: now };
    this.change('rounds', r.id, { ...this.state.data, rounds: { ...this.state.data.rounds, [r.id]: r } });
    return r;
  }

  deleteRound(id: string): void {
    const rounds = { ...this.state.data.rounds };
    const prev = rounds[id]?.updatedAt;
    delete rounds[id];
    this.change('rounds', id, { ...this.state.data, rounds }, prev ?? '');
  }

  saveCourse(course: Course): Course {
    const c = { ...course, updatedAt: stamp(this.state.data.courses[course.id]?.updatedAt) };
    this.change('courses', c.id, { ...this.state.data, courses: { ...this.state.data.courses, [c.id]: c } });
    return c;
  }

  deleteCourse(id: string): void {
    const courses = { ...this.state.data.courses };
    const prev = courses[id]?.updatedAt;
    delete courses[id];
    this.change('courses', id, { ...this.state.data, courses }, prev ?? '');
  }

  saveImport(imp: ImportedDifferential & { updatedAt?: string }): void {
    const prev = (this.state.data.imports[imp.id] as Partial<Stamped> | undefined)?.updatedAt;
    const i = { ...imp, updatedAt: stamp(prev) };
    this.change('imports', i.id, { ...this.state.data, imports: { ...this.state.data.imports, [i.id]: i } });
  }

  deleteImport(id: string): void {
    const imports = { ...this.state.data.imports };
    const prev = (imports[id] as Partial<Stamped> | undefined)?.updatedAt;
    delete imports[id];
    this.change('imports', id, { ...this.state.data, imports }, prev ?? '');
  }

  saveProfile(profile: Profile): void {
    const p = { ...profile, updatedAt: stamp(this.state.data.profile?.updatedAt) };
    this.change('profile', PROFILE_ID, { ...this.state.data, profile: p });
  }

  // ----- db -----------------------------------------------------------------------------------------------------

  /** Loads every document from db, merges, pushes what db lacks, then listens for changes made elsewhere.
   *  Resolves once the first merge is done or failed. */
  async connect(db: DbLike, uid: string): Promise<void> {
    this.connectArgs = { db, uid };
    if (this.loading || this.db) return;
    const base = `data/users/${uid}/golf`;
    this.loading = true;
    this.setStatus('syncing');
    try {
      const remote = await withTimeout(Promise.all(KINDS.map(async (kind) =>
        parseDocs(kind, (await db.collection(`${base}/${kind}`).get()).docs))), this.loadTimeout);

      const writes: string[] = [];
      KINDS.forEach((kind, i) => {
        const m = this.mergeKind(kind, remote[i].docs, remote[i].tombs);
        for (const id of [...m.push, ...m.remove]) writes.push(`${kind}/${id}`);
      });
      this.persist();
      this.db = db;
      this.base = base;
      this.loading = false;
      this.emit();
      for (const k of writes) this.schedule(k, 0);
      for (const k of this.failed) this.schedule(k, 0);
      this.updateStatus();
      this.listen();
    } catch {
      this.loading = false;
      this.setStatus('offline');
    }
  }

  /** Retries a connect that failed, listeners that ended, and writes that failed. Safe to call often. */
  retry(): void {
    if (!this.db && this.connectArgs && !this.loading) { void this.connect(this.connectArgs.db, this.connectArgs.uid); return; }
    this.listen();
    for (const k of [...this.failed]) this.schedule(k, 0);
  }

  /** Sends every queued write now and resolves when db has them (or they failed). */
  async flush(): Promise<void> {
    while (this.timers.size || this.running.size) {
      for (const [k, t] of [...this.timers]) { clearTimeout(t); this.timers.delete(k); void this.write(k); }
      await Promise.all([...this.running.values()]);
    }
  }

  /** Merges what another tab of this page saved (call on the window `storage` event). */
  mergeStored(): void {
    const stored = this.read();
    if (!stored) return;
    let changed = false;
    for (const kind of KINDS) {
      if (this.mergeKind(kind, this.docsOf(kind, stored.data), this.tombsOf(kind, stored.tombstones)).changed) changed = true;
    }
    if (canon(this.state) !== canon(stored)) this.persist();
    if (changed) this.emit();
  }

  /** Stops the db listeners (tests, teardown). */
  close(): void {
    for (const u of this.subs.values()) { try { u(); } catch { /* already gone */ } }
    this.subs.clear();
  }

  // ----- internals ----------------------------------------------------------------------------------------------

  /** One `onSnapshot` per collection, opened once after connect (and again only after a listener ended). */
  private listen(): void {
    const db = this.db;
    if (!db) return;
    for (const kind of KINDS) {
      if (this.subs.has(kind)) continue;
      const coll = db.collection(`${this.base}/${kind}`);
      if (typeof coll.onSnapshot !== 'function') continue;
      try {
        const unsub = coll.onSnapshot((snap) => this.onRemote(kind, snap), () => { this.subs.delete(kind); });
        this.subs.set(kind, unsub);
      } catch { /* this view cannot listen: edits from elsewhere arrive at the next load */ }
    }
  }

  private onRemote(kind: Kind, snap: DbQuerySnapshot): void {
    const remote = parseDocs(kind, snap.docs);
    const m = this.mergeKind(kind, remote.docs, remote.tombs);
    if (m.changed) { this.persist(); this.emit(); }
    // A cached view may simply be behind: only a confirmed snapshot says db lacks something.
    if (!snap.metadata?.fromCache) for (const id of [...m.push, ...m.remove]) this.schedule(`${kind}/${id}`, this.writeDelay);
  }

  /**
   * Merges remote copies and tombstones of one kind into the state (only `ids`, when given). Returns what db
   * needs and whether the state changed.
   */
  private mergeKind(kind: Kind, remote: Docs, remoteTombs: Tombs, ids?: string[]):
    { push: string[]; remove: string[]; changed: boolean } {
    const allLocal = this.docsOf(kind, this.state.data);
    const allTombs = this.tombsOf(kind, this.state.tombstones);
    const local = ids ? pick(allLocal, ids) : allLocal;
    const tombs = ids ? pick(allTombs, ids) : allTombs;
    const m = mergeDocs(local, remote, tombs, remoteTombs,
      kind === 'rounds' ? (mergeRound as unknown as (a: Stamped, b: Stamped) => Stamped) : undefined);
    let docs = m.merged;
    let kindTombs = m.tombstones;
    if (ids) {
      docs = { ...allLocal }; kindTombs = { ...allTombs };
      for (const id of ids) { delete docs[id]; delete kindTombs[id]; }
      Object.assign(docs, m.merged); Object.assign(kindTombs, m.tombstones);
    }
    const changed = canon(docs) !== canon(allLocal) || canon(kindTombs) !== canon(allTombs);
    if (changed) {
      const data = { ...this.state.data };
      if (kind === 'profile') data.profile = (docs[PROFILE_ID] as unknown as Profile) ?? null;
      else (data as unknown as Record<Kind, Docs>)[kind] = docs;
      const tombstones: Tombs = {};
      for (const [k, t] of Object.entries(this.state.tombstones)) if (!k.startsWith(`${kind}/`)) tombstones[k] = t;
      for (const [id, t] of Object.entries(kindTombs)) tombstones[`${kind}/${id}`] = t;
      this.state = { data, tombstones };
    }
    return { push: m.push, remove: m.remove, changed };
  }

  private docsOf(kind: Kind, data: AppData): Docs {
    if (kind === 'profile') return data.profile ? { [PROFILE_ID]: data.profile } : {};
    return data[kind] as unknown as Docs;
  }

  private tombsOf(kind: Kind, all: Tombs): Tombs {
    const out: Tombs = {};
    for (const [k, t] of Object.entries(all)) {
      if (k.startsWith(`${kind}/`)) out[k.slice(kind.length + 1)] = t;
    }
    return out;
  }

  /** `deletedAfter` (a deletion): the tombstone is stamped after the deleted copy's own `updatedAt`. */
  private change(kind: Kind, id: string, data: AppData, deletedAfter?: string): void {
    const tombstones = { ...this.state.tombstones };
    if (deletedAfter !== undefined) tombstones[`${kind}/${id}`] = stamp(deletedAfter || undefined);
    else delete tombstones[`${kind}/${id}`];
    this.state = { data, tombstones };
    this.persist();
    this.emit();
    if (this.db) this.schedule(`${kind}/${id}`, this.writeDelay);
  }

  private schedule(key: string, delay: number): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.write(key); }, delay));
    this.updateStatus();
  }

  /** One write at a time per document; a change made while a write is in flight is sent right after it. */
  private write(key: string): Promise<void> {
    if (!this.db) return Promise.resolve();
    if (this.inflight.has(key)) { this.again.add(key); return this.running.get(key) ?? Promise.resolve(); }
    this.inflight.add(key);
    this.updateStatus();
    const p = this.writeLoop(key);
    this.running.set(key, p);
    return p;
  }

  /** Reads the db copy, merges it in (so a stale view never overwrites newer scores), and writes only what db lacks. */
  private async writeLoop(key: string): Promise<void> {
    const db = this.db!;
    try {
      do {
        this.again.delete(key);
        const slash = key.indexOf('/');
        const kind = key.slice(0, slash) as Kind;
        const id = key.slice(slash + 1);
        const op = async () => {
          const ref = db.doc(`${this.base}/${kind}/${id}`);
          const snap = await ref.get();
          const remote = parseDocs(kind, [{ id, exists: snap.exists, data: () => snap.data() }]);
          const m = this.mergeKind(kind, remote.docs, remote.tombs, [id]);
          if (m.changed) { this.persist(); this.emit(); }
          if (m.push.includes(id)) {
            const body = this.docsOf(kind, this.state.data)[id];
            if (body) await ref.set(JSON.parse(JSON.stringify(body)));
          } else if (m.remove.includes(id)) {
            const t = this.tombsOf(kind, this.state.tombstones)[id];
            if (t) await ref.set({ deleted: true, updatedAt: t });
          }
        };
        try {
          await op();
          this.failed.delete(key);
        } catch (e) {
          const code = (e as { code?: string })?.code;
          if (code === 'unavailable' || code === undefined) {
            await sleep(400 + Math.random() * 800);
            try { await op(); this.failed.delete(key); } catch { this.failed.add(key); }
          } else this.failed.add(key);
        }
      } while (this.again.has(key));
    } finally {
      this.inflight.delete(key);
      this.running.delete(key);
      this.updateStatus();
    }
  }

  private updateStatus(): void {
    if (!this.db) { if (!this.loading && this.status !== 'offline') this.setStatus('local'); return; }
    if (this.inflight.size || this.timers.size) this.setStatus('syncing');
    else this.setStatus(this.failed.size ? 'offline' : 'synced');
  }

  private setStatus(s: SyncState): void {
    if (this.status === s) return;
    this.status = s;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) { try { fn(); } catch { /* a listener must not break the store */ } }
  }

  private read(): Persisted | null {
    try {
      const raw = this.storage?.getItem(this.key);
      if (raw) {
        const p = JSON.parse(raw) as Partial<Persisted>;
        const d = p.data ?? emptyData();
        return {
          data: { profile: d.profile ?? null, rounds: d.rounds ?? {}, courses: d.courses ?? {}, imports: d.imports ?? {} },
          tombstones: p.tombstones ?? {},
        };
      }
    } catch { /* unreadable local data: start empty, db may still restore it */ }
    return null;
  }

  /** Writes the state to localStorage, first merging what is stored there (another tab may have saved since). */
  private persist(): void {
    if (!this.storage) { this.localOk = false; return; }
    const stored = this.read();
    if (stored) {
      for (const kind of KINDS) this.mergeKind(kind, this.docsOf(kind, stored.data), this.tombsOf(kind, stored.tombstones));
    }
    try { this.storage.setItem(this.key, canon(this.state)); this.localOk = true; } catch { this.localOk = false; }
  }
}

/** Merges what other tabs of this page save to localStorage, as they save it. Returns the unsubscribe. */
export function watchOtherTabs(store: Store, target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  key = STORAGE_KEY): () => void {
  const onStorage = (e: Event) => {
    const k = (e as StorageEvent).key;
    if (k === null || k === key) store.mergeStored();
  };
  target.addEventListener('storage', onStorage);
  return () => target.removeEventListener('storage', onStorage);
}

type ClaudeWindow = { claude?: { use?: (name: string) => Promise<unknown> } };

/**
 * Connects the store to the page's `db` capability when this view has one. Never blocks first paint and never
 * throws: with no `window.claude`, no db, or no user id the app stays on local storage.
 */
export async function startSync(store: Store): Promise<void> {
  try {
    const claude = (globalThis as unknown as ClaudeWindow).claude;
    if (!claude?.use) return;
    const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]) as
      [DbLike | null, { id?: () => Promise<string | null> } | null];
    if (!db || !user?.id) return;
    const uid = await user.id();
    if (!uid) return;
    await store.connect(db, uid);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => store.retry());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void store.flush();
        else store.retry();
      });
    }
  } catch { /* stay local */ }
}

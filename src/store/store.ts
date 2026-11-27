// Local-first storage (plan section 6).
//
// Every change is written to localStorage at once (when it is available) and queued to the `db` capability.
// On load the page paints from local data; once `db` answers, each document is merged by `updatedAt` (newest
// wins), anything local that `db` lacks or holds older is pushed, and deletions travel as tombstones so a round
// deleted on this phone does not come back from the store.
//
// db layout (a document path has an even number of segments, so the per-user documents sit under one
// per-user "golf" document):
//   data/users/<id>/golf/profile/main
//   data/users/<id>/golf/rounds/<roundId>
//   data/users/<id>/golf/courses/<courseId>   (only courses the user added or edited)
//   data/users/<id>/golf/imports/<id>

import type { Course, ImportedDifferential, Profile, Round } from '../core/types';

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
export interface DbDocRef {
  get(): Promise<DbDocSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}
export interface DbCollectionRef { get(): Promise<{ docs: DbDocSnapshot[] }>; doc(id: string): DbDocRef }
export interface DbLike { doc(path: string): DbDocRef; collection(path: string): DbCollectionRef }

interface Stamped { updatedAt: string }
type Docs = Record<string, Stamped>;

interface Persisted {
  data: AppData;
  tombstones: Record<string, string>;   // "<kind>/<id>" -> deletedAt
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

function isValidDoc(kind: Kind, body: unknown): body is Stamped {
  if (!body || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  if (typeof o.updatedAt !== 'string') return false;
  if (kind === 'rounds') return typeof o.id === 'string' && Array.isArray(o.scores) && typeof o.snapshot === 'object';
  if (kind === 'courses') return typeof o.id === 'string' && Array.isArray(o.holes) && Array.isArray(o.tees);
  if (kind === 'imports') return typeof o.id === 'string' && typeof o.differential === 'number';
  return true;
}

export interface MergeResult<T> {
  merged: Record<string, T>;
  push: string[];                       // ids to write to db (local is newer or db lacks them)
  remove: string[];                     // ids to delete from db (deleted here after db's last change)
  tombstones: Record<string, string>;   // tombstones still in force, by id
}

/** Merges one collection: newest `updatedAt` wins; a tombstone beats any remote copy older than the deletion. */
export function mergeDocs<T extends Stamped>(local: Record<string, T>, remote: Record<string, T>,
  tombstones: Record<string, string>): MergeResult<T> {
  const merged: Record<string, T> = {};
  const push: string[] = [];
  const remove: string[] = [];
  const tombs: Record<string, string> = { ...tombstones };
  const ids = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(tombstones)]);
  for (const id of ids) {
    const l = local[id];
    const r = remote[id];
    const t = tombs[id];
    if (t && !l) {
      if (r && newer(r.updatedAt, t)) { merged[id] = r; delete tombs[id]; continue; }
      if (r) remove.push(id);
      continue;
    }
    if (l && r) {
      if (newer(r.updatedAt, l.updatedAt)) merged[id] = r;
      else { merged[id] = l; if (newer(l.updatedAt, r.updatedAt)) push.push(id); }
    } else if (l) { merged[id] = l; push.push(id); }
    else if (r) merged[id] = r;
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
  private status: SyncState = 'local';
  /** False when localStorage refused a write (private mode, full): the data then lives only in memory and db. */
  localOk = true;

  constructor(opts: StoreOptions = {}) {
    this.storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;
    this.key = opts.storageKey ?? STORAGE_KEY;
    this.writeDelay = opts.writeDelayMs ?? 600;
    this.loadTimeout = opts.loadTimeoutMs ?? 10_000;
    this.state = this.read();
  }

  // ----- reading ------------------------------------------------------------------------------------------------

  get data(): AppData { return this.state.data; }
  get sync(): SyncState { return this.status; }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // ----- writing ------------------------------------------------------------------------------------------------

  saveRound(round: Round): Round {
    const r = { ...round, updatedAt: stamp(this.state.data.rounds[round.id]?.updatedAt) };
    this.change('rounds', r.id, { ...this.state.data, rounds: { ...this.state.data.rounds, [r.id]: r } });
    return r;
  }

  deleteRound(id: string): void {
    const rounds = { ...this.state.data.rounds };
    delete rounds[id];
    this.change('rounds', id, { ...this.state.data, rounds }, true);
  }

  saveCourse(course: Course): Course {
    const c = { ...course, updatedAt: stamp(this.state.data.courses[course.id]?.updatedAt) };
    this.change('courses', c.id, { ...this.state.data, courses: { ...this.state.data.courses, [c.id]: c } });
    return c;
  }

  deleteCourse(id: string): void {
    const courses = { ...this.state.data.courses };
    delete courses[id];
    this.change('courses', id, { ...this.state.data, courses }, true);
  }

  saveImport(imp: ImportedDifferential & { updatedAt?: string }): void {
    const prev = (this.state.data.imports[imp.id] as Partial<Stamped> | undefined)?.updatedAt;
    const i = { ...imp, updatedAt: stamp(prev) };
    this.change('imports', i.id, { ...this.state.data, imports: { ...this.state.data.imports, [i.id]: i } });
  }

  deleteImport(id: string): void {
    const imports = { ...this.state.data.imports };
    delete imports[id];
    this.change('imports', id, { ...this.state.data, imports }, true);
  }

  saveProfile(profile: Profile): void {
    const p = { ...profile, updatedAt: stamp(this.state.data.profile?.updatedAt) };
    this.change('profile', PROFILE_ID, { ...this.state.data, profile: p });
  }

  // ----- db -----------------------------------------------------------------------------------------------------

  /** Loads every document from db, merges, and pushes what db lacks. Resolves once the merge is done or failed. */
  async connect(db: DbLike, uid: string): Promise<void> {
    this.connectArgs = { db, uid };
    if (this.loading || this.db) return;
    const base = `data/users/${uid}/golf`;
    this.loading = true;
    this.setStatus('syncing');
    try {
      const remote = await withTimeout(Promise.all(KINDS.map(async (kind) => {
        const docs: Docs = {};
        const snap = await db.collection(`${base}/${kind}`).get();
        for (const d of snap.docs) {
          if (!d.exists) continue;
          const body = d.data();
          if (isValidDoc(kind, body)) docs[d.id] = JSON.parse(JSON.stringify(body)) as Stamped;
        }
        return docs;
      })), this.loadTimeout);

      const data = { ...this.state.data };
      const tombstones: Record<string, string> = {};
      const writes: string[] = [];
      KINDS.forEach((kind, i) => {
        const local = this.docsOf(kind, this.state.data);
        const tombs = this.tombsOf(kind);
        const m = mergeDocs(local, remote[i], tombs);
        if (kind === 'profile') data.profile = (m.merged[PROFILE_ID] as unknown as Profile) ?? null;
        else (data as unknown as Record<Kind, Docs>)[kind] = m.merged;
        for (const [id, t] of Object.entries(m.tombstones)) tombstones[`${kind}/${id}`] = t;
        for (const id of [...m.push, ...m.remove]) writes.push(`${kind}/${id}`);
      });
      this.state = { data, tombstones };
      this.persist();
      this.db = db;
      this.base = base;
      this.loading = false;
      this.emit();
      for (const k of writes) this.schedule(k, 0);
      for (const k of this.failed) this.schedule(k, 0);
      this.updateStatus();
    } catch {
      this.loading = false;
      this.setStatus('offline');
    }
  }

  /** Retries a connect that failed, and writes that failed. Safe to call often (on `online`, on focus). */
  retry(): void {
    if (!this.db && this.connectArgs && !this.loading) { void this.connect(this.connectArgs.db, this.connectArgs.uid); return; }
    for (const k of [...this.failed]) this.schedule(k, 0);
  }

  /** Sends every queued write now and resolves when db has them (or they failed). */
  async flush(): Promise<void> {
    while (this.timers.size || this.running.size) {
      for (const [k, t] of [...this.timers]) { clearTimeout(t); this.timers.delete(k); void this.write(k); }
      await Promise.all([...this.running.values()]);
    }
  }

  // ----- internals ----------------------------------------------------------------------------------------------

  private docsOf(kind: Kind, data: AppData): Docs {
    if (kind === 'profile') return data.profile ? { [PROFILE_ID]: data.profile } : {};
    return data[kind] as unknown as Docs;
  }

  private tombsOf(kind: Kind): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, t] of Object.entries(this.state.tombstones)) {
      if (k.startsWith(`${kind}/`)) out[k.slice(kind.length + 1)] = t;
    }
    return out;
  }

  private change(kind: Kind, id: string, data: AppData, deleted = false): void {
    const tombstones = { ...this.state.tombstones };
    if (deleted) tombstones[`${kind}/${id}`] = stamp();
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

  private async writeLoop(key: string): Promise<void> {
    const db = this.db!;
    try {
      do {
        this.again.delete(key);
        const slash = key.indexOf('/');
        const kind = key.slice(0, slash) as Kind;
        const id = key.slice(slash + 1);
        const body = this.docsOf(kind, this.state.data)[id];
        const op = async () => {
          const ref = db.doc(`${this.base}/${kind}/${id}`);
          await (body ? ref.set(JSON.parse(JSON.stringify(body))) : ref.delete());
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

  private read(): Persisted {
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
    return { data: emptyData(), tombstones: {} };
  }

  private persist(): void {
    if (!this.storage) { this.localOk = false; return; }
    try { this.storage.setItem(this.key, JSON.stringify(this.state)); this.localOk = true; } catch { this.localOk = false; }
  }
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

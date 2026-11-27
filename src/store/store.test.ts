import { describe, expect, it } from 'vitest';
import type { Round } from '../core/types';
import { mergeDocs, mergeRound, Store, watchOtherTabs, type DbLike, type DbQuerySnapshot } from './store';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}

/** In-memory db that enforces the document-path parity rule of the real capability. Collection listeners hear
 *  every write at once unless `paused` (a view that misses updates). */
function memoryDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const writes: string[] = [];
  const listeners: { path: string; next: (s: DbQuerySnapshot) => void; paused: () => boolean }[] = [];
  const list = (path: string) => [...docs.entries()]
    .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
    .map(([p, d]) => ({ id: p.split('/').pop()!, exists: true, data: () => structuredClone(d) }));
  const notify = (docPath: string) => {
    for (const l of listeners) {
      if (docPath.startsWith(`${l.path}/`) && !l.paused()) l.next({ docs: list(l.path), metadata: { fromCache: false } });
    }
  };
  const check = (path: string, even: boolean) => {
    if ((path.split('/').length % 2 === 0) !== even) throw new TypeError(`bad parity: ${path}`);
  };
  const db: DbLike = {
    doc(path) {
      check(path, true);
      return {
        get: async () => ({ id: path.split('/').pop()!, exists: docs.has(path), data: () => docs.get(path) }),
        set: async (d) => { writes.push(`set ${path}`); docs.set(path, structuredClone(d)); notify(path); },
        delete: async () => { writes.push(`delete ${path}`); docs.delete(path); notify(path); },
      };
    },
    collection(path) {
      check(path, false);
      return {
        get: async () => ({ docs: list(path) }),
        doc: (id) => db.doc(`${path}/${id}`),
        onSnapshot: (next) => {
          const l = { path, next, paused: () => pausedFlag.value && listenerOwner.get(l) === pausedFlag.owner };
          listenerOwner.set(l, currentOwner.value);
          listeners.push(l);
          queueMicrotask(() => next({ docs: list(path), metadata: { fromCache: false } }));
          return () => { listeners.splice(listeners.indexOf(l), 1); };
        },
      };
    },
  };
  // Each Store gets its own view of the db (`as(owner)`), so one view can be paused while the other carries on.
  const listenerOwner = new Map<object, string>();
  const currentOwner = { value: '' };
  const pausedFlag = { value: false, owner: '' };
  const as = (owner: string): DbLike => ({
    doc: (p) => db.doc(p),
    collection: (p) => {
      const c = db.collection(p);
      return { ...c, onSnapshot: (n, e) => { currentOwner.value = owner; return c.onSnapshot!(n, e); } };
    },
  });
  const pause = (owner: string) => { pausedFlag.value = true; pausedFlag.owner = owner; };
  const resume = () => {
    const owner = pausedFlag.owner;
    pausedFlag.value = false;
    for (const l of listeners) if (listenerOwner.get(l) === owner) l.next({ docs: list(l.path), metadata: { fromCache: false } });
  };
  return { db, docs, writes, as, pause, resume };
}

function round(id: string, updatedAt: string, strokes = 4): Round {
  return {
    id, date: '2026-11-27', courseId: 'c', teeId: 't',
    snapshot: { courseName: 'C', teeName: 'T', rating: 70, slope: 120, par: 72, holes: [] },
    holesPlayed: '18', pcc: 0, scores: [{ hole: 1, strokes }], status: 'active', courseHandicap: null, updatedAt,
  };
}

describe('mergeDocs', () => {
  it('keeps the newest copy and lists what to push', () => {
    const local = { a: { updatedAt: '2026-01-02' }, b: { updatedAt: '2026-01-01' }, c: { updatedAt: '2026-01-01' } };
    const remote = { a: { updatedAt: '2026-01-01' }, b: { updatedAt: '2026-01-03' }, d: { updatedAt: '2026-01-01' } };
    const m = mergeDocs(local, remote, {});
    expect(m.merged.a).toBe(local.a);
    expect(m.merged.b).toBe(remote.b);
    expect(m.merged.d).toBe(remote.d);
    expect(m.push.sort()).toEqual(['a', 'c']);
    expect(m.remove).toEqual([]);
  });

  it('a deletion beats an older remote copy, but not a newer one', () => {
    const m = mergeDocs({}, { x: { updatedAt: '2026-01-01' }, y: { updatedAt: '2026-01-05' } },
      { x: '2026-01-02', y: '2026-01-02' });
    expect(m.merged.x).toBeUndefined();
    expect(m.remove).toEqual(['x']);
    expect(m.merged.y).toBeDefined();
    expect(m.tombstones).toEqual({ x: '2026-01-02' });
  });
});

const hole = (n: number, strokes: number | null, updatedAt?: string) =>
  ({ hole: n, strokes, ...(updatedAt ? { updatedAt } : {}) });

function roundWith(id: string, updatedAt: string, scores: Round['scores']): Round {
  return { ...round(id, updatedAt), scores };
}

describe('mergeRound', () => {
  const T = (m: number) => `2026-11-27T10:${String(m).padStart(2, '0')}:00.000Z`;
  it('takes each hole from the copy that changed it last, in both directions', () => {
    // a: holes 1-9 entered (newer per hole); b: a stale copy with holes 1-3 and hole 10 entered later.
    const a = roundWith('r', T(30), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => hole(n, 4, T(n))).concat([hole(10, null)]));
    const b = roundWith('r', T(40), [1, 2, 3].map((n) => hole(n, 4, T(n)))
      .concat([4, 5, 6, 7, 8, 9].map((n) => hole(n, null)), [hole(10, 6, T(40))]));
    for (const m of [mergeRound(a, b), mergeRound(b, a)]) {
      expect(m.scores.map((s) => s.strokes)).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 4, 6]);
      expect(m.updatedAt).toBe(T(40));
    }
    expect(JSON.stringify(mergeRound(a, b))).toBe(JSON.stringify(mergeRound(b, a)));
    // A later edit of the same hole wins whichever copy holds it.
    const c = roundWith('r', T(20), [hole(1, 7, T(50))]);
    expect(mergeRound(a, c).scores[0].strokes).toBe(7);
    expect(mergeRound(c, a).scores[0].strokes).toBe(7);
  });

  it('loads rounds saved without per-hole times: strokes beat an empty hole, else the newer round', () => {
    const old = roundWith('r', T(10), [hole(1, 5), hole(2, null)]);
    const fresh = roundWith('r', T(20), [hole(1, null), hole(2, 4)]);
    const m = mergeRound(old, fresh);
    expect(m.scores.map((s) => s.strokes)).toEqual([5, 4]);
    const both = mergeRound(roundWith('r', T(10), [hole(1, 5)]), roundWith('r', T(20), [hole(1, 6)]));
    expect(both.scores[0].strokes).toBe(6);
  });

  it('round-level fields come from the newer copy', () => {
    const a = { ...roundWith('r', T(10), [hole(1, 4, T(5))]), status: 'posted' as const };
    const b = { ...roundWith('r', T(20), [hole(1, null)]), pcc: 2 };
    const m = mergeRound(a, b);
    expect(m.status).toBe('active');
    expect(m.pcc).toBe(2);
    expect(m.scores[0].strokes).toBe(4);
  });
});

describe('tombstones', () => {
  it('a tombstone newer than a copy wins; an edit newer than the tombstone wins', () => {
    const copy = { updatedAt: '2026-01-02' };
    // Remote tombstone (deleted on another device) beats an older local copy, and nothing is pushed.
    let m = mergeDocs({ x: copy }, {}, {}, { x: '2026-01-03' });
    expect(m.merged.x).toBeUndefined();
    expect(m.tombstones).toEqual({ x: '2026-01-03' });
    expect(m.push).toEqual([]);
    expect(m.remove).toEqual([]);
    // A local copy edited after the deletion wins and is pushed over the tombstone.
    m = mergeDocs({ x: { updatedAt: '2026-01-04' } }, {}, {}, { x: '2026-01-03' });
    expect(m.merged.x).toBeDefined();
    expect(m.push).toEqual(['x']);
    expect(m.tombstones).toEqual({});
    // A local deletion db has not heard of is written as a tombstone.
    m = mergeDocs({}, { x: copy }, { x: '2026-01-03' });
    expect(m.remove).toEqual(['x']);
    m = mergeDocs({}, {}, { x: '2026-01-03' }, { x: '2026-01-03' });
    expect(m.remove).toEqual([]);
  });

  it('a round deleted on one device stays deleted when another device with a copy connects', async () => {
    const { db, docs } = memoryDb();
    const phone = new Store({ storage: memoryStorage(), writeDelayMs: 0 });
    const laptopStorage = memoryStorage();
    const laptop = new Store({ storage: laptopStorage, writeDelayMs: 0 });
    phone.saveRound(round('r', ''));
    await phone.connect(db, 'u1');
    await phone.flush();
    await laptop.connect(db, 'u1');
    expect(laptop.data.rounds.r).toBeDefined();
    laptop.close();                                        // the laptop goes away holding its copy
    phone.deleteRound('r');
    await phone.flush();
    const again = new Store({ storage: laptopStorage, writeDelayMs: 0 });   // laptop opens the app again
    expect(again.data.rounds.r).toBeDefined();
    await again.connect(db, 'u1');
    await again.flush();
    expect(again.data.rounds.r).toBeUndefined();
    expect(docs.get('data/users/u1/golf/rounds/r')).toMatchObject({ deleted: true });
    phone.close(); again.close();
  });
});

describe('Store sync across views', () => {
  it('a stale view never overwrites newer scores (live listener and read-before-write)', async () => {
    const mdb = memoryDb();
    const a = new Store({ storage: memoryStorage(), writeDelayMs: 0 });
    const b = new Store({ storage: memoryStorage(), writeDelayMs: 0 });
    await a.connect(mdb.as('a'), 'u1');
    await b.connect(mdb.as('b'), 'u1');
    const start = { ...round('r', ''), scores: Array.from({ length: 18 }, (_, i) => hole(i + 1, null)) };
    const set = (s: Store, n: number, strokes: number) => {
      const r = s.data.rounds.r;
      s.saveRound({ ...r, scores: r.scores.map((x) => (x.hole === n ? { ...x, strokes } : x)) });
    };
    a.saveRound(start);
    for (const n of [1, 2, 3]) set(a, n, 4);
    await a.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.data.rounds.r.scores[2].strokes).toBe(4);     // b heard holes 1-3
    mdb.pause('b');
    for (const n of [4, 5, 6, 7, 8, 9]) { set(a, n, 5); await a.flush(); }
    set(b, 10, 6);                                         // b still shows holes 1-3 only
    await b.flush();
    mdb.resume();
    await a.flush(); await b.flush();
    await new Promise((r) => setTimeout(r, 0));
    await a.flush(); await b.flush();
    const want = [4, 4, 4, 5, 5, 5, 5, 5, 5, 6];
    const first10 = (r: Round) => r.scores.slice(0, 10).map((x) => x.strokes);
    expect(first10(a.data.rounds.r)).toEqual(want);
    expect(first10(b.data.rounds.r)).toEqual(want);
    expect(first10(mdb.docs.get('data/users/u1/golf/rounds/r') as unknown as Round)).toEqual(want);
    a.close(); b.close();
  });

  it('merges another tab: saves merge with what is stored, and the storage event pulls the other tab in', () => {
    const storage = memoryStorage();
    const tab1 = new Store({ storage });
    const tab2 = new Store({ storage });
    const start = { ...round('r', ''), scores: [hole(1, null), hole(2, null)] };
    tab1.saveRound(start);
    tab2.mergeStored();
    expect(tab2.data.rounds.r).toBeDefined();
    tab1.saveRound({ ...tab1.data.rounds.r, scores: [hole(1, 4), hole(2, null)] });
    // tab2 has not heard of hole 1 and saves hole 2 from its stale copy: the stored blob keeps both.
    tab2.saveRound({ ...tab2.data.rounds.r, scores: [hole(1, null), hole(2, 5)] });
    const stored = JSON.parse(storage.getItem('golf-buddy:v1')!).data.rounds.r as Round;
    expect(stored.scores.map((x) => x.strokes)).toEqual([4, 5]);
    expect(tab2.data.rounds.r.scores.map((x) => x.strokes)).toEqual([4, 5]);
    // tab1 gets tab2's hole through the storage event.
    const target = new EventTarget();
    const stop = watchOtherTabs(tab1, target as unknown as Window);
    const ev = new Event('storage') as Event & { key: string };
    Object.defineProperty(ev, 'key', { value: 'golf-buddy:v1' });
    target.dispatchEvent(ev);
    expect(tab1.data.rounds.r.scores.map((x) => x.strokes)).toEqual([4, 5]);
    stop();
    // A deletion in one tab reaches the other.
    tab1.deleteRound('r');
    tab2.mergeStored();
    expect(tab2.data.rounds.r).toBeUndefined();
  });
});

describe('Store', () => {
  it('writes every change to local storage at once and reads it back', () => {
    const storage = memoryStorage();
    const s = new Store({ storage });
    s.saveRound(round('r1', ''));
    const again = new Store({ storage });
    expect(Object.keys(again.data.rounds)).toEqual(['r1']);
    expect(again.data.rounds.r1.updatedAt).not.toBe('');
  });

  it('works with no storage at all', () => {
    const s = new Store({ storage: null });
    s.saveRound(round('r1', ''));
    expect(s.data.rounds.r1).toBeDefined();
    expect(s.localOk).toBe(false);
  });

  it('merges from db on connect, pushes what db lacks, and syncs later edits', async () => {
    const { db, docs } = memoryDb();
    docs.set('data/users/u1/golf/rounds/remote', round('remote', '2026-01-01T00:00:00.000Z') as never);
    docs.set('data/users/u1/golf/rounds/both', round('both', '2030-01-01T00:00:00.000Z', 9) as never);
    const storage = memoryStorage();
    const s = new Store({ storage, writeDelayMs: 0 });
    s.saveRound(round('local', ''));
    s.saveRound(round('both', '', 3));
    await s.connect(db, 'u1');
    expect(Object.keys(s.data.rounds).sort()).toEqual(['both', 'local', 'remote']);
    expect(s.data.rounds.both.scores[0].strokes).toBe(9);           // db copy is newer
    await s.flush();
    expect(docs.has('data/users/u1/golf/rounds/local')).toBe(true);
    expect(s.sync).toBe('synced');

    s.saveRound({ ...s.data.rounds.local, scores: [{ hole: 1, strokes: 6 }] });
    await s.flush();
    expect((docs.get('data/users/u1/golf/rounds/local') as unknown as Round).scores[0].strokes).toBe(6);

    s.deleteRound('remote');
    await s.flush();
    expect(docs.get('data/users/u1/golf/rounds/remote')).toMatchObject({ deleted: true });   // a tombstone
    s.close();
  });

  it('stays local and reports offline when db never answers', async () => {
    const never: DbLike = {
      doc: () => { throw new Error('unused'); },
      collection: () => ({ get: () => new Promise(() => {}), doc: () => { throw new Error('unused'); } }),
    };
    const s = new Store({ storage: memoryStorage(), loadTimeoutMs: 20 });
    s.saveRound(round('r1', ''));
    await s.connect(never, 'u1');
    expect(s.sync).toBe('offline');
    expect(s.data.rounds.r1).toBeDefined();
  });
});

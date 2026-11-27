import { describe, expect, it } from 'vitest';
import type { Round } from '../core/types';
import { mergeDocs, Store, type DbLike } from './store';

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

/** In-memory db that enforces the document-path parity rule of the real capability. */
function memoryDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const writes: string[] = [];
  const check = (path: string, even: boolean) => {
    if ((path.split('/').length % 2 === 0) !== even) throw new TypeError(`bad parity: ${path}`);
  };
  const db: DbLike = {
    doc(path) {
      check(path, true);
      return {
        get: async () => ({ id: path.split('/').pop()!, exists: docs.has(path), data: () => docs.get(path) }),
        set: async (d) => { writes.push(`set ${path}`); docs.set(path, d); },
        delete: async () => { writes.push(`delete ${path}`); docs.delete(path); },
      };
    },
    collection(path) {
      check(path, false);
      return {
        get: async () => ({
          docs: [...docs.entries()]
            .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
            .map(([p, d]) => ({ id: p.split('/').pop()!, exists: true, data: () => d })),
        }),
        doc: (id) => db.doc(`${path}/${id}`),
      };
    },
  };
  return { db, docs, writes };
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
    expect(docs.has('data/users/u1/golf/rounds/remote')).toBe(false);
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

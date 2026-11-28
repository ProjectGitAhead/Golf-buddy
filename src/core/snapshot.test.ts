// Round snapshots keep scoring fields only (no greens, outlines or hazards), and stored rounds from before are cleaned.
import { describe, expect, it } from 'vitest';
import { findCourse } from '../data/courses';
import { Store, type DbLike } from '../store/store';
import { createRound } from '../ui/round';
import { cleanRound, scoringHole } from './snapshot';
import type { Round } from './types';

const rancho = findCourse('rancho-solano', {})!;
const tee = rancho.tees[0];
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
/** A round as the app created it before this fix: the course's holes copied whole. */
const bloated = (id: string, updatedAt: string): Round => {
  const r = createRound(rancho, tee, '18', '2026-11-20', 12.4);
  return { ...r, id, updatedAt, scores: r.scores.map((s) => ({ ...s, strokes: 5, updatedAt })),
    snapshot: { ...r.snapshot, holes: rancho.holes.map((h) => ({ ...h })) } };
};

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => { m.delete(k); }, setItem: (k, v) => { m.set(k, v); } };
}
function memoryDb(seed: Record<string, unknown>) {
  const docs = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v) as Record<string, unknown>]));
  const db: DbLike = {
    doc: (path) => ({ get: async () => ({ id: path.split('/').pop()!, exists: docs.has(path), data: () => docs.get(path) }),
      set: async (d) => { docs.set(path, structuredClone(d)); }, delete: async () => { docs.delete(path); } }),
    collection: (path) => ({
      get: async () => ({ docs: [...docs.entries()].filter(([p]) => p.startsWith(`${path}/`))
        .map(([p, d]) => ({ id: p.split('/').pop()!, exists: true, data: () => structuredClone(d) })) }),
      doc: (id) => db.doc(`${path}/${id}`),
    }),
  };
  return { db, docs };
}
const geometry = (r: Round) => r.snapshot.holes.some((h) => h.green || h.greenShape || h.hazards);

describe('round snapshots', () => {
  it('the shipped Rancho Solano course carries geometry; a new round does not, and stays under 3 KB', () => {
    expect(rancho.holes.filter((h) => h.hazards?.length).length).toBeGreaterThan(0);
    const r = createRound(rancho, tee, '18', '2026-11-28', 12.4);
    expect(geometry(r)).toBe(false);
    expect(r.snapshot.holes.every((h) => Object.keys(h).every((k) => ['number', 'par', 'strokeIndex', 'strokeIndexW'].includes(k)))).toBe(true);
    expect(r.snapshot.holes.map((h) => [h.par, h.strokeIndex])).toEqual(rancho.holes.map((h) => [h.par, h.strokeIndex]));
    expect(bytes(r)).toBeLessThan(3 * 1024);
    expect(bytes(bloated('x', 'z'))).toBeGreaterThan(20 * 1024);
  });
  it('is an allow-list: an unknown hole field is not copied', () => {
    expect(scoringHole({ number: 1, par: 4, strokeIndex: 3, strokeIndexW: 5, future: 1 } as never)).toEqual({ number: 1, par: 4, strokeIndex: 3, strokeIndexW: 5 });
  });
  it('cleaning keeps the stamp and returns a clean round unchanged', () => {
    const b = bloated('r1', '2026-11-20T10:00:00.000Z');
    const c = cleanRound(b);
    expect(geometry(c)).toBe(false);
    expect(c.updatedAt).toBe(b.updatedAt);
    expect(c.scores).toEqual(b.scores);
    expect(cleanRound(c)).toBe(c);
  });
});

describe('stored rounds from before', () => {
  it('are cleaned on load and written back once', () => {
    const storage = memoryStorage();
    storage.setItem('golf-buddy:v1', JSON.stringify({ data: { profile: null, rounds: { r1: bloated('r1', '2026-11-20T10:00:00.000Z') }, courses: {}, imports: {} }, tombstones: {} }));
    const before = storage.getItem('golf-buddy:v1')!.length;
    const s = new Store({ storage });
    expect(geometry(s.data.rounds.r1)).toBe(false);
    expect(s.data.rounds.r1.updatedAt).toBe('2026-11-20T10:00:00.000Z');
    const after = storage.getItem('golf-buddy:v1')!;
    expect(after.length).toBeLessThan(before / 5);
    expect(after).not.toContain('greenShape');
  });

  it('stay clean after a sync merge with a bloated copy (older, same or newer), and db gets the clean copy', async () => {
    for (const remoteStamp of ['2026-11-20T09:00:00.000Z', '2026-11-20T10:00:00.000Z', '2026-11-20T11:00:00.000Z']) {
      const storage = memoryStorage();
      storage.setItem('golf-buddy:v1', JSON.stringify({ data: { profile: null, rounds: { r1: bloated('r1', '2026-11-20T10:00:00.000Z') }, courses: {}, imports: {} }, tombstones: {} }));
      const { db, docs } = memoryDb({ 'data/users/u1/golf/rounds/r1': bloated('r1', remoteStamp),
        'data/users/u1/golf/rounds/r2': bloated('r2', remoteStamp) });
      const s = new Store({ storage, writeDelayMs: 0 });
      await s.connect(db, 'u1');
      await s.flush();
      for (const id of ['r1', 'r2']) {
        expect(geometry(s.data.rounds[id])).toBe(false);
        expect(geometry(docs.get(`data/users/u1/golf/rounds/${id}`) as unknown as Round)).toBe(false);
      }
      expect(s.data.rounds.r1.updatedAt).toBe(remoteStamp > '2026-11-20T10:00:00.000Z' ? remoteStamp : '2026-11-20T10:00:00.000Z');
      expect(storage.getItem('golf-buddy:v1')).not.toContain('greenShape');
    }
  });
});

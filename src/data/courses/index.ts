// Courses that ship inside the page. A user-edited copy (same id) saved through the store replaces the bundled one.
// A bundled course may also ship a greens file (`<id>.greens.json`, written at build time by scripts/fetch-greens.mjs
// from OpenStreetMap, plan section 15.3): its greens fill every hole that has none, on the bundled course and on the
// user's own copy of it, so live yardage works with no lookup. A green already on the hole (saved by hand, or loaded
// on the phone) always wins.
import type { Course } from '../../core/types';
import ranchoSolano from './rancho-solano.json';
import ranchoSolanoGreens from './rancho-solano.greens.json';

/** A greens file as scripts/fetch-greens.mjs writes it. `holes` is keyed by hole number. */
export interface GreensFile {
  fetchedAt: string | null;
  source: string | null;
  holes: Record<string, { green: { lat: number; lon: number }; greenShape: [number, number][] }>;
}

/** The course with the file's greens on every hole that has no green of its own. Nothing else changes. */
export function mergeGreens(c: Course, file: GreensFile | undefined): Course {
  if (!file || !Object.keys(file.holes).length) return c;
  return {
    ...c,
    holes: c.holes.map((h) => {
      const g = file.holes[String(h.number)];
      if (h.green || !g) return h;
      return { ...h, green: { lat: g.green.lat, lon: g.green.lon }, greenShape: g.greenShape.map((p) => [p[0], p[1]] as [number, number]) };
    }),
  };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A greens file read from JSON, checked: a point that is not two finite numbers is dropped, and so is a hole whose
 *  green centre is not two finite numbers. JSON gives `number[][]`, so this is where it becomes `[number, number][]`. */
export function toGreensFile(raw: unknown): GreensFile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { fetchedAt?: unknown; source?: unknown; holes?: unknown };
  const holes: GreensFile['holes'] = {};
  if (r.holes && typeof r.holes === 'object') {
    for (const [n, v] of Object.entries(r.holes as Record<string, unknown>)) {
      const h = (v && typeof v === 'object' ? v : {}) as { green?: { lat?: unknown; lon?: unknown }; greenShape?: unknown };
      const lat = h.green?.lat, lon = h.green?.lon;
      if (!finite(lat) || !finite(lon)) continue;
      const shape = Array.isArray(h.greenShape) ? h.greenShape : [];
      const greenShape = shape
        .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]))
        .map((p) => [p[0], p[1]] as [number, number]);
      holes[n] = { green: { lat, lon }, greenShape };
    }
  }
  return {
    fetchedAt: typeof r.fetchedAt === 'string' ? r.fetchedAt : null,
    source: typeof r.source === 'string' ? r.source : null,
    holes,
  };
}

const bundledGreens: Record<string, GreensFile> = { 'rancho-solano': toGreensFile(ranchoSolanoGreens) };

// The page must hold no URL text (plan section 2), so source links are kept as bare host/path text.
function bundled(c: Course): Course {
  return mergeGreens({ ...c, sources: (c.sources ?? []).map((s) => s.replace(/^[a-z]+:\/\//i, '')) }, bundledGreens[c.id]);
}

export const bundledCourses: Course[] = [bundled(ranchoSolano as Course)];

export function isBundledCourse(id: string): boolean {
  return bundledCourses.some((c) => c.id === id);
}

/** The user's copy of a course, with the bundled greens filling holes it has no green for. */
const own = (c: Course) => mergeGreens(c, bundledGreens[c.id]);

/** Bundled courses overlaid with the user's own courses (user copies win), sorted by name. */
export function allCourses(userCourses: Record<string, Course>): Course[] {
  const byId = new Map<string, Course>();
  for (const c of bundledCourses) byId.set(c.id, c);
  for (const c of Object.values(userCourses)) byId.set(c.id, own(c));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findCourse(id: string, userCourses: Record<string, Course>): Course | undefined {
  const mine = userCourses[id];
  return mine ? own(mine) : bundledCourses.find((c) => c.id === id);
}

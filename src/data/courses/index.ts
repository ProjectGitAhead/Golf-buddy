// Courses that ship inside the page. A user-edited copy (same id) saved through the store replaces the bundled one.
import type { Course } from '../../core/types';
import ranchoSolano from './rancho-solano.json';

// The page must hold no URL text (plan section 2), so source links are kept as bare host/path text.
function bundled(c: Course): Course {
  return { ...c, sources: (c.sources ?? []).map((s) => s.replace(/^[a-z]+:\/\//i, '')) };
}

export const bundledCourses: Course[] = [bundled(ranchoSolano as Course)];

export function isBundledCourse(id: string): boolean {
  return bundledCourses.some((c) => c.id === id);
}

/** Bundled courses overlaid with the user's own courses (user copies win), sorted by name. */
export function allCourses(userCourses: Record<string, Course>): Course[] {
  const byId = new Map<string, Course>();
  for (const c of bundledCourses) byId.set(c.id, c);
  for (const c of Object.values(userCourses)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findCourse(id: string, userCourses: Record<string, Course>): Course | undefined {
  return userCourses[id] ?? bundledCourses.find((c) => c.id === id);
}

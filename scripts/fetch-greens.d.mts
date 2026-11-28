// Types for scripts/fetch-greens.mjs, so the unit test can import it.
import type { Course } from '../src/core/types';

export const BUILD_RADIUS_M: number;
export const BUILD_TIMEOUT_MS: number;
export const MAX_FILE_BYTES: number;
export function formatGreensFile(file: unknown): string;
export function loadLib(): Promise<unknown>;
export function fetchGreens(opts: {
  course: Course;
  lib: unknown;
  outFile: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: () => Date;
  io?: { exists(f: string): boolean; read(f: string): string; write(f: string, text: string): void };
}): Promise<{ written: boolean; matched: number; missing: number[] }>;

import { describe, expect, it } from 'vitest';
import { computeHistory } from '../../core/handicap';
import type { ImportedDifferential } from '../../core/types';
import { indexNote } from './index-note';

const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString().slice(0, 10);
const imports = (diffs: number[]): ImportedDifferential[] =>
  diffs.map((d, i) => ({ id: `i${String(i).padStart(2, '0')}`, date: day(i), differential: d }));
const note = (diffs: number[], startingIndex?: number) =>
  indexNote(computeHistory([], imports(diffs), { gender: 'M', startingIndex, updatedAt: '' }));

describe('indexNote', () => {
  it('3 and 4 scores: the best differential with its value and the adjustment', () => {
    expect(note([20, 15.2, 18])).toBe('Your best differential of your 3 scores, 15.2, minus 2.0 (the adjustment for 3 scores).');
    expect(note([16.8, 12.4, 23, 30.1])).toBe('Your best differential of your 4 scores, 12.4, minus 1.0 (the adjustment for 4 scores).');
  });
  it('5 scores: the best differential, no adjustment', () => {
    expect(note([16.8, 12.4, 23, 30.1, 14])).toBe('Your best differential of your 5 scores, 12.4.');
  });
  it('6 scores: the average of the best 2, minus 1.0', () => {
    expect(note([16.8, 12.4, 23, 30.1, 14, 19])).toBe(
      'The average of your best 2 differentials of your 6 scores: 12.4 and 14.0, minus 1.0 (the adjustment for 6 scores).');
  });
  it('20 scores: the average of the best 8, listed lowest first', () => {
    const diffs = [20, 11.2, 25, 13.4, 19, 12.1, 22, 14.8, 18, 10.5, 24, 16.3, 21, 15.6, 23, 17.7, 26, 9.9, 27, 28];
    expect(note(diffs)).toBe('The average of your best 8 differentials of your 20 most recent scores: '
      + '9.9, 10.5, 11.2, 12.1, 13.4, 14.8, 15.6 and 16.3.');
  });
  it('below zero is written with a minus sign', () => {
    expect(note([-1.2, 3, 4, 5, 6])).toBe('Your best differential of your 5 scores, −1.2.');
  });
  it('fewer than 3: the starting index, or none', () => {
    expect(note([20, 18], 18.4)).toBe('The index you entered, used until you have 3 scores. You have 2.');
    expect(note([20])).toBe('A calculated index needs 3 scores. You have 1.');
  });
});

// Data model shared by every part of the app (plan section 4). Keep in step with the plan.

export type Gender = 'M' | 'W';
export interface Hole { number: number; par: number; strokeIndex: number; strokeIndexW?: number }
export interface Tee {
  id: string; name: string; gender: Gender;
  rating: number; slope: number; par: number;          // 18-hole values
  frontRating?: number; frontSlope?: number; backRating?: number; backSlope?: number;
  yardages: number[];                                    // length 18, hole order
}
export interface Course {
  id: string; name: string; city?: string; state?: string;
  holes: Hole[];                                         // length 18
  tees: Tee[];
  sources?: string[]; verified: boolean; updatedAt: string;
}
export type FairwayResult = 'hit' | 'left' | 'right' | 'short' | 'long';
export interface ApproachMark {     // where the ball finished relative to the pin, seen from where it was hit
  xFt: number;                      // + right of the pin, - left
  yFt: number;                      // + past the pin (long), - short
  onGreen: boolean; source: 'photo' | 'manual'; confidence?: number;
}
export interface HoleScore {
  hole: number; strokes: number | null;
  putts?: number; fairway?: FairwayResult; penalties?: number; sand?: boolean;
  approach?: ApproachMark;
  updatedAt?: string;               // when this hole last changed (absent on rounds saved before per-hole merging)
}
export interface Round {
  id: string; date: string;                              // ISO date
  courseId: string; teeId: string;
  snapshot: { courseName: string; teeName: string; rating: number; slope: number; par: number;
              holes: Hole[] };                           // frozen at start; for 9-hole rounds the 9-hole values
  holesPlayed: '18' | 'F9' | 'B9';
  pcc: number;                                           // -1..3, default 0
  scores: HoleScore[];
  status: 'active' | 'posted';
  courseHandicap: number | null;                         // at the time of play
  updatedAt: string;
}
export interface ImportedDifferential { id: string; date: string; differential: number; note?: string }
export interface Profile { name?: string; gender: Gender; startingIndex?: number; homeCourseId?: string;
                           defaultTeeId?: string; updatedAt: string }

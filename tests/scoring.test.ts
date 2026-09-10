import { describe, it, expect } from 'vitest';
import {
  scoreRun,
  verdictFor,
  endlessStageScore,
  STAR_THRESHOLDS,
} from '../src/core/scoring';

const perfect = () =>
  scoreRun({ glasses: [{ volume: 1, target: 1 }], poured: 1, spilled: 0 });

describe('scoring', () => {
  it('awards three stars for a perfect, clean pour', () => {
    const result = perfect();
    expect(result.accuracy).toBe(1);
    expect(result.cleanliness).toBe(1);
    expect(result.stars).toBe(3);
    expect(result.points).toBe(1000);
    expect(verdictFor(result)).toBe('perfect');
  });

  it('scores 0 stars and fails a wildly wrong fill', () => {
    const result = scoreRun({ glasses: [{ volume: 0.2, target: 1 }], poured: 1, spilled: 0 });
    expect(result.passed).toBe(false);
    expect(result.stars).toBe(0);
    expect(verdictFor(result)).toBe('failed');
  });

  it('penalises overfilling and underfilling symmetrically', () => {
    const short = scoreRun({ glasses: [{ volume: 0.85, target: 1 }], poured: 0.85, spilled: 0 });
    const over = scoreRun({ glasses: [{ volume: 1.15, target: 1 }], poured: 1.15, spilled: 0 });
    expect(short.accuracy).toBeCloseTo(over.accuracy, 6);
    expect(verdictFor(short)).toBe('short');
    expect(verdictFor(over)).toBe('overfilled');
  });

  it('decreases monotonically as fill error grows', () => {
    let previous = Infinity;
    for (const volume of [1, 1.05, 1.1, 1.2, 1.35, 1.5]) {
      const result = scoreRun({ glasses: [{ volume, target: 1 }], poured: volume, spilled: 0 });
      expect(result.points).toBeLessThan(previous);
      previous = result.points;
    }
  });

  it('withholds the third star from a messy but accurate pour', () => {
    const result = scoreRun({ glasses: [{ volume: 1, target: 1 }], poured: 2, spilled: 1 });
    expect(result.accuracy).toBe(1);
    expect(result.stars).toBe(2);
    expect(verdictFor(result)).toBe('messy');
  });

  it('gates multi-glass levels on the worst glass, not the average', () => {
    const lopsided = scoreRun({
      glasses: [
        { volume: 1, target: 1 },
        { volume: 0.75, target: 1 },
      ],
      poured: 1.75,
      spilled: 0,
    });
    expect(lopsided.accuracy).toBeGreaterThan(STAR_THRESHOLDS[0]);
    expect(lopsided.weakest).toBeLessThan(STAR_THRESHOLDS[0]);
    expect(lopsided.stars).toBe(0);
  });

  it('tightens with a smaller tolerance', () => {
    const glasses = [{ volume: 1.1, target: 1 }];
    const lenient = scoreRun({ glasses, poured: 1.1, spilled: 0, tolerance: 0.6 });
    const strict = scoreRun({ glasses, poured: 1.1, spilled: 0, tolerance: 0.25 });
    expect(strict.accuracy).toBeLessThan(lenient.accuracy);
    expect(strict.stars).toBeLessThanOrEqual(lenient.stars);
  });

  it('treats a pour that never started as a total failure, not a clean sheet', () => {
    const result = scoreRun({ glasses: [{ volume: 0, target: 1 }], poured: 0, spilled: 0 });
    expect(result.stars).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('scales endless scores by stage and combo, and zeroes failed stages', () => {
    const result = perfect();
    const early = endlessStageScore(result, 1, 0);
    const late = endlessStageScore(result, 12, 0);
    const combo = endlessStageScore(result, 12, 5);
    expect(late).toBeGreaterThan(early);
    expect(combo).toBeGreaterThan(late);
    expect(endlessStageScore({ ...result, passed: false, stars: 0 }, 12, 5)).toBe(0);
  });

  it('caps the combo multiplier so a long run cannot run away', () => {
    const result = perfect();
    expect(endlessStageScore(result, 5, 10)).toBe(endlessStageScore(result, 5, 40));
  });
});

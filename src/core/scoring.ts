import { clamp01 } from './geometry';

export interface GlassOutcome {
  volume: number;
  target: number;
}

export interface ScoreInput {
  glasses: readonly GlassOutcome[];
  /** Total volume that left the jug. */
  poured: number;
  /** Volume that ended up anywhere other than a glass. */
  spilled: number;
  /**
   * Relative fill error at which accuracy reaches zero. Later worlds shrink
   * this, which is how the campaign gets stricter without changing the geometry.
   */
  tolerance?: number;
}

export interface ScoreResult {
  /** Mean per-glass precision, 0..1. */
  accuracy: number;
  /** Worst single glass, 0..1. Multi-glass levels are gated on this. */
  weakest: number;
  /** 1 - share of the pour that was spilled, 0..1. */
  cleanliness: number;
  points: number;
  stars: 0 | 1 | 2 | 3;
  passed: boolean;
  /** Signed relative error per glass: negative = short, positive = overfilled. */
  errors: number[];
}

/** Precision is what earns stars; spill is a smaller, separate tax. */
export const ACCURACY_WEIGHT = 0.75;
export const CLEANLINESS_WEIGHT = 0.25;
export const DEFAULT_TOLERANCE = 0.5;

/** A glass must be at least this accurate to earn each star. */
export const STAR_THRESHOLDS: readonly [number, number, number] = [0.6, 0.82, 0.94];
/** Three stars also demands a tidy pour — you cannot slop your way to gold. */
export const THREE_STAR_CLEANLINESS = 0.9;

export function scoreRun(input: ScoreInput): ScoreResult {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
  const errors: number[] = [];
  const accuracies: number[] = [];

  for (const glass of input.glasses) {
    if (glass.target <= 0) continue;
    const signed = (glass.volume - glass.target) / glass.target;
    errors.push(signed);
    accuracies.push(clamp01(1 - Math.abs(signed) / tolerance));
  }

  const accuracy =
    accuracies.length > 0 ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : 0;
  const weakest = accuracies.length > 0 ? Math.min(...accuracies) : 0;
  const cleanliness = input.poured > 0 ? clamp01(1 - input.spilled / input.poured) : 1;

  const points = Math.round(
    1000 * (ACCURACY_WEIGHT * accuracy + CLEANLINESS_WEIGHT * cleanliness),
  );

  let stars: 0 | 1 | 2 | 3 = 0;
  // Gate on the weakest glass so a multi-glass level cannot be won by
  // over-serving one and ignoring the other.
  if (weakest >= STAR_THRESHOLDS[2] && cleanliness >= THREE_STAR_CLEANLINESS) stars = 3;
  else if (weakest >= STAR_THRESHOLDS[1]) stars = 2;
  else if (weakest >= STAR_THRESHOLDS[0]) stars = 1;

  return {
    accuracy,
    weakest,
    cleanliness,
    points,
    stars,
    passed: stars > 0,
    errors,
  };
}

export type Verdict = 'perfect' | 'short' | 'overfilled' | 'messy' | 'failed';

/**
 * The one-word read-out the player gets. Precision problems outrank spill
 * problems, since precision is the skill the game is actually teaching.
 */
export function verdictFor(result: ScoreResult): Verdict {
  if (!result.passed) return 'failed';
  if (result.stars === 3) return 'perfect';
  const worst = result.errors.reduce(
    (acc, e) => (Math.abs(e) > Math.abs(acc) ? e : acc),
    0,
  );
  if (Math.abs(worst) < 0.06) {
    return result.cleanliness < THREE_STAR_CLEANLINESS ? 'messy' : 'perfect';
  }
  return worst < 0 ? 'short' : 'overfilled';
}

/** Endless mode: a run's score is cumulative, with a combo for clean stages. */
export function endlessStageScore(
  result: ScoreResult,
  stage: number,
  combo: number,
): number {
  if (!result.passed) return 0;
  const stageBonus = 1 + stage * 0.08;
  const comboBonus = 1 + Math.min(combo, 10) * 0.1;
  return Math.round(result.points * stageBonus * comboBonus);
}

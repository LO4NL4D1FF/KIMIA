import { Rng, hashSeed } from '../core/rng';
import { clamp, lerp } from '../core/geometry';
import { TABLE_Y } from '../core/simulation';
import {
  MAX_ROCK,
  MAX_TILT,
  MAX_TRAVEL,
  MIN_STREAM_GAP,
  defaultAimFor,
  jugHeightFor,
} from './campaign';
import { type GlassSpec, type LevelSpec, type Mechanic, type ObstacleSpec } from './types';

/**
 * Endless mode.
 *
 * Draws from the same mechanic pool as the campaign but escalates continuously
 * instead of following a script: mechanics unlock over the first stages, then
 * stack, and every parameter keeps creeping. Intensity is unbounded but
 * saturating, so stage 200 is brutal without becoming literally impossible.
 */

/** Stage at which each mechanic first appears. */
const UNLOCK_AT: Record<Mechanic, number> = {
  still: 1,
  tilt: 3,
  spin: 6,
  obstacle: 10,
  multi: 15,
};

export function endlessUnlocked(stage: number): Mechanic[] {
  return (Object.keys(UNLOCK_AT) as Mechanic[]).filter((m) => stage >= UNLOCK_AT[m]);
}

/**
 * 0 -> 1 escalation curve. Reaches ~0.5 by stage 15 and ~0.9 by stage 60, then
 * keeps inching up without ever hitting 1.
 */
export function escalation(stage: number): number {
  return 1 - 1 / (1 + Math.max(0, stage - 1) / 14);
}

/** How many mechanics are stacked on one stage. */
function stackSize(stage: number, rng: Rng): number {
  const available = endlessUnlocked(stage).filter((m) => m !== 'still').length;
  if (available === 0) return 0;
  const pressure = escalation(stage);
  const base = 1 + Math.floor(pressure * 3);
  return clamp(base + (rng.next() < pressure ? 1 : 0), 1, available);
}

export function buildEndlessStage(stage: number, runSeed: number): LevelSpec {
  const n = Math.max(1, Math.round(stage));
  const rng = new Rng(hashSeed(`endless-${runSeed}-${n}`));
  const t = escalation(n);

  const glass: GlassSpec = {
    x: rng.jitter(0.07),
    y: TABLE_Y,
    width: lerp(0.25, 0.15, t) + rng.jitter(0.01),
    height: lerp(0.24, 0.36, t),
    angle: 0,
    targetFraction: clamp(lerp(0.75, 0.55, t) + rng.jitter(0.08), 0.4, 0.88),
  };
  // Odd shapes arrive as an extra twist once the basics are stacked.
  if (t > 0.45 && rng.next() < 0.35) glass.taper = lerp(0.9, 0.55, t);
  if (t > 0.6 && rng.next() < 0.3) {
    glass.waist = lerp(0.85, 0.55, t);
    glass.waistAt = rng.range(0.35, 0.65);
  }

  const glasses = [glass];
  const obstacles: ObstacleSpec[] = [];
  const mechanics: Mechanic[] = ['still'];

  const pool = endlessUnlocked(n).filter((m) => m !== 'still');
  const chosen = new Set<Mechanic>();
  const wanted = stackSize(n, rng);
  // Shuffle-free weighted draw: keeps the same mechanics from recurring every
  // stage while staying deterministic for a given run seed.
  while (chosen.size < wanted && chosen.size < pool.length) {
    chosen.add(pool[rng.int(0, pool.length - 1)]);
  }

  if (chosen.has('tilt')) {
    glass.angle = (rng.next() < 0.5 ? -1 : 1) * lerp(0.14, MAX_TILT, t);
    mechanics.push('tilt');
  }
  if (chosen.has('spin')) {
    // Same turntable reading as the campaign: rock plus travel, never a tumble,
    // because a glass past ~50 degrees holds nothing at all.
    glass.wobble = { amplitude: lerp(0.14, MAX_ROCK, t), frequency: lerp(0.25, 0.85, t) };
    glass.orbit = {
      radiusX: lerp(0.03, MAX_TRAVEL, t) * (rng.next() < 0.5 ? -1 : 1),
      frequency: lerp(0.2, 0.55, t),
    };
    mechanics.push('spin');
  }
  if (chosen.has('multi')) {
    const separation = lerp(0.2, 0.32, t);
    glass.x = -separation * 0.5;
    glasses.push({
      ...glass,
      x: separation * 0.5,
      angle: chosen.has('tilt') ? -glass.angle * 0.6 : 0,
      targetFraction: clamp(glass.targetFraction + rng.jitter(0.16), 0.35, 0.88),
    });
    mechanics.push('multi');
  }
  if (chosen.has('obstacle')) {
    const rimY = glass.y + glass.height;
    obstacles.push(
      rng.next() < 0.5
        ? {
            kind: 'bar',
            x: glass.x + rng.jitter(0.06),
            y: rimY + lerp(0.11, 0.05, t),
            angle: rng.jitter(0.6),
            length: Math.min(
              Math.max(0.05, glass.width - MIN_STREAM_GAP),
              glass.width * lerp(0.5, 0.9, t),
            ),
            thickness: 0.02,
            ...(t > 0.5
              ? { wobble: { amplitude: lerp(0.3, 0.8, t), frequency: lerp(0.25, 0.6, t) } }
              : {}),
          }
        : {
            kind: 'funnel',
            x: glass.x,
            y: rimY + lerp(0.17, 0.09, t),
            angle: 0,
            length: lerp(0.3, 0.2, t),
            gap: Math.max(MIN_STREAM_GAP, lerp(0.12, 0.075, t)),
            depth: 0.075,
            ...(t > 0.55 ? { orbit: { radiusX: lerp(0.03, 0.1, t), frequency: 0.35 } } : {}),
          },
    );
    mechanics.push('obstacle');
  }

  return {
    id: `endless-${runSeed}-${n}`,
    world: 0,
    index: n,
    name: `Stage ${n}`,
    mechanics,
    glasses,
    obstacles,
    jug: {
      x: defaultAimFor(glasses),
      y: jugHeightFor(glasses),
      // Less and less slack: late stages punish every wasted drop.
      chargeFactor: lerp(1.6, 1.18, t),
      movable: true,
    },
    // Stages get shorter as well as harder — the clock is part of the pressure.
    timeLimit: Math.round(lerp(24, 13, t)),
    tolerance: Number(lerp(0.5, 0.2, t).toFixed(4)),
    isBoss: false,
    seed: hashSeed(`endless-${runSeed}-${n}-sim`),
  };
}

/** Lives-style run state for an endless attempt. */
export interface EndlessRun {
  seed: number;
  stage: number;
  score: number;
  combo: number;
  lives: number;
  best: number;
}

export const ENDLESS_LIVES = 3;

export function startEndlessRun(seed: number, best = 0): EndlessRun {
  return { seed, stage: 1, score: 0, combo: 0, lives: ENDLESS_LIVES, best };
}

/** Fold one stage's outcome into the run. Pure, so it is trivially testable. */
export function advanceEndlessRun(
  run: EndlessRun,
  stageScore: number,
  passed: boolean,
  threeStars: boolean,
): EndlessRun {
  const next: EndlessRun = { ...run };
  if (passed) {
    next.score += stageScore;
    next.combo = threeStars ? run.combo + 1 : 0;
    next.stage += 1;
  } else {
    next.combo = 0;
    next.lives -= 1;
    // A failed stage is retried, not skipped: the difficulty curve stays honest.
  }
  next.best = Math.max(next.best, next.score);
  return next;
}

export function isRunOver(run: EndlessRun): boolean {
  return run.lives <= 0;
}

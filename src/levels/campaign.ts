import { Rng, hashSeed } from '../core/rng';
import { clamp, lerp } from '../core/geometry';
import { TABLE_Y } from '../core/simulation';
import {
  MECHANIC_ORDER,
  type GlassSpec,
  type LevelSpec,
  type Mechanic,
  type ObstacleSpec,
} from './types';

export const LEVELS_PER_WORLD = 25;
/**
 * Hard caps on the motion mechanics. A glass tilted or rocked much past this
 * cannot retain liquid at all, and travel beyond MAX_TRAVEL walks a glass out of
 * the playfield. Both are correctness limits, not taste.
 */
export const MAX_TILT = 0.42;
export const MAX_ROCK = 0.38;
export const MAX_TRAVEL = 0.1;
/** Clear opening a stream needs to reach the glass past an obstacle. */
export const MIN_STREAM_GAP = 0.07;
/**
 * How far above the rim the jug is held. Kept short deliberately: a long drop
 * turns the stream into a fast jet that shatters on impact and sprays out of the
 * glass, which reads as the physics being broken rather than as difficulty.
 */
export const POUR_HEIGHT = 0.2;
export const WORLD_COUNT = 5;

export interface WorldDefinition {
  number: number;
  name: string;
  /** The one new thing this world teaches. */
  introduces: Mechanic;
  /** Palette / background identity, consumed by the renderer. */
  theme: string;
  hint: string;
}

/**
 * Worlds add exactly one variable each, in the order the concept sets out.
 * Nothing in a world's first levels uses a mechanic the player has not met.
 */
export const WORLDS: readonly WorldDefinition[] = [
  {
    number: 1,
    name: 'Kitchen Window',
    introduces: 'still',
    theme: 'kitchen',
    hint: 'Hold to tip the jug. Let go to stop. Fill to the line.',
  },
  {
    number: 2,
    name: 'Sloped Shelf',
    introduces: 'tilt',
    theme: 'shelf',
    hint: 'The glass leans. Aim for the low corner.',
  },
  {
    number: 3,
    name: 'Carousel Cafe',
    introduces: 'spin',
    theme: 'carousel',
    hint: 'It turns. Pour in time with the rim.',
  },
  {
    number: 4,
    name: 'The Workshop',
    introduces: 'obstacle',
    theme: 'workshop',
    hint: 'Something is in the way. Thread the stream through.',
  },
  {
    number: 5,
    name: 'Rooftop Bar',
    introduces: 'multi',
    theme: 'rooftop',
    hint: 'Two glasses, one pour. Both must be right.',
  },
];

/** Mechanics available by the time the player reaches a given world. */
export function unlockedMechanics(world: number): Mechanic[] {
  return MECHANIC_ORDER.slice(0, clamp(world, 1, WORLD_COUNT));
}

/**
 * Difficulty inside a world: a gentle ramp with a deliberate breather in the
 * back third, then the boss. `t` is 0 at the first level and 1 at level 24.
 */
function rampAt(index: number): number {
  const t = (index - 1) / (LEVELS_PER_WORLD - 2);
  const breather = index === 17 || index === 21 ? -0.18 : 0;
  return clamp(t + breather, 0, 1);
}

/** Fill windows tighten across a world, and again across the campaign. */
function toleranceFor(world: number, index: number, isBoss: boolean): number {
  const worldBase = lerp(0.5, 0.34, (world - 1) / (WORLD_COUNT - 1));
  const withinWorld = lerp(1, 0.78, rampAt(index));
  return Number((worldBase * withinWorld * (isBoss ? 0.92 : 1)).toFixed(4));
}

/**
 * Where the jug starts: over the middle of the first glass's *opening*.
 * A tilted glass's mouth sits well to one side of its base, so starting the aim
 * at the base would begin every level by missing.
 */
export function defaultAimFor(glasses: readonly GlassSpec[]): number {
  if (glasses.length !== 1) return 0;
  const glass = glasses[0];
  return Number((glass.x - glass.height * Math.sin(glass.angle)).toFixed(4));
}

/** Hold the jug a short, constant distance above the tallest rim in the level. */
export function jugHeightFor(glasses: readonly GlassSpec[]): number {
  const highestRim = Math.max(...glasses.map((g) => g.y + g.height));
  return Number((highestRim + POUR_HEIGHT).toFixed(4));
}

function glassBase(rng: Rng, t: number): GlassSpec {
  // Glasses get narrower and taller as a world progresses: less margin for
  // error and a higher surface to read, without any new mechanic.
  const width = lerp(0.26, 0.17, t) + rng.jitter(0.012);
  const height = lerp(0.24, 0.34, t) + rng.jitter(0.015);
  return {
    x: rng.jitter(0.06),
    y: TABLE_Y,
    width,
    height,
    angle: 0,
    targetFraction: clamp(lerp(0.78, 0.62, t) + rng.jitter(0.05), 0.45, 0.9),
  };
}

function applyTilt(glass: GlassSpec, rng: Rng, t: number, intensity = 1): void {
  const magnitude = lerp(0.12, MAX_TILT, t) * intensity;
  glass.angle = (rng.next() < 0.5 ? -1 : 1) * magnitude;
  // A leaning glass holds less before it overflows, so ask for less of it.
  glass.targetFraction = clamp(glass.targetFraction - magnitude * 0.35, 0.4, 0.85);
}

/**
 * The "spinning glass" mechanic: a glass on a turntable.
 *
 * A glass cannot be *tumbled* end over end and still hold liquid — past roughly
 * 50 degrees it simply empties, which is a non-game. So rotation is expressed the
 * way it actually appears on a carousel: the glass revolves around the turntable
 * centre while rocking about its own base. The player has to lead a moving
 * target and time the pour against the rock, which is the intended skill.
 */
function applySpin(glass: GlassSpec, rng: Rng, t: number, intensity = 1): void {
  const strength = t * intensity;
  glass.wobble = {
    amplitude: lerp(0.1, MAX_ROCK, strength),
    frequency: lerp(0.2, 0.55, strength),
  };
  if (strength > 0.35) {
    // Travel arrives once the rock is understood, and never carries the glass
    // outside the playfield.
    glass.orbit = {
      radiusX: lerp(0.04, MAX_TRAVEL, strength) * (rng.next() < 0.5 ? -1 : 1),
      frequency: lerp(0.18, 0.42, strength),
    };
  }
  glass.targetFraction = clamp(glass.targetFraction - 0.06, 0.4, 0.82);
}

function makeObstacles(rng: Rng, t: number, glasses: GlassSpec[], intensity = 1): ObstacleSpec[] {
  const obstacles: ObstacleSpec[] = [];
  const target = glasses[0];
  const rimY = target.y + target.height;
  const hard = t * intensity;

  if (rng.next() < 0.5) {
    // A baffle over the mouth. Sized and shifted to one wall so a clear channel
    // always remains on the other side: the shot is hard, never impossible.
    const maxLength = Math.max(0.05, target.width - MIN_STREAM_GAP);
    const barLength = Math.min(maxLength, target.width * lerp(0.45, 0.9, hard));
    const side = rng.next() < 0.5 ? -1 : 1;
    obstacles.push({
      kind: 'bar',
      x: target.x + side * (target.width * 0.5 - barLength * 0.5),
      y: rimY + lerp(0.1, 0.05, hard),
      angle: 0,
      length: barLength,
      thickness: 0.02,
      ...(hard > 0.55
        ? { wobble: { amplitude: lerp(0.25, 0.5, hard), frequency: lerp(0.2, 0.45, hard) } }
        : {}),
    });
  } else {
    // A funnel: precision aiming, and a glug if you pour too fast for the gap.
    obstacles.push({
      kind: 'funnel',
      x: target.x,
      y: rimY + lerp(0.16, 0.1, hard),
      angle: 0,
      length: lerp(0.3, 0.22, hard),
      gap: Math.max(MIN_STREAM_GAP, lerp(0.12, 0.075, hard)),
      depth: 0.075,
      ...(hard > 0.7 ? { orbit: { radiusX: 0.05, frequency: 0.3 } } : {}),
    });
  }

  return obstacles;
}

function addSecondGlass(glasses: GlassSpec[], rng: Rng, t: number): void {
  const first = glasses[0];
  const separation = lerp(0.19, 0.3, t);
  first.x = -separation * 0.5;
  const second: GlassSpec = {
    ...first,
    x: separation * 0.5,
    width: first.width * lerp(1, 0.8, t),
    height: first.height * lerp(1, 1.15, t),
    angle: 0,
    targetFraction: clamp(first.targetFraction + rng.jitter(0.12), 0.4, 0.85),
  };
  glasses.push(second);
  if (t > 0.6) {
    // Asymmetric demands: you cannot just split the pour down the middle.
    glasses[0].targetFraction = clamp(glasses[0].targetFraction - 0.12, 0.35, 0.85);
  }
}

/**
 * Build one campaign level. Deterministic: the same world/index always produces
 * the same level, so progress, star records and shared scores stay meaningful
 * without shipping 125 hand-authored files.
 */
export function buildLevel(world: number, index: number): LevelSpec {
  const w = clamp(Math.round(world), 1, WORLD_COUNT);
  const i = clamp(Math.round(index), 1, LEVELS_PER_WORLD);
  const definition = WORLDS[w - 1];
  const isBoss = i === LEVELS_PER_WORLD;
  const id = `w${w}-l${i}`;
  const rng = new Rng(hashSeed(id));
  const t = isBoss ? 1 : rampAt(i);

  const glasses: GlassSpec[] = [glassBase(rng, t)];
  let obstacles: ObstacleSpec[] = [];
  const available = unlockedMechanics(w);
  const mechanics: Mechanic[] = ['still'];

  if (isBoss) {
    // The boss uses every mechanic introduced so far, at full strength.
    if (available.includes('tilt')) {
      applyTilt(glasses[0], rng, 1, 0.85);
      mechanics.push('tilt');
    }
    if (available.includes('spin')) {
      applySpin(glasses[0], rng, 1, 0.9);
      mechanics.push('spin');
    }
    if (available.includes('multi')) {
      addSecondGlass(glasses, rng, 1);
      applyTilt(glasses[1], rng, 1, 0.7);
      mechanics.push('multi');
    }
    if (available.includes('obstacle')) {
      obstacles = makeObstacles(rng, 1, glasses, 0.95);
      mechanics.push('obstacle');
    }
  } else {
    const isNew = definition.introduces;
    // Levels 1-4 of a world teach the new mechanic on its own; after that
    // earlier mechanics come back in the mix.
    const teachingPhase = i <= 4;
    const revisit = (mechanic: Mechanic) =>
      !teachingPhase && available.includes(mechanic) && rng.next() < 0.45;

    if (isNew === 'tilt' || revisit('tilt')) {
      applyTilt(glasses[0], rng, t, isNew === 'tilt' ? 1 : 0.6);
      mechanics.push('tilt');
    }
    if (isNew === 'spin' || revisit('spin')) {
      applySpin(glasses[0], rng, t, isNew === 'spin' ? 1 : 0.6);
      mechanics.push('spin');
    }
    if (isNew === 'multi' || revisit('multi')) {
      addSecondGlass(glasses, rng, t);
      mechanics.push('multi');
    }
    if (isNew === 'obstacle' || revisit('obstacle')) {
      obstacles = makeObstacles(rng, t, glasses, isNew === 'obstacle' ? 1 : 0.55);
      mechanics.push('obstacle');
    }
  }

  const name = isBoss ? `${definition.name}: Last Call` : `${definition.name} ${i}`;

  return {
    id,
    world: w,
    index: i,
    name,
    mechanics,
    glasses,
    obstacles,
    jug: {
      x: defaultAimFor(glasses),
      y: jugHeightFor(glasses),
      chargeFactor: isBoss ? 1.35 : lerp(1.7, 1.4, t),
      movable: true,
    },
    // 15-30 second levels, per the design target; bosses get a little longer.
    timeLimit: isBoss ? 30 : Math.round(lerp(22, 26, t)),
    tolerance: toleranceFor(w, i, isBoss),
    isBoss,
    seed: hashSeed(`${id}-sim`),
    ...(i === 1 ? { hint: definition.hint } : {}),
  };
}

/** Every level in a world, in order. */
export function buildWorld(world: number): LevelSpec[] {
  return Array.from({ length: LEVELS_PER_WORLD }, (_, k) => buildLevel(world, k + 1));
}

export function buildCampaign(): LevelSpec[][] {
  return Array.from({ length: WORLD_COUNT }, (_, k) => buildWorld(k + 1));
}

export const TOTAL_LEVELS = WORLD_COUNT * LEVELS_PER_WORLD;

/** Flat 0-based ordinal, for progress bars and save data. */
export function levelOrdinal(world: number, index: number): number {
  return (world - 1) * LEVELS_PER_WORLD + (index - 1);
}

export function levelFromOrdinal(ordinal: number): { world: number; index: number } {
  const clamped = clamp(Math.round(ordinal), 0, TOTAL_LEVELS - 1);
  return {
    world: Math.floor(clamped / LEVELS_PER_WORLD) + 1,
    index: (clamped % LEVELS_PER_WORLD) + 1,
  };
}

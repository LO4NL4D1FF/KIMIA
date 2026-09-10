/**
 * Level data model.
 *
 * Every difficulty knob is one field, and each world turns on exactly one more
 * of them. Keeping them orthogonal is what lets the campaign ramp a single
 * variable at a time and lets endless mode remix them without new code.
 */

export type Mechanic = 'still' | 'tilt' | 'spin' | 'obstacle' | 'multi';

export const MECHANIC_ORDER: readonly Mechanic[] = ['still', 'tilt', 'spin', 'obstacle', 'multi'];

export interface Wobble {
  amplitude: number;
  frequency: number;
}

export interface Orbit {
  radiusX: number;
  radiusY?: number;
  frequency: number;
}

export interface GlassSpec {
  x: number;
  /** Height of the inside of the base above the table. */
  y: number;
  width: number;
  height: number;
  thickness?: number;
  /** Base width as a fraction of the opening. */
  taper?: number;
  /** Optional pinched waist, as a fraction of the opening. */
  waist?: number;
  waistAt?: number;
  /** Fixed tilt, radians. */
  angle: number;
  /** Constant rotation, rad/s. */
  spin?: number;
  /** Rocking motion. */
  wobble?: Wobble;
  orbit?: Orbit;
  /** Fraction of the glass's true capacity the player must hit. */
  targetFraction: number;
}

export interface ObstacleSpec {
  kind: 'bar' | 'funnel';
  x: number;
  y: number;
  angle: number;
  length: number;
  thickness?: number;
  /** Funnel only: the gap liquid must thread. */
  gap?: number;
  depth?: number;
  spin?: number;
  wobble?: Wobble;
  orbit?: Orbit;
}

export interface JugSpec {
  x: number;
  y: number;
  /** Liquid available, as a multiple of the total target. */
  chargeFactor?: number;
  /** Can the player slide the jug sideways? */
  movable?: boolean;
  config?: Partial<import('../core/jug').JugConfig>;
}

export interface LevelSpec {
  id: string;
  /** 1-based world number; 0 for endless stages. */
  world: number;
  /** 1-based level number within the world. */
  index: number;
  name: string;
  mechanics: Mechanic[];
  glasses: GlassSpec[];
  obstacles: ObstacleSpec[];
  jug: JugSpec;
  /** Hard stop, seconds. Levels are designed to land at 15-30s. */
  timeLimit: number;
  /** Relative fill error at which precision scores zero. */
  tolerance: number;
  isBoss: boolean;
  seed: number;
  /** Shown once, the first time a mechanic appears. */
  hint?: string;
}

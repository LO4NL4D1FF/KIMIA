import type { Body } from './body';
import type { Fluid } from './fluid';

export type ParticleState = 'captured' | 'airborne' | 'spilled';

export interface GlassFill {
  body: Body;
  /** Volume of liquid currently inside this glass. */
  volume: number;
  /** Volume this glass is asked for. */
  target: number;
  /** Most it can physically hold. */
  capacity: number;
  /** volume / target, so 1.0 is a perfect fill. */
  ratio: number;
  /** Height of the liquid surface in world space, for UI guides. */
  surfaceY: number;
}

export interface FillReport {
  glasses: GlassFill[];
  /** In flight — not yet anybody's, so not yet a spill. */
  airborne: number;
  /** Liquid that has come to rest outside every glass, or left the scene. */
  spilled: number;
  captured: number;
  /** True once nothing is meaningfully moving any more. */
  settled: boolean;
}

export interface FillOptions {
  /** Speed below which a loose particle counts as a settled spill. */
  restSpeed?: number;
  /** Mean speed below which the whole scene counts as settled. */
  settleSpeed?: number;
}

/**
 * Classify every particle and measure each glass.
 *
 * Deliberately geometric rather than event-based: a particle counts because it
 * *is* inside the glass right now, not because it crossed a trigger. That makes
 * overflow, slosh-out and a glass tipping its contents back out all behave
 * correctly for free.
 */
export function sampleFill(
  fluid: Fluid,
  glasses: readonly Body[],
  targets: readonly number[],
  capacities: readonly number[],
  options: FillOptions = {},
): FillReport {
  const restSpeed = options.restSpeed ?? 0.12;
  const settleSpeed = options.settleSpeed ?? 0.09;
  const volume = fluid.particleVolume;

  const counts = new Array<number>(glasses.length).fill(0);
  const surfaces = new Array<number>(glasses.length).fill(-Infinity);
  let airborne = 0;
  let spilled = 0;

  for (let i = 0; i < fluid.count; i++) {
    const point = { x: fluid.px[i], y: fluid.py[i] };
    let owner = -1;
    for (let g = 0; g < glasses.length; g++) {
      if (glasses[g].containsPoint(point)) {
        owner = g;
        break;
      }
    }

    if (owner >= 0) {
      counts[owner]++;
      if (point.y > surfaces[owner]) surfaces[owner] = point.y;
      continue;
    }

    const speed = Math.hypot(fluid.vx[i], fluid.vy[i]);
    if (speed < restSpeed) spilled += volume;
    else airborne += volume;
  }

  const report: FillReport = {
    glasses: glasses.map((body, g) => {
      const target = targets[g] ?? 0;
      const filled = counts[g] * volume;
      return {
        body,
        volume: filled,
        target,
        capacity: capacities[g] ?? 0,
        ratio: target > 0 ? filled / target : 0,
        surfaceY: counts[g] > 0 ? surfaces[g] : body.toWorld({ x: 0, y: 0 }).y,
      };
    }),
    airborne,
    spilled,
    captured: counts.reduce((sum, c) => sum + c, 0) * volume,
    settled: fluid.count === 0 || fluid.meanSpeed() < settleSpeed,
  };

  return report;
}

/**
 * Liquid that has left the playfield entirely. Counted as spilled and culled so
 * a long run cannot exhaust the particle pool.
 */
export function cullEscaped(
  fluid: Fluid,
  killBelowY: number,
  killBeyondX: number,
): number {
  const volume = fluid.particleVolume;
  let escaped = 0;
  for (let i = fluid.count - 1; i >= 0; i--) {
    if (fluid.py[i] < killBelowY || Math.abs(fluid.px[i]) > killBeyondX) {
      fluid.remove(i);
      escaped += volume;
    }
  }
  return escaped;
}

/**
 * Retire liquid that has been lying still outside every glass for a while, so
 * a spill gets to be visible (and read as a mess) before it stops costing frame
 * time. Returns the volume retired this step.
 */
export function agePooledSpill(
  fluid: Fluid,
  glasses: readonly Body[],
  dt: number,
  lifetime: number,
  restSpeed = 0.12,
): number {
  const volume = fluid.particleVolume;
  let retired = 0;

  for (let i = fluid.count - 1; i >= 0; i--) {
    const point = { x: fluid.px[i], y: fluid.py[i] };
    let inside = false;
    for (const glass of glasses) {
      if (glass.containsPoint(point)) {
        inside = true;
        break;
      }
    }
    if (inside) {
      fluid.meta[i] = 0;
      continue;
    }
    if (Math.hypot(fluid.vx[i], fluid.vy[i]) > restSpeed) {
      fluid.meta[i] = 0;
      continue;
    }
    fluid.meta[i] += dt;
    if (fluid.meta[i] >= lifetime) {
      fluid.remove(i);
      retired += volume;
    }
  }

  return retired;
}

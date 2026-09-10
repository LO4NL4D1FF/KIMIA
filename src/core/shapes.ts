import type { Capsule, ContainerShape } from './body';
import { type Vec2, normalize, sub } from './geometry';

/**
 * Build a wall capsule whose *inner* surface lands exactly on the face a-b.
 *
 * The centreline is pushed outward by half the thickness and both ends are
 * extended so neighbouring walls overlap at corners — no seams for particles to
 * squeeze through, which is the classic failure mode of thin-wall containers.
 */
export function wallFromFace(a: Vec2, b: Vec2, interiorPoint: Vec2, thickness: number): Capsule {
  const dir = normalize(sub(b, a));
  const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
  let nx = -dir.y;
  let ny = dir.x;
  // Flip the normal so it points away from the cavity.
  if ((mid.x - interiorPoint.x) * nx + (mid.y - interiorPoint.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const half = thickness * 0.5;
  const ext = half;
  return {
    a: { x: a.x + nx * half - dir.x * ext, y: a.y + ny * half - dir.y * ext },
    b: { x: b.x + nx * half + dir.x * ext, y: b.y + ny * half + dir.y * ext },
    radius: half,
  };
}

/**
 * Walls for an open-topped vessel described by its cavity outline.
 * `interior` runs anticlockwise from the top-left rim, down the left side,
 * across the base and up the right side to the top-right rim; the closing edge
 * (right rim -> left rim) is the opening and gets no wall.
 */
export function wallsFromCavity(interior: readonly Vec2[], thickness: number): Capsule[] {
  const centroid = interior.reduce(
    (acc, p) => ({ x: acc.x + p.x / interior.length, y: acc.y + p.y / interior.length }),
    { x: 0, y: 0 },
  );
  const walls: Capsule[] = [];
  for (let i = 0; i < interior.length - 1; i++) {
    walls.push(wallFromFace(interior[i], interior[i + 1], centroid, thickness));
  }
  return walls;
}

export interface GlassOptions {
  /** Width of the opening. */
  width: number;
  height: number;
  thickness?: number;
  /**
   * Base width as a fraction of the opening. 1 = straight tumbler,
   * <1 = conical (harder: less margin at the bottom, splashier),
   * >1 = flask (easier to hit, but overflows in a rush).
   */
  taper?: number;
  /** Waist width as a fraction of the opening, at `waistAt` up the height. */
  waist?: number;
  waistAt?: number;
}

/**
 * The glass. Origin sits at the centre of the inside of the base, so rotating
 * the body tilts/spins it about a point that reads as physically sensible.
 */
export function makeGlass(options: GlassOptions): ContainerShape {
  const { width, height } = options;
  const thickness = options.thickness ?? Math.min(width, height) * 0.06;
  const taper = options.taper ?? 1;
  const waist = options.waist;
  const waistAt = options.waistAt ?? 0.5;

  const halfTop = width * 0.5;
  const halfBottom = width * taper * 0.5;

  const left: Vec2[] = [];
  const right: Vec2[] = [];
  if (waist !== undefined) {
    const halfWaist = width * waist * 0.5;
    left.push({ x: -halfWaist, y: height * waistAt });
    right.push({ x: halfWaist, y: height * waistAt });
  }

  const interior: Vec2[] = [
    { x: -halfTop, y: height },
    ...left,
    { x: -halfBottom, y: 0 },
    { x: halfBottom, y: 0 },
    ...right.reverse(),
    { x: halfTop, y: height },
  ];

  return {
    walls: wallsFromCavity(interior, thickness),
    interior,
    rim: [
      { x: -halfTop, y: height },
      { x: halfTop, y: height },
    ],
  };
}

/** A bare bar/baffle used as an in-glass obstacle. No cavity, so it holds nothing. */
export function makeBar(length: number, thickness: number): ContainerShape {
  return {
    walls: [
      {
        a: { x: -length * 0.5, y: 0 },
        b: { x: length * 0.5, y: 0 },
        radius: thickness * 0.5,
      },
    ],
    interior: [],
    rim: [
      { x: -length * 0.5, y: 0 },
      { x: length * 0.5, y: 0 },
    ],
  };
}

/** A funnel: two angled blades that liquid must thread between. */
export function makeFunnel(span: number, gap: number, depth: number, thickness: number): ContainerShape {
  const half = span * 0.5;
  const halfGap = gap * 0.5;
  return {
    walls: [
      { a: { x: -half, y: depth }, b: { x: -halfGap, y: 0 }, radius: thickness * 0.5 },
      { a: { x: half, y: depth }, b: { x: halfGap, y: 0 }, radius: thickness * 0.5 },
    ],
    interior: [],
    rim: [
      { x: -halfGap, y: 0 },
      { x: halfGap, y: 0 },
    ],
  };
}

/**
 * The table the glass stands on, plus low kerbs at the edges of the play area,
 * so spilled liquid pools and reads as a mess instead of vanishing at the frame.
 */
export function makeTable(width: number, thickness: number): ContainerShape {
  const half = width * 0.5;
  return {
    walls: [{ a: { x: -half, y: 0 }, b: { x: half, y: 0 }, radius: thickness * 0.5 }],
    interior: [],
    rim: [
      { x: -half, y: 0 },
      { x: half, y: 0 },
    ],
  };
}

/** The jug: a vessel with a lip on the right, which is where the stream leaves. */
export function makeJug(width: number, height: number, thickness: number): ContainerShape {
  const half = width * 0.5;
  const interior: Vec2[] = [
    { x: -half, y: height },
    { x: -half * 0.82, y: 0 },
    { x: half * 0.82, y: 0 },
    { x: half, y: height * 0.86 },
  ];
  return {
    walls: wallsFromCavity(interior, thickness),
    interior,
    rim: [
      { x: -half, y: height },
      { x: half, y: height * 0.86 },
    ],
  };
}

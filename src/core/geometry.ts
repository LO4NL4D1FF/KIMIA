/** Small, allocation-conscious 2D geometry helpers shared by physics and gameplay. */

export interface Vec2 {
  x: number;
  y: number;
}

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 2D cross product (z component of the 3D cross). */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalize(a: Vec2): Vec2 {
  const len = Math.hypot(a.x, a.y);
  return len > 1e-12 ? { x: a.x / len, y: a.y / len } : { x: 0, y: 0 };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Smooth Hermite interpolation, the standard easing workhorse. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-12));
  return t * t * (3 - 2 * t);
}

/** Rotate a vector by `angle` radians (CCW). */
export function rotate(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Local -> world for a rigid transform (rotate then translate). */
export function toWorld(local: Vec2, origin: Vec2, angle: number): Vec2 {
  const r = rotate(local, angle);
  return { x: r.x + origin.x, y: r.y + origin.y };
}

/** World -> local for a rigid transform (inverse of `toWorld`). */
export function toLocal(world: Vec2, origin: Vec2, angle: number): Vec2 {
  return rotate({ x: world.x - origin.x, y: world.y - origin.y }, -angle);
}

export interface SegmentQuery {
  /** Closest point on the segment. */
  point: Vec2;
  /** Parametric position along the segment, clamped to [0, 1]. */
  t: number;
  distance: number;
}

/** Closest point on segment ab to point p. */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): SegmentQuery {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = 0;
  if (lenSq > 1e-18) {
    t = clamp01(((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq);
  }
  const point = { x: a.x + abx * t, y: a.y + aby * t };
  return { point, t, distance: Math.hypot(p.x - point.x, p.y - point.y) };
}

/**
 * Shortest distance between two segments. Used to ask "is this pour path clear
 * of that obstacle" without stepping the simulation.
 */
export function segmentSegmentDistance(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const rx = a1.x - b1.x;
  const ry = a1.y - b1.y;
  const a = dax * dax + day * day;
  const e = dbx * dbx + dby * dby;
  const f = dbx * rx + dby * ry;

  let s = 0;
  let t = 0;

  if (a <= 1e-18 && e <= 1e-18) return Math.hypot(rx, ry);
  if (a <= 1e-18) {
    t = clamp01(f / e);
  } else {
    const c = dax * rx + day * ry;
    if (e <= 1e-18) {
      s = clamp01(-c / a);
    } else {
      const b = dax * dbx + day * dby;
      const denom = a * e - b * b;
      s = denom > 1e-18 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  const px = a1.x + dax * s - (b1.x + dbx * t);
  const py = a1.y + day * s - (b1.y + dby * t);
  return Math.hypot(px, py);
}

/**
 * Even-odd ray crossing test. Vertices are treated as a closed loop.
 * Points exactly on an edge are not guaranteed either way, which is fine —
 * fluid particles never sit exactly on a boundary for more than one frame.
 */
export function pointInPolygon(p: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y) {
      const xCross = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Unsigned area of a simple polygon (shoelace). */
export function polygonArea(polygon: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += polygon[j].x * polygon[i].y - polygon[i].x * polygon[j].y;
  }
  return Math.abs(sum) * 0.5;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function polygonBounds(polygon: readonly Vec2[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

import {
  type Vec2,
  closestPointOnSegment,
  pointInPolygon,
  toLocal,
  rotate,
  polygonBounds,
} from './geometry';

/**
 * A thick line segment. Every solid in the game (glass walls, obstacles, the
 * jug spout, the floor) is built from these: one primitive means one collision
 * routine, which keeps the solver small and the behaviour predictable.
 */
export interface Capsule {
  a: Vec2;
  b: Vec2;
  radius: number;
}

export interface ContainerShape {
  /** Wall centrelines in body-local space. */
  walls: Capsule[];
  /**
   * Closed polygon describing the cavity in body-local space, including the
   * line across the opening. Used for "is this particle in the glass" tests.
   */
  interior: Vec2[];
  /** The opening, body-local. Liquid enters (and overflows) through here. */
  rim: [Vec2, Vec2];
}

export interface Contact {
  /** How far inside the surface the point is; always > 0 when returned. */
  penetration: number;
  /** Unit surface normal pointing out of the solid, in world space. */
  normal: Vec2;
}

export type BodyKind = 'glass' | 'obstacle' | 'world';

/**
 * A kinematic rigid body: it pushes liquid around but liquid never pushes back.
 * Levels drive `angle` / `angularVelocity` directly, which is what makes
 * "tilted" and "spinning" glasses one-line difficulty variables.
 */
export class Body {
  readonly kind: BodyKind;
  readonly shape: ContainerShape;

  position: Vec2;
  angle: number;
  velocity: Vec2 = { x: 0, y: 0 };
  angularVelocity = 0;

  /** Tangential bounce off this surface, 0 = fully damped. */
  restitution = 0.02;
  /**
   * 0 = frictionless, 1 = liquid sticks to the wall. Wet glass grips: this is
   * what stops a stream skating up the inside wall and out over the rim, and
   * what lets a moving glass drag its contents along.
   */
  friction = 0.32;

  constructor(kind: BodyKind, shape: ContainerShape, position: Vec2, angle = 0) {
    this.kind = kind;
    this.shape = shape;
    this.position = { ...position };
    this.angle = angle;
  }

  advance(dt: number): void {
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.angle += this.angularVelocity * dt;
  }

  toLocal(worldPoint: Vec2): Vec2 {
    return toLocal(worldPoint, this.position, this.angle);
  }

  toWorld(localPoint: Vec2): Vec2 {
    const r = rotate(localPoint, this.angle);
    return { x: r.x + this.position.x, y: r.y + this.position.y };
  }

  /** Surface velocity at a world point: body translation plus spin. */
  pointVelocity(worldPoint: Vec2): Vec2 {
    const rx = worldPoint.x - this.position.x;
    const ry = worldPoint.y - this.position.y;
    return {
      x: this.velocity.x - this.angularVelocity * ry,
      y: this.velocity.y + this.angularVelocity * rx,
    };
  }

  /**
   * Deepest contact between a circle of `radius` at `worldPoint` and this
   * body's walls, or null when the circle is clear of every wall.
   */
  contact(worldPoint: Vec2, radius: number): Contact | null {
    const local = this.toLocal(worldPoint);
    let deepest: Contact | null = null;

    for (const wall of this.shape.walls) {
      const q = closestPointOnSegment(local, wall.a, wall.b);
      const surfaceDistance = q.distance - wall.radius;
      if (surfaceDistance >= radius) continue;

      const penetration = radius - surfaceDistance;
      let nx = local.x - q.point.x;
      let ny = local.y - q.point.y;
      const len = Math.hypot(nx, ny);
      if (len > 1e-9) {
        nx /= len;
        ny /= len;
      } else {
        // Dead centre on the centreline: push out perpendicular to the wall.
        const dx = wall.b.x - wall.a.x;
        const dy = wall.b.y - wall.a.y;
        const dl = Math.hypot(dx, dy) || 1;
        nx = -dy / dl;
        ny = dx / dl;
      }

      if (!deepest || penetration > deepest.penetration) {
        deepest = { penetration, normal: rotate({ x: nx, y: ny }, this.angle) };
      }
    }

    return deepest;
  }

  /** Is this world point inside the cavity (regardless of wall clearance)? */
  containsPoint(worldPoint: Vec2): boolean {
    if (this.shape.interior.length < 3) return false;
    return pointInPolygon(this.toLocal(worldPoint), this.shape.interior);
  }

  /** This body's walls in world space — for rendering and for clearance tests. */
  worldWalls(): Capsule[] {
    return this.shape.walls.map((wall) => ({
      a: this.toWorld(wall.a),
      b: this.toWorld(wall.b),
      radius: wall.radius,
    }));
  }

  /** World-space rim endpoints, useful for aiming aids and overflow tests. */
  worldRim(): [Vec2, Vec2] {
    return [this.toWorld(this.shape.rim[0]), this.toWorld(this.shape.rim[1])];
  }

  /**
   * Volume of liquid this container can actually hold, measured rather than
   * derived: sample the cavity on a grid and keep the cells a particle centre
   * could legally occupy. This automatically accounts for wall thickness and
   * for obstacles that displace liquid, so level fill targets stay honest even
   * for odd shapes.
   */
  measureCapacity(particleRadius: number, obstacles: readonly Body[] = []): number {
    const b = polygonBounds(this.shape.interior);
    const step = particleRadius * 0.5;
    let cells = 0;

    for (let y = b.minY + step * 0.5; y < b.maxY; y += step) {
      for (let x = b.minX + step * 0.5; x < b.maxX; x += step) {
        const local = { x, y };
        if (!pointInPolygon(local, this.shape.interior)) continue;
        const world = this.toWorld(local);
        if (this.contact(world, particleRadius)) continue;
        let blocked = false;
        for (const obstacle of obstacles) {
          if (obstacle.contact(world, particleRadius)) {
            blocked = true;
            break;
          }
        }
        if (!blocked) cells++;
      }
    }

    return cells * step * step;
  }
}

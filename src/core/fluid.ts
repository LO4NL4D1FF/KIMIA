import type { Vec2 } from './geometry';
import type { Body } from './body';

/**
 * Position Based Fluids (Macklin & Müller 2013).
 *
 * Chosen over a spring-mass blob or a fill meter because it is unconditionally
 * stable at large timesteps, incompressible enough to look like water, and
 * cheap enough for a phone: a density constraint solved with a few Gauss-Seidel
 * iterations per step. Incompressibility is what makes the pour feel heavy —
 * liquid piles up, glugs through a narrow neck and sloshes when the glass spins,
 * none of which is scripted.
 */
export interface FluidParams {
  /** Smoothing radius h. Interaction cutoff for every kernel. */
  radius: number;
  /** Rest spacing of a settled particle lattice. Derived from `radius`. */
  spacing: number;
  particleMass: number;
  restDensity: number;
  solverIterations: number;
  /** Constraint-force mixing (epsilon in the paper). Larger = softer. */
  relaxation: number;
  /** XSPH velocity blending: the visible "thickness" of the liquid. */
  viscosity: number;
  /** Surface tension strength — beads the leading edge of a pour. */
  cohesion: number;
  /** Artificial pressure, stops particles clumping into strings. */
  clumpResistance: number;
  gravity: Vec2;
  /** Hard speed cap; keeps a long fall from tunnelling through glass walls. */
  maxSpeed: number;
  /** Tangential damping applied on contact with a solid. */
  boundaryDrag: number;
}

export interface Domain {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const MAX_NEIGHBOURS = 48;

export function defaultFluidParams(overrides: Partial<FluidParams> = {}): FluidParams {
  const radius = overrides.radius ?? 0.05;
  const spacing = overrides.spacing ?? radius * 0.5;
  // Mass equal to the area a particle occupies makes rest density ~1 and keeps
  // volume bookkeeping (fill %, spill %) in the same units as level design.
  const particleMass = overrides.particleMass ?? spacing * spacing;
  const params: FluidParams = {
    radius,
    spacing,
    particleMass,
    restDensity: overrides.restDensity ?? latticeRestDensity(radius, spacing, particleMass),
    solverIterations: 3,
    relaxation: 1e-6,
    // A thin fluid sprays back out of the glass on impact; this much viscosity
    // makes the settled pool absorb the incoming stream, which is both what
    // water does at these speeds and what makes a pour land where it is aimed.
    viscosity: 0.15,
    cohesion: 0.35,
    clumpResistance: 1e-4,
    gravity: { x: 0, y: -9.81 },
    maxSpeed: 6,
    boundaryDrag: 0.22,
    ...overrides,
  };
  return params;
}

/** poly6 kernel, 2D normalisation. */
export function poly6(r: number, h: number): number {
  if (r >= h) return 0;
  const t = h * h - r * r;
  return (4 / (Math.PI * Math.pow(h, 8))) * t * t * t;
}

/** Magnitude of the spiky kernel gradient, 2D normalisation. */
export function spikyGradMagnitude(r: number, h: number): number {
  if (r >= h || r <= 0) return 0;
  const t = h - r;
  return (-30 / (Math.PI * Math.pow(h, 5))) * t * t;
}

/**
 * Rest density measured on an ideal square lattice, so it is always consistent
 * with the kernel and spacing actually in use rather than a magic number.
 */
export function latticeRestDensity(h: number, spacing: number, mass: number): number {
  const reach = Math.ceil(h / spacing) + 1;
  let density = 0;
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      density += mass * poly6(Math.hypot(i * spacing, j * spacing), h);
    }
  }
  return density;
}

export class Fluid {
  readonly params: FluidParams;
  readonly capacity: number;
  count = 0;

  /** Positions. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  /** Velocities. */
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Predicted positions (the quantity the solver actually manipulates). */
  private readonly qx: Float32Array;
  private readonly qy: Float32Array;
  private readonly dpx: Float32Array;
  private readonly dpy: Float32Array;
  private readonly lambda: Float32Array;
  readonly density: Float32Array;
  /**
   * One free float per particle, maintained across swap-removes, for callers to
   * use as they like. `Simulation` stores how long a particle has been loose on
   * the table so spilled liquid can pool, then quietly retire.
   */
  readonly meta: Float32Array;

  private readonly neighbours: Int32Array;
  private readonly neighbourCount: Int32Array;

  private domain: Domain;
  private cellSize: number;
  private gridW = 0;
  private gridH = 0;
  private cellCount: Int32Array = new Int32Array(0);
  private cellStart: Int32Array = new Int32Array(0);
  private sorted: Int32Array;

  constructor(capacity: number, params: FluidParams, domain: Domain) {
    this.capacity = capacity;
    this.params = params;
    this.domain = domain;
    this.cellSize = params.radius;

    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.qx = new Float32Array(capacity);
    this.qy = new Float32Array(capacity);
    this.dpx = new Float32Array(capacity);
    this.dpy = new Float32Array(capacity);
    this.lambda = new Float32Array(capacity);
    this.density = new Float32Array(capacity);
    this.meta = new Float32Array(capacity);
    this.neighbours = new Int32Array(capacity * MAX_NEIGHBOURS);
    this.neighbourCount = new Int32Array(capacity);
    this.sorted = new Int32Array(capacity);

    this.resizeGrid();
  }

  private resizeGrid(): void {
    const { minX, minY, maxX, maxY } = this.domain;
    this.gridW = Math.max(1, Math.ceil((maxX - minX) / this.cellSize) + 1);
    this.gridH = Math.max(1, Math.ceil((maxY - minY) / this.cellSize) + 1);
    const cells = this.gridW * this.gridH;
    this.cellCount = new Int32Array(cells + 1);
    this.cellStart = new Int32Array(cells + 1);
  }

  setDomain(domain: Domain): void {
    this.domain = domain;
    this.resizeGrid();
  }

  getDomain(): Domain {
    return this.domain;
  }

  /** Volume (2D area) of one particle — the unit of all fill/spill accounting. */
  get particleVolume(): number {
    return this.params.spacing * this.params.spacing;
  }

  get volume(): number {
    return this.count * this.particleVolume;
  }

  /** Returns the new particle index, or -1 when the pool is exhausted. */
  spawn(x: number, y: number, vx = 0, vy = 0): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.qx[i] = x;
    this.qy[i] = y;
    this.lambda[i] = 0;
    this.density[i] = 0;
    this.meta[i] = 0;
    return i;
  }

  /** Swap-remove; particle order is not meaningful to anything downstream. */
  remove(index: number): void {
    const last = --this.count;
    if (index !== last) {
      this.px[index] = this.px[last];
      this.py[index] = this.py[last];
      this.vx[index] = this.vx[last];
      this.vy[index] = this.vy[last];
      this.qx[index] = this.qx[last];
      this.qy[index] = this.qy[last];
      this.meta[index] = this.meta[last];
    }
  }

  clear(): void {
    this.count = 0;
  }

  kineticEnergy(): number {
    let energy = 0;
    for (let i = 0; i < this.count; i++) {
      energy += 0.5 * this.params.particleMass * (this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i]);
    }
    return energy;
  }

  meanSpeed(): number {
    if (this.count === 0) return 0;
    let total = 0;
    for (let i = 0; i < this.count; i++) total += Math.hypot(this.vx[i], this.vy[i]);
    return total / this.count;
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(
      this.gridW - 1,
      Math.max(0, Math.floor((x - this.domain.minX) / this.cellSize)),
    );
    const cy = Math.min(
      this.gridH - 1,
      Math.max(0, Math.floor((y - this.domain.minY) / this.cellSize)),
    );
    return cy * this.gridW + cx;
  }

  /** Counting sort into a uniform grid, then a 3x3 cell gather per particle. */
  private buildNeighbours(): void {
    const cells = this.gridW * this.gridH;
    this.cellCount.fill(0, 0, cells + 1);

    for (let i = 0; i < this.count; i++) {
      this.cellCount[this.cellIndex(this.qx[i], this.qy[i])]++;
    }
    let running = 0;
    for (let c = 0; c < cells; c++) {
      this.cellStart[c] = running;
      running += this.cellCount[c];
    }
    this.cellStart[cells] = running;

    const cursor = this.cellCount;
    for (let c = 0; c < cells; c++) cursor[c] = this.cellStart[c];
    for (let i = 0; i < this.count; i++) {
      this.sorted[cursor[this.cellIndex(this.qx[i], this.qy[i])]++] = i;
    }

    const h = this.params.radius;
    const h2 = h * h;
    for (let i = 0; i < this.count; i++) {
      const xi = this.qx[i];
      const yi = this.qy[i];
      const cx = Math.min(
        this.gridW - 1,
        Math.max(0, Math.floor((xi - this.domain.minX) / this.cellSize)),
      );
      const cy = Math.min(
        this.gridH - 1,
        Math.max(0, Math.floor((yi - this.domain.minY) / this.cellSize)),
      );
      let found = 0;
      const base = i * MAX_NEIGHBOURS;

      for (let oy = -1; oy <= 1 && found < MAX_NEIGHBOURS; oy++) {
        const gy = cy + oy;
        if (gy < 0 || gy >= this.gridH) continue;
        for (let ox = -1; ox <= 1 && found < MAX_NEIGHBOURS; ox++) {
          const gx = cx + ox;
          if (gx < 0 || gx >= this.gridW) continue;
          const cell = gy * this.gridW + gx;
          const end = this.cellStart[cell + 1];
          for (let s = this.cellStart[cell]; s < end && found < MAX_NEIGHBOURS; s++) {
            const j = this.sorted[s];
            if (j === i) continue;
            const dx = xi - this.qx[j];
            const dy = yi - this.qy[j];
            if (dx * dx + dy * dy < h2) {
              this.neighbours[base + found++] = j;
            }
          }
        }
      }
      this.neighbourCount[i] = found;
    }
  }

  /**
   * Advance the fluid by `dt` against a set of kinematic solids.
   * `dt` is expected to be a fixed simulation step — see `Simulation`.
   */
  step(dt: number, bodies: readonly Body[]): void {
    const p = this.params;
    const n = this.count;
    if (n === 0) return;

    // 1. Explicit Euler prediction under gravity.
    for (let i = 0; i < n; i++) {
      let vx = this.vx[i] + p.gravity.x * dt;
      let vy = this.vy[i] + p.gravity.y * dt;
      const speed = Math.hypot(vx, vy);
      if (speed > p.maxSpeed) {
        const s = p.maxSpeed / speed;
        vx *= s;
        vy *= s;
      }
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.qx[i] = this.px[i] + vx * dt;
      this.qy[i] = this.py[i] + vy * dt;
    }

    this.buildNeighbours();

    // 2. Iteratively enforce constant density, projecting out of solids between
    //    iterations so walls are honoured even under heavy pressure.
    const h = p.radius;
    const invRest = 1 / p.restDensity;
    const refPressure = poly6(0.2 * h, h);
    /** No single iteration may move a particle more than this. */
    const maxCorrection = p.spacing * 0.35;

    for (let iter = 0; iter < p.solverIterations; iter++) {
      for (let i = 0; i < n; i++) {
        const base = i * MAX_NEIGHBOURS;
        const count = this.neighbourCount[i];
        let density = p.particleMass * poly6(0, h);
        let gradSumSq = 0;
        let gradIx = 0;
        let gradIy = 0;

        for (let k = 0; k < count; k++) {
          const j = this.neighbours[base + k];
          const dx = this.qx[i] - this.qx[j];
          const dy = this.qy[i] - this.qy[j];
          const r = Math.hypot(dx, dy);
          if (r <= 1e-9) continue;
          density += p.particleMass * poly6(r, h);
          const mag = (p.particleMass * spikyGradMagnitude(r, h) * invRest) / r;
          const gx = mag * dx;
          const gy = mag * dy;
          gradIx -= gx;
          gradIy -= gy;
          gradSumSq += gx * gx + gy * gy;
        }

        this.density[i] = density;
        gradSumSq += gradIx * gradIx + gradIy * gradIy;
        const constraint = density * invRest - 1;
        this.lambda[i] = constraint <= 0 ? 0 : -constraint / (gradSumSq + p.relaxation);
      }

      for (let i = 0; i < n; i++) {
        const base = i * MAX_NEIGHBOURS;
        const count = this.neighbourCount[i];
        let dx = 0;
        let dy = 0;

        for (let k = 0; k < count; k++) {
          const j = this.neighbours[base + k];
          const rx = this.qx[i] - this.qx[j];
          const ry = this.qy[i] - this.qy[j];
          const r = Math.hypot(rx, ry);
          if (r <= 1e-9) continue;
          const w = poly6(r, h) / refPressure;
          const corr = -p.clumpResistance * w * w * w * w;
          const mag =
            ((this.lambda[i] + this.lambda[j] + corr) *
              p.particleMass *
              spikyGradMagnitude(r, h)) /
            r;
          dx += mag * rx;
          dy += mag * ry;
        }

        // Clamp the correction. The artificial-pressure term grows like 1/r, so
        // two particles forced into the same spot (a wall corner will do it) can
        // otherwise be flung out of the world in a single step.
        dx *= invRest;
        dy *= invRest;
        const magnitude = Math.hypot(dx, dy);
        if (magnitude > maxCorrection) {
          const scale = maxCorrection / magnitude;
          dx *= scale;
          dy *= scale;
        }
        this.dpx[i] = dx;
        this.dpy[i] = dy;
      }

      for (let i = 0; i < n; i++) {
        this.qx[i] += this.dpx[i];
        this.qy[i] += this.dpy[i];
      }

      this.projectOutOfSolids(bodies);
    }

    // 3. Derive velocity from the corrected positions.
    const invDt = 1 / dt;
    for (let i = 0; i < n; i++) {
      let vx = (this.qx[i] - this.px[i]) * invDt;
      let vy = (this.qy[i] - this.py[i]) * invDt;
      // Re-cap: a position correction can imply a speed the prediction cap never
      // saw, and one escapee at 200 m/s is a visible glitch.
      const speed = Math.hypot(vx, vy);
      if (speed > p.maxSpeed) {
        const scale = p.maxSpeed / speed;
        vx *= scale;
        vy *= scale;
      }
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.px[i] = this.qx[i];
      this.py[i] = this.qy[i];
    }

    this.applyViscosityAndCohesion(dt);
    this.applyBoundaryFriction(bodies);
  }

  /**
   * Push every particle out of every solid, sweeping along the path it travelled
   * this step rather than only testing where it ended up.
   *
   * A falling stream covers more ground per step than a glass wall is thick, so
   * a position-only test lets liquid pass straight through the side of the glass.
   * Walking the path in bites no larger than the collision radius catches the
   * crossing, and is far cheaper than shrinking the timestep to compensate.
   */
  private projectOutOfSolids(bodies: readonly Body[]): void {
    const radius = this.params.spacing * 0.5;
    const maxBite = Math.max(radius, this.params.spacing * 0.5);

    for (let i = 0; i < this.count; i++) {
      const fromX = this.px[i];
      const fromY = this.py[i];
      let x = this.qx[i];
      let y = this.qy[i];

      const travel = Math.hypot(x - fromX, y - fromY);
      const samples = travel > maxBite ? Math.min(8, Math.ceil(travel / maxBite)) : 1;

      if (samples > 1) {
        // Advance along the path and stop at the first solid crossed.
        let blocked = false;
        for (let k = 1; k <= samples && !blocked; k++) {
          const s = k / samples;
          const sx = fromX + (x - fromX) * s;
          const sy = fromY + (y - fromY) * s;
          for (const body of bodies) {
            const contact = body.contact({ x: sx, y: sy }, radius);
            if (!contact) continue;
            x = sx + contact.normal.x * contact.penetration;
            y = sy + contact.normal.y * contact.penetration;
            blocked = true;
            break;
          }
        }
      }

      // Final resolve at the settled position, deepest contact per body.
      for (const body of bodies) {
        const contact = body.contact({ x, y }, radius);
        if (!contact) continue;
        x += contact.normal.x * contact.penetration;
        y += contact.normal.y * contact.penetration;
      }

      this.qx[i] = x;
      this.qy[i] = y;
    }
  }

  /**
   * XSPH viscosity plus a cohesion force. Cohesion is what reads on screen as
   * surface tension: the pour holds together as a rope instead of dissolving
   * into confetti, and droplets round off.
   */
  private applyViscosityAndCohesion(dt: number): void {
    const p = this.params;
    const h = p.radius;
    const n = this.count;
    if (p.viscosity === 0 && p.cohesion === 0) return;

    const dvx = this.dpx;
    const dvy = this.dpy;
    dvx.fill(0, 0, n);
    dvy.fill(0, 0, n);

    for (let i = 0; i < n; i++) {
      const base = i * MAX_NEIGHBOURS;
      const count = this.neighbourCount[i];
      let ax = 0;
      let ay = 0;
      let cx = 0;
      let cy = 0;

      for (let k = 0; k < count; k++) {
        const j = this.neighbours[base + k];
        const rx = this.px[i] - this.px[j];
        const ry = this.py[i] - this.py[j];
        const r = Math.hypot(rx, ry);
        if (r <= 1e-9 || r >= h) continue;
        const w = poly6(r, h) * p.particleMass;
        ax += (this.vx[j] - this.vx[i]) * w;
        ay += (this.vy[j] - this.vy[i]) * w;
        // Attract towards neighbours, strongest at mid-range: the kernel must
        // vanish at both r=0 and r=h, or overlapping particles fling each other
        // apart on a 1/r singularity. Smooths the surface without fighting the
        // incompressibility constraint.
        const t = h - r;
        const pull = (p.cohesion * t * t * r) / (h * h * h);
        cx -= (rx / r) * pull;
        cy -= (ry / r) * pull;
      }

      dvx[i] = p.viscosity * ax + cx * dt;
      dvy[i] = p.viscosity * ay + cy * dt;
    }

    for (let i = 0; i < n; i++) {
      this.vx[i] += dvx[i];
      this.vy[i] += dvy[i];
    }
  }

  /**
   * Friction against solids, measured relative to the surface's own velocity so
   * a spinning glass drags its contents around instead of letting them ignore
   * the rotation.
   */
  private applyBoundaryFriction(bodies: readonly Body[]): void {
    const radius = this.params.spacing * 0.5;
    const drag = this.params.boundaryDrag;
    if (drag <= 0) return;

    for (let i = 0; i < this.count; i++) {
      const point = { x: this.px[i], y: this.py[i] };
      for (const body of bodies) {
        const contact = body.contact(point, radius * 1.6);
        if (!contact) continue;
        const surface = body.pointVelocity(point);
        const relX = this.vx[i] - surface.x;
        const relY = this.vy[i] - surface.y;
        const normalSpeed = relX * contact.normal.x + relY * contact.normal.y;
        let tx = relX - normalSpeed * contact.normal.x;
        let ty = relY - normalSpeed * contact.normal.y;
        tx *= 1 - drag * body.friction * 4;
        ty *= 1 - drag * body.friction * 4;
        const bounce = normalSpeed < 0 ? -normalSpeed * body.restitution : normalSpeed;
        this.vx[i] = surface.x + tx + bounce * contact.normal.x;
        this.vy[i] = surface.y + ty + bounce * contact.normal.y;
      }
    }
  }
}

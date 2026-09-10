import { Body } from './body';
import { Fluid, defaultFluidParams, type Domain, type FluidParams } from './fluid';
import { Jug, defaultJugConfig } from './jug';
import { agePooledSpill, cullEscaped, sampleFill, type FillReport } from './fill';
import { scoreRun, verdictFor, type ScoreResult, type Verdict } from './scoring';
import { makeBar, makeFunnel, makeGlass, makeTable } from './shapes';
import { Rng, hashSeed } from './rng';
import { clamp, segmentSegmentDistance } from './geometry';
import type { LevelSpec } from '../levels/types';

/**
 * The playfield, in metres. Portrait, sized for a phone screen.
 *
 * Narrow on purpose: the camera fits this width exactly, so the narrower it is
 * the larger the glass reads on screen. Everything a level places has to fit
 * inside it, travel included.
 */
export const PLAYFIELD: Domain = { minX: -0.36, minY: -0.12, maxX: 0.36, maxY: 1.2 };

/**
 * The part of the playfield the camera keeps in frame. The action lives between
 * the table and the top of the jug; a phone screen is taller than that, and the
 * spare room goes to the background rather than to empty space at the top.
 */
export const FRAME_BOTTOM = -0.1;
export const FRAME_TOP = 0.98;
export const TABLE_Y = 0.06;
export const FIXED_STEP = 1 / 120;
/** Never simulate more than this much wall-clock in one frame. */
const MAX_CATCHUP = 0.1;

export type Phase = 'ready' | 'pouring' | 'settling' | 'complete';

export type SimEvent =
  | { type: 'pour-start' }
  | { type: 'pour-stop' }
  /** Stream hitting liquid or glass. `strength` 0..1 drives splash + volume. */
  | { type: 'impact'; x: number; y: number; strength: number }
  /** Liquid missed or left a glass. `volume` is how much, this step. */
  | { type: 'spill'; volume: number; x: number; y: number }
  | { type: 'glass-full'; glass: number }
  | { type: 'complete'; result: RunResult };

export interface RunResult extends ScoreResult {
  verdict: Verdict;
  poured: number;
  spilled: number;
  captured: number;
  elapsed: number;
  timedOut: boolean;
}

/**
 * Per-body animation derived from the level spec. Analytic drivers set the
 * transform outright (and their own derivative, so wall friction still drags
 * liquid correctly); constant spin is integrated instead.
 */
interface Driver {
  apply(time: number): void;
}

export interface SimulationOptions {
  fluid?: Partial<FluidParams>;
  /** Particle pool size. */
  capacity?: number;
  /** How long spilled liquid lingers before being retired, in seconds. */
  spillLifetime?: number;
}

/**
 * One playable attempt at one level.
 *
 * Owns the fixed-step loop so gameplay is frame-rate independent and identical
 * on a 60Hz phone and a 144Hz desktop — mandatory for a precision game where a
 * fill target is judged to a few percent.
 */
export class Simulation {
  readonly spec: LevelSpec;
  readonly fluid: Fluid;
  readonly jug: Jug;
  readonly glasses: Body[] = [];
  readonly obstacles: Body[] = [];
  readonly table: Body;
  /** Volume each glass is asked for. */
  readonly targets: number[] = [];
  /** Volume each glass can actually hold. */
  readonly capacities: number[] = [];

  phase: Phase = 'ready';
  elapsed = 0;
  poured = 0;
  spilled = 0;
  fill: FillReport;
  result: RunResult | null = null;

  private readonly rng: Rng;
  private readonly drivers: Driver[] = [];
  /** Bodies whose rotation is integrated each step rather than set analytically. */
  private readonly spinning: Body[] = [];
  private readonly bodies: Body[] = [];
  private readonly spillLifetime: number;
  private aimX: number;
  private accumulator = 0;
  private simTime = 0;
  /** Seconds of zero flow; the run commits once the player has clearly stopped. */
  private idleTime = 0;
  private wasFlowing = false;
  private fullAnnounced: boolean[] = [];
  private pendingEvents: SimEvent[] = [];

  /**
   * Grace period after the flow stops before the run is judged. Long enough to
   * stop, slide across to a second glass and start again without the attempt
   * being cut short; a player who is genuinely finished can hit `commit()`.
   */
  static readonly COMMIT_DELAY = 1.8;
  /** Once the jug is dry there is nothing left to wait for. */
  static readonly EMPTY_COMMIT_DELAY = 0.5;

  constructor(spec: LevelSpec, options: SimulationOptions = {}) {
    this.spec = spec;
    this.rng = new Rng(spec.seed ?? hashSeed(spec.id));
    this.spillLifetime = options.spillLifetime ?? 2.5;

    const params = defaultFluidParams({ radius: 0.028, spacing: 0.014, ...options.fluid });
    this.fluid = new Fluid(options.capacity ?? 1200, params, PLAYFIELD);

    this.table = new Body('world', makeTable(1.4, 0.05), { x: 0, y: TABLE_Y });

    for (const obstacle of spec.obstacles) {
      const shape =
        obstacle.kind === 'funnel'
          ? makeFunnel(obstacle.length, obstacle.gap ?? 0.06, obstacle.depth ?? 0.08, 0.018)
          : makeBar(obstacle.length, obstacle.thickness ?? 0.02);
      const body = new Body('obstacle', shape, { x: obstacle.x, y: obstacle.y }, obstacle.angle);
      this.obstacles.push(body);
      this.addDrivers(body, obstacle);
    }

    for (const glassSpec of spec.glasses) {
      const shape = makeGlass({
        width: glassSpec.width,
        height: glassSpec.height,
        thickness: glassSpec.thickness ?? 0.022,
        taper: glassSpec.taper,
        waist: glassSpec.waist,
        waistAt: glassSpec.waistAt,
      });
      const body = new Body('glass', shape, { x: glassSpec.x, y: glassSpec.y }, glassSpec.angle);
      this.glasses.push(body);
      this.addDrivers(body, glassSpec);

      const capacity = body.measureCapacity(params.spacing * 0.5, this.obstacles);
      this.capacities.push(capacity);
      this.targets.push(capacity * glassSpec.targetFraction);
      this.fullAnnounced.push(false);
    }

    const totalTarget = this.targets.reduce((sum, t) => sum + t, 0);
    this.jug = new Jug(
      defaultJugConfig({
        charge: totalTarget * (spec.jug.chargeFactor ?? 1.5),
        ...spec.jug.config,
      }),
      { x: spec.jug.x, y: spec.jug.y },
    );
    this.aimX = spec.jug.x;
    this.jug.setSpoutX(this.aimX);

    this.bodies = [this.table, ...this.glasses, ...this.obstacles];
    this.fill = this.sample();
  }

  private addDrivers(
    body: Body,
    motion: {
      spin?: number;
      wobble?: { amplitude: number; frequency: number };
      orbit?: { radiusX: number; radiusY?: number; frequency: number };
    },
  ): void {
    if (motion.spin) {
      body.angularVelocity = motion.spin;
      this.spinning.push(body);
    }
    if (motion.wobble) {
      const { amplitude, frequency } = motion.wobble;
      const base = body.angle;
      const omega = Math.PI * 2 * frequency;
      this.drivers.push({
        apply: (time) => {
          body.angle = base + amplitude * Math.sin(omega * time);
          // Analytic derivative: friction needs the true surface velocity or a
          // wobbling glass would slide past its contents without dragging them.
          body.angularVelocity = amplitude * omega * Math.cos(omega * time);
        },
      });
    }
    if (motion.orbit) {
      const { radiusX, frequency } = motion.orbit;
      const radiusY = motion.orbit.radiusY ?? 0;
      const origin = { ...body.position };
      const omega = Math.PI * 2 * frequency;
      this.drivers.push({
        apply: (time) => {
          body.position.x = origin.x + radiusX * Math.cos(omega * time);
          body.position.y = origin.y + radiusY * Math.sin(omega * time);
          body.velocity.x = -radiusX * omega * Math.sin(omega * time);
          body.velocity.y = radiusY * omega * Math.cos(omega * time);
        },
      });
    }
  }

  /** Player input: how far the jug is tipped. */
  setTilt(tilt: number): void {
    this.jug.tilt = clamp(tilt, -1.6, 1.6);
  }

  /**
   * Player input: where the stream leaves the spout. This is the aim.
   * Held as a target and re-applied each step, since the spout's offset from the
   * jug body changes as the jug tilts.
   */
  setJugX(x: number): void {
    if (!this.spec.jug.movable) return;
    const limit = PLAYFIELD.maxX - 0.02;
    this.aimX = clamp(x, -limit, limit);
  }

  get aim(): number {
    return this.aimX;
  }

  /**
   * End the attempt now. The UI offers this so a player who knows they are done
   * does not have to wait out the settle timer — instant retry is the whole
   * point of the loop.
   */
  commit(): void {
    if (this.isComplete) return;
    this.jug.tilt = 0;
    this.finish(false);
  }

  get isComplete(): boolean {
    return this.phase === 'complete';
  }

  /** True while liquid is actually leaving the jug. */
  get isFlowing(): boolean {
    return this.wasFlowing;
  }

  get timeRemaining(): number {
    return Math.max(0, this.spec.timeLimit - this.elapsed);
  }

  get totalTarget(): number {
    return this.targets.reduce((sum, t) => sum + t, 0);
  }

  /** All solids, for the renderer. */
  get solids(): readonly Body[] {
    return this.bodies;
  }

  /**
   * Where to aim to get liquid into glass `index`: the middle of its opening,
   * led by however far the glass will travel while the stream is falling.
   *
   * A tilted glass's opening is well to one side of its base, and a travelling
   * glass has moved on by the time liquid arrives — so this is what the on-screen
   * aim guide points at, and what a competent player is actually tracking.
   */
  aimTargetFor(index: number): number {
    const glass = this.glasses[index];
    if (!glass) return 0;
    const [left, right] = glass.worldRim();
    const mouthY = (left.y + right.y) * 0.5;
    const drop = Math.max(0, this.jug.spout.y - mouthY);
    const fallTime = Math.sqrt((2 * drop) / Math.abs(this.fluid.params.gravity.y || 9.81));
    const centre = (left.x + right.x) * 0.5 + glass.velocity.x * fallTime;
    if (this.obstacles.length === 0) return centre;

    // Something is over the mouth: find the clearest channel into the glass,
    // preferring the one nearest the middle. This is the shot a player looks
    // for, and it drives the on-screen aim guide.
    const half = Math.abs(right.x - left.x) * 0.5;
    const samples = 11;
    let bestX = centre;
    let bestScore = -Infinity;
    for (let k = 0; k < samples; k++) {
      const x = centre - half + (2 * half * k) / (samples - 1);
      const clearance = this.streamClearance(x, mouthY);
      const score = Math.min(clearance, 0.05) - 0.12 * Math.abs(x - centre);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
      }
    }
    return bestX;
  }

  /**
   * How much room a stream poured at `x` has before it reaches height `toY`.
   * Negative means an obstacle is squarely in the way.
   */
  streamClearance(x: number, toY: number): number {
    const from = { x, y: this.jug.spout.y };
    const to = { x, y: toY };
    let clearance = Infinity;
    for (const obstacle of this.obstacles) {
      for (const wall of obstacle.worldWalls()) {
        const distance = segmentSegmentDistance(from, to, wall.a, wall.b) - wall.radius;
        if (distance < clearance) clearance = distance;
      }
    }
    return clearance;
  }

  /** The glass most in need of liquid, or -1 when they are all satisfied. */
  neediestGlass(): number {
    let best = -1;
    let worst = 0;
    for (let g = 0; g < this.fill.glasses.length; g++) {
      const deficit = this.fill.glasses[g].target - this.fill.glasses[g].volume;
      if (deficit > worst) {
        worst = deficit;
        best = g;
      }
    }
    return best;
  }

  /**
   * Advance by real elapsed time, consuming it in fixed steps.
   * Returns the events raised, for the audio/haptics/VFX layer.
   */
  update(frameDt: number): SimEvent[] {
    this.pendingEvents = [];
    if (this.isComplete) return this.pendingEvents;

    this.accumulator += Math.min(frameDt, MAX_CATCHUP);
    while (this.accumulator >= FIXED_STEP) {
      this.accumulator -= FIXED_STEP;
      this.stepFixed(FIXED_STEP);
      if (this.isComplete) break;
    }

    this.fill = this.sample();
    for (let g = 0; g < this.fill.glasses.length; g++) {
      const glass = this.fill.glasses[g];
      if (!this.fullAnnounced[g] && glass.volume >= glass.capacity * 0.985) {
        this.fullAnnounced[g] = true;
        this.pendingEvents.push({ type: 'glass-full', glass: g });
      }
    }

    return this.pendingEvents;
  }

  private stepFixed(dt: number): void {
    this.simTime += dt;

    for (const driver of this.drivers) driver.apply(this.simTime);
    // Only the angle is integrated here: an orbiting body's position comes from
    // its analytic driver, so advancing it again would move it twice.
    for (const body of this.spinning) body.angle += body.angularVelocity * dt;

    this.jug.setSpoutX(this.aimX);
    const emissions = this.jug.pour(dt, this.fluid.particleVolume, this.rng);
    if (emissions.length > 0) {
      if (!this.wasFlowing) {
        this.wasFlowing = true;
        this.pendingEvents.push({ type: 'pour-start' });
      }
      if (this.phase === 'ready' || this.phase === 'settling') this.phase = 'pouring';
      for (const e of emissions) {
        if (this.fluid.spawn(e.x, e.y, e.vx, e.vy) >= 0) {
          this.poured += this.fluid.particleVolume;
        }
      }
      this.idleTime = 0;
    } else {
      if (this.wasFlowing) {
        this.wasFlowing = false;
        this.pendingEvents.push({ type: 'pour-stop' });
      }
      if (this.phase === 'pouring') this.phase = 'settling';
      if (this.phase === 'settling') this.idleTime += dt;
    }

    if (this.phase !== 'ready') this.elapsed += dt;

    this.fluid.step(dt, this.bodies);

    this.spilled += cullEscaped(this.fluid, PLAYFIELD.minY, PLAYFIELD.maxX * 1.4);
    this.spilled += agePooledSpill(this.fluid, this.glasses, dt, this.spillLifetime);

    this.detectImpacts();
    this.checkCompletion();
  }

  /**
   * Raise an impact event where the stream lands. Sampled from the fastest
   * particle in contact with a solid or with settled liquid, which is enough to
   * drive splash particles, a splash sound and a haptic tick without tracking
   * collisions individually.
   */
  private detectImpacts(): void {
    let bestSpeed = 0;
    let bestX = 0;
    let bestY = 0;
    const radius = this.fluid.params.spacing * 1.2;

    for (let i = 0; i < this.fluid.count; i++) {
      const speed = Math.hypot(this.fluid.vx[i], this.fluid.vy[i]);
      if (speed < 0.9 || speed < bestSpeed) continue;
      const point = { x: this.fluid.px[i], y: this.fluid.py[i] };
      let touching = false;
      for (const body of this.bodies) {
        if (body.contact(point, radius)) {
          touching = true;
          break;
        }
      }
      if (!touching) continue;
      bestSpeed = speed;
      bestX = point.x;
      bestY = point.y;
    }

    if (bestSpeed > 0) {
      this.pendingEvents.push({
        type: 'impact',
        x: bestX,
        y: bestY,
        strength: Math.min(1, bestSpeed / this.fluid.params.maxSpeed),
      });
    }
  }

  private checkCompletion(): void {
    const timedOut = this.elapsed >= this.spec.timeLimit;
    // The run commits when the player has plainly stopped pouring and the
    // liquid has stopped moving. A pause mid-pour does not end the level,
    // because the liquid is still in motion during one.
    const delay = this.jug.isEmpty
      ? Simulation.EMPTY_COMMIT_DELAY
      : Simulation.COMMIT_DELAY;
    const stopped =
      this.phase === 'settling' && this.idleTime >= delay && this.fluid.meanSpeed() < 0.09;

    if (!timedOut && !stopped) return;
    this.finish(timedOut);
  }

  private finish(timedOut: boolean): void {
    this.phase = 'complete';
    const fill = this.sample();
    const score = scoreRun({
      glasses: fill.glasses.map((g) => ({ volume: g.volume, target: g.target })),
      poured: this.poured,
      spilled: Math.max(0, this.poured - fill.captured),
      tolerance: this.spec.tolerance,
    });
    this.result = {
      ...score,
      verdict: verdictFor(score),
      poured: this.poured,
      spilled: Math.max(0, this.poured - fill.captured),
      captured: fill.captured,
      elapsed: this.elapsed,
      timedOut,
    };
    this.fill = fill;
    this.pendingEvents.push({ type: 'complete', result: this.result });
  }

  private sample(): FillReport {
    return sampleFill(this.fluid, this.glasses, this.targets, this.capacities);
  }

  /** Run headless for `seconds`, for tests and for tuning sweeps. */
  runHeadless(seconds: number, controller?: (sim: Simulation, time: number) => void): RunResult | null {
    const steps = Math.round(seconds / FIXED_STEP);
    for (let s = 0; s < steps && !this.isComplete; s++) {
      // Refresh the fill report every step so a headless controller sees the
      // same information a player reads off the screen.
      this.fill = this.sample();
      controller?.(this, s * FIXED_STEP);
      this.stepFixed(FIXED_STEP);
    }
    this.fill = this.sample();
    return this.result;
  }
}

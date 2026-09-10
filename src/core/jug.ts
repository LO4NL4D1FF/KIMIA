import { type Vec2, clamp, clamp01, lerp, rotate } from './geometry';
import type { Rng } from './rng';

export interface JugConfig {
  /** Total liquid the jug starts with, in the same volume units as the fluid. */
  charge: number;
  /** Jug body size, used for the spout position and the fill gauge. */
  width: number;
  height: number;
  /** Tilt at which a *brimming* jug starts to pour. */
  tiltStart: number;
  /** Tilt at which an *almost empty* jug starts to pour. */
  tiltStartEmpty: number;
  /** Tilt at which flow is at maximum. */
  tiltFull: number;
  /** Cross-section of the spout: the master control on peak flow rate. */
  spoutArea: number;
  /** Peak exit speed, reached at `tiltFull` with a full jug. */
  exitSpeed: number;
  /** How much the stream fans out, in radians. */
  spread: number;
  /**
   * How far tilt deflects the stream from vertical. Small on purpose: the
   * player aims with the spout and meters with the tilt, so tilting must not
   * also swing the aim. What is left is a subtle penalty for over-tilting.
   */
  lateralThrow: number;
}

export function defaultJugConfig(overrides: Partial<JugConfig> = {}): JugConfig {
  return {
    charge: 0.06,
    width: 0.19,
    height: 0.22,
    tiltStart: 0.3,
    tiltStartEmpty: 0.92,
    tiltFull: 1.5,
    // Tuned so a glass takes a few seconds of full flow to fill: long enough to
    // correct mid-pour, short enough that a level lands inside 15-30 seconds.
    spoutArea: 0.02,
    exitSpeed: 0.62,
    spread: 0.05,
    lateralThrow: 0.18,
    ...overrides,
  };
}

export interface Emission {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * The player's jug.
 *
 * The liquid still in the jug is tracked as a scalar rather than simulated —
 * that keeps the entire particle budget on the part the player is actually
 * judging (the stream and the glass), and it lets the tilt->flow curve be tuned
 * and regression-tested directly.
 *
 * The curve is modelled on the real thing, because that is what makes the pour
 * feel like it has weight:
 *  - nothing comes out until the lip drops below the liquid line;
 *  - a full jug tips over its lip much sooner than an empty one;
 *  - flow speed follows Torricelli's sqrt(head), so it eases in rather than
 *    switching on, and tapers as the jug drains.
 */
export class Jug {
  readonly config: JugConfig;

  position: Vec2;
  /** 0 = upright. Positive tilt pours to the right. */
  tilt = 0;
  /** Liquid remaining. */
  remaining: number;

  /** Fractional particle carried between steps so slow pours still emit. */
  private budget = 0;
  /** Smoothed flow, for audio and stream width. */
  private smoothedFlow = 0;

  constructor(config: JugConfig, position: Vec2) {
    this.config = config;
    this.position = { ...position };
    this.remaining = config.charge;
  }

  reset(): void {
    this.remaining = this.config.charge;
    this.tilt = 0;
    this.budget = 0;
    this.smoothedFlow = 0;
  }

  get fillFraction(): number {
    return this.config.charge > 0 ? clamp01(this.remaining / this.config.charge) : 0;
  }

  get isEmpty(): boolean {
    return this.remaining <= 1e-9;
  }

  /** Tilt at which liquid currently reaches the lip. Rises as the jug drains. */
  get pourThreshold(): number {
    return lerp(this.config.tiltStartEmpty, this.config.tiltStart, this.fillFraction);
  }

  /** 0 -> 1 how far past the tipping point the jug is. */
  get openFraction(): number {
    if (this.isEmpty) return 0;
    const span = Math.max(1e-6, this.config.tiltFull - this.pourThreshold);
    return clamp01((Math.abs(this.tilt) - this.pourThreshold) / span);
  }

  /** Volume per second leaving the spout right now. */
  get flowRate(): number {
    const open = this.openFraction;
    if (open <= 0) return 0;
    // sqrt gives the eased onset; the fill term makes a draining jug dribble.
    const head = open * lerp(0.45, 1, this.fillFraction);
    return this.config.spoutArea * this.config.exitSpeed * Math.sqrt(head);
  }

  get smoothedFlowRate(): number {
    return this.smoothedFlow;
  }

  /**
   * Rotation of the jug body. Positive `tilt` rotates clockwise, which is what
   * swings the right-hand lip down and over the glass.
   */
  get bodyAngle(): number {
    return -this.tilt;
  }

  /** Offset from the jug's origin to its spout lip, at the current tilt. */
  get spoutOffset(): Vec2 {
    const side = this.tilt >= 0 ? 1 : -1;
    const local = { x: this.config.width * 0.5 * side, y: this.config.height * 0.5 };
    return rotate(local, this.bodyAngle);
  }

  /** World-space position of the spout lip — the side the jug is tipped towards. */
  get spout(): Vec2 {
    const offset = this.spoutOffset;
    return { x: offset.x + this.position.x, y: offset.y + this.position.y };
  }

  /**
   * Place the jug so its spout sits at `x`.
   *
   * The spout is the aim point: it is where the player sees liquid leave, and it
   * is directly above where the stream lands. Driving the jug's body from it
   * means tilting to meter the flow never drags the aim sideways.
   */
  setSpoutX(x: number): void {
    this.position.x = x - this.spoutOffset.x;
  }

  get spoutX(): number {
    return this.spout.x;
  }

  /**
   * Advance the pour and return the particles to spawn this step.
   * Returns an empty array when nothing is flowing, which is the common case.
   */
  pour(dt: number, particleVolume: number, rng: Rng): Emission[] {
    const rate = this.flowRate;
    this.smoothedFlow += (rate - this.smoothedFlow) * clamp01(dt * 12);

    if (rate <= 0 || this.isEmpty) return [];

    const wanted = Math.min(rate * dt, this.remaining);
    this.budget += wanted;
    const n = Math.floor(this.budget / particleVolume);
    if (n <= 0) return [];

    const dispensed = Math.min(n * particleVolume, this.remaining);
    this.budget -= dispensed;
    this.remaining = Math.max(0, this.remaining - dispensed);

    const emissions: Emission[] = [];
    const actual = Math.round(dispensed / particleVolume);
    const spout = this.spout;
    const side = this.tilt >= 0 ? 1 : -1;
    // The stream leaves along the lip, so its direction swings with the tilt —
    // over-tilting throws liquid sideways past the glass.
    const speed = this.config.exitSpeed * Math.sqrt(this.openFraction) * 1.6;
    const baseAngle =
      -Math.PI / 2 + side * clamp(Math.abs(this.tilt), 0, 1.6) * this.config.lateralThrow;

    for (let k = 0; k < actual; k++) {
      const angle = baseAngle + rng.jitter(this.config.spread);
      const jitter = this.config.width * 0.04;
      emissions.push({
        x: spout.x + rng.jitter(jitter),
        y: spout.y + rng.jitter(jitter),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
      });
    }
    return emissions;
  }
}

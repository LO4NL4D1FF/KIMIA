/**
 * Deterministic PRNG. The whole simulation must be reproducible from a seed so
 * that physics regressions are catchable in tests and endless runs can be
 * replayed / verified.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Avoid the degenerate 0 state.
    this.state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  /** Uniform in [0, 1). mulberry32 — small state, good enough distribution. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Uniform in [-amount, amount]. */
  jitter(amount: number): number {
    return this.range(-amount, amount);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt + 1, 0x85ebca6b)) | 0);
  }
}

/** Stable hash of a string -> 32-bit int, for deriving seeds from level ids. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

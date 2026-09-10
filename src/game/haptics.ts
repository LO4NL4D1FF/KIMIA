/**
 * Light haptics on mobile. Deliberately sparse: buzzing on every frame of a
 * pour would be unpleasant and would drain the battery, so this fires on
 * discrete moments only, and rate-limits itself.
 */
export class Haptics {
  private enabled = true;
  private lastAt = 0;

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  private fire(pattern: number | number[], minGapMs: number): void {
    if (!this.enabled || !this.supported) return;
    const now = performance.now();
    if (now - this.lastAt < minGapMs) return;
    this.lastAt = now;
    try {
      navigator.vibrate(pattern);
    } catch {
      // Some browsers expose vibrate but refuse to run it; never a fatal error.
    }
  }

  /** The stream starting to land. */
  tick(): void {
    this.fire(8, 120);
  }

  /** Liquid missing the glass. */
  spill(): void {
    this.fire(18, 220);
  }

  /** Landing a perfect fill. */
  success(stars: number): void {
    this.fire(stars >= 3 ? [14, 50, 14, 50, 26] : [12, 60, 18], 0);
  }

  fail(): void {
    this.fire([26, 70, 26], 0);
  }
}

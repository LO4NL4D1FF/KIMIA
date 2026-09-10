import { clamp } from '../core/geometry';
import type { Camera } from '../render/camera';

/**
 * Pour control.
 *
 * Two axes on one thumb, which is what the mechanic needs and all it needs:
 *  - horizontal: the aim follows your finger directly. Absolute rather than
 *    relative, because you are aiming at a thing you can see.
 *  - vertical: dragging up tips the jug further, so flow is metered by feel and
 *    held steady by holding still. Touching down already pours gently, so a tap
 *    and hold is a valid, gentle pour.
 *
 * Releasing returns the jug upright, which is also how you end an attempt.
 */
export interface PourInput {
  /** Requested jug tilt in radians. */
  tilt: number;
  /** Requested aim, in world X. */
  aim: number;
  active: boolean;
}

export interface InputOptions {
  /** Tilt applied the instant a press begins. */
  baseTilt?: number;
  maxTilt?: number;
  /** Screen distance, in CSS pixels, for the full tilt range. */
  dragRange?: number;
}

export class PourController {
  private pointerId: number | null = null;
  private startY = 0;
  private currentTilt = 0;
  private currentAim = 0;
  private held = false;

  private readonly baseTilt: number;
  private readonly maxTilt: number;
  private readonly dragRange: number;

  /** Keyboard state, for playing at a desk. */
  private keys = { pour: false, left: false, right: false, more: false, less: false };

  constructor(
    private readonly element: HTMLElement,
    private readonly camera: Camera,
    options: InputOptions = {},
  ) {
    this.baseTilt = options.baseTilt ?? 0.62;
    this.maxTilt = options.maxTilt ?? 1.5;
    this.dragRange = options.dragRange ?? 190;
  }

  private bound = false;
  private readonly onPointerDown = (event: PointerEvent) => {
    if (this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.element.setPointerCapture?.(event.pointerId);
    this.startY = event.clientY;
    this.held = true;
    this.currentTilt = this.baseTilt;
    this.currentAim = this.aimFromClientX(event.clientX);
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    // Up is positive: dragging up opens the pour.
    const dragged = this.startY - event.clientY;
    this.currentTilt = clamp(
      this.baseTilt + (dragged / this.dragRange) * (this.maxTilt - this.baseTilt),
      0,
      this.maxTilt,
    );
    this.currentAim = this.aimFromClientX(event.clientX);
    event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.held = false;
    this.currentTilt = 0;
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    if (this.applyKey(event.code, true)) event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (this.applyKey(event.code, false)) event.preventDefault();
  };

  private applyKey(code: string, down: boolean): boolean {
    switch (code) {
      case 'Space':
        this.keys.pour = down;
        return true;
      case 'ArrowLeft':
      case 'KeyA':
        this.keys.left = down;
        return true;
      case 'ArrowRight':
      case 'KeyD':
        this.keys.right = down;
        return true;
      case 'ArrowUp':
      case 'KeyW':
        this.keys.more = down;
        return true;
      case 'ArrowDown':
      case 'KeyS':
        this.keys.less = down;
        return true;
      default:
        return false;
    }
  }

  attach(): void {
    if (this.bound) return;
    this.bound = true;
    this.element.addEventListener('pointerdown', this.onPointerDown);
    this.element.addEventListener('pointermove', this.onPointerMove);
    this.element.addEventListener('pointerup', this.onPointerUp);
    this.element.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.reset();
  }

  reset(): void {
    this.pointerId = null;
    this.held = false;
    this.currentTilt = 0;
  }

  /** Seed the aim so a level starts pointing at its glass. */
  setAim(aim: number): void {
    this.currentAim = aim;
  }

  private aimFromClientX(clientX: number): number {
    const rect = this.element.getBoundingClientRect();
    const x = ((clientX - rect.left) / Math.max(rect.width, 1)) * this.camera.width;
    return this.camera.toWorldX(x);
  }

  /** Sample the current request. `dt` drives keyboard ramping. */
  sample(dt: number): PourInput {
    let tilt = this.currentTilt;
    let aim = this.currentAim;

    if (this.keys.pour) {
      const keyboardTilt = this.keys.more ? this.maxTilt : this.keys.less ? this.baseTilt * 0.55 : this.baseTilt;
      tilt = Math.max(tilt, keyboardTilt);
    }
    const nudge = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    if (nudge !== 0) {
      aim += nudge * dt * 0.55;
      this.currentAim = aim;
    }

    return { tilt, aim, active: this.held || this.keys.pour };
  }
}

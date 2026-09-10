import { FRAME_BOTTOM, FRAME_TOP, PLAYFIELD } from '../core/simulation';
import type { Vec2 } from '../core/geometry';

/**
 * Maps world metres to pixels.
 *
 * The full playfield width is always visible, because horizontal room is where
 * the player aims — cropping it would cut off legal shots. Height is then
 * whatever the screen's aspect gives, anchored so the table sits near the
 * bottom; the extra room above is where the illustrated background lives.
 */
export class Camera {
  width = 1;
  height = 1;
  dpr = 1;
  /** Pixels per world metre. */
  scale = 1;
  /** World-space coordinates of the bottom-left of the viewport. */
  originX = PLAYFIELD.minX;
  originY = PLAYFIELD.minY;

  /** Screen shake offset in pixels, applied at draw time only. */
  shakeX = 0;
  shakeY = 0;

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr;
    this.width = Math.max(1, Math.round(cssWidth * dpr));
    this.height = Math.max(1, Math.round(cssHeight * dpr));

    const worldWidth = PLAYFIELD.maxX - PLAYFIELD.minX;
    this.scale = this.width / worldWidth;
    this.originX = PLAYFIELD.minX;

    // Centre the action vertically. On a tall phone this puts the table in the
    // lower third and gives the illustrated background the space above, instead
    // of stranding the glass at the bottom of an empty screen.
    const visibleHeight = this.height / this.scale;
    const frameHeight = FRAME_TOP - FRAME_BOTTOM;
    const centre = (FRAME_TOP + FRAME_BOTTOM) * 0.5;
    this.originY =
      visibleHeight >= frameHeight ? centre - visibleHeight * 0.5 : FRAME_BOTTOM;
  }

  toScreenX(worldX: number): number {
    return (worldX - this.originX) * this.scale + this.shakeX;
  }

  /** Y is flipped: world Y is up, canvas Y is down. */
  toScreenY(worldY: number): number {
    return this.height - (worldY - this.originY) * this.scale + this.shakeY;
  }

  toScreen(world: Vec2): Vec2 {
    return { x: this.toScreenX(world.x), y: this.toScreenY(world.y) };
  }

  toWorldX(screenX: number): number {
    return (screenX - this.shakeX) / this.scale + this.originX;
  }

  toWorldY(screenY: number): number {
    return (this.height - screenY + this.shakeY) / this.scale + this.originY;
  }

  /** World metres per CSS pixel, for pointer deltas. */
  get worldPerCssPixel(): number {
    return this.dpr / this.scale;
  }
}

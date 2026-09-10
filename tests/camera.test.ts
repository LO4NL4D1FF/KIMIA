import { describe, it, expect } from 'vitest';
import { Camera } from '../src/render/camera';
import { FRAME_BOTTOM, FRAME_TOP, PLAYFIELD, TABLE_Y } from '../src/core/simulation';

function phone(): Camera {
  const camera = new Camera();
  camera.resize(430, 900, 2);
  return camera;
}

describe('camera', () => {
  it('always fits the full playfield width, because that is where you aim', () => {
    for (const [w, h] of [[430, 900], [360, 640], [1024, 768], [390, 1200]]) {
      const camera = new Camera();
      camera.resize(w, h, 1);
      expect(camera.toScreenX(PLAYFIELD.minX)).toBeCloseTo(0, 4);
      expect(camera.toScreenX(PLAYFIELD.maxX)).toBeCloseTo(camera.width, 4);
    }
  });

  it('keeps the whole action in frame on a phone', () => {
    const camera = phone();
    const top = camera.toScreenY(FRAME_TOP);
    const bottom = camera.toScreenY(FRAME_BOTTOM);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(camera.height);
    // The table should sit in the lower part of the screen, not at the very edge.
    const table = camera.toScreenY(TABLE_Y);
    expect(table).toBeGreaterThan(camera.height * 0.5);
    expect(table).toBeLessThan(camera.height * 0.95);
  });

  it('puts world Y up and screen Y down', () => {
    const camera = phone();
    expect(camera.toScreenY(1)).toBeLessThan(camera.toScreenY(0));
  });

  it('round-trips screen and world coordinates', () => {
    const camera = phone();
    for (const x of [-0.3, -0.05, 0, 0.12, 0.34]) {
      expect(camera.toWorldX(camera.toScreenX(x))).toBeCloseTo(x, 5);
    }
    for (const y of [0, 0.25, 0.6, 0.95]) {
      expect(camera.toWorldY(camera.toScreenY(y))).toBeCloseTo(y, 5);
    }
  });

  it('round-trips while the screen is shaking', () => {
    const camera = phone();
    camera.shakeX = 9;
    camera.shakeY = -6;
    expect(camera.toWorldX(camera.toScreenX(0.2))).toBeCloseTo(0.2, 5);
    expect(camera.toWorldY(camera.toScreenY(0.4))).toBeCloseTo(0.4, 5);
  });

  it('scales with device pixel ratio without moving anything in world terms', () => {
    const low = new Camera();
    low.resize(430, 900, 1);
    const high = new Camera();
    high.resize(430, 900, 3);
    expect(high.scale).toBeCloseTo(low.scale * 3, 4);
    expect(high.toWorldX(high.toScreenX(0.2))).toBeCloseTo(0.2, 5);
  });
});

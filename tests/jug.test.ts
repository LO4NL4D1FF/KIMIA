import { describe, it, expect } from 'vitest';
import { Jug, defaultJugConfig } from '../src/core/jug';
import { Rng } from '../src/core/rng';

const PARTICLE_VOLUME = 0.014 * 0.014; // matches Simulation's fluid resolution

function makeJug(overrides = {}) {
  return new Jug(defaultJugConfig(overrides), { x: 0, y: 1 });
}

describe('jug pour curve', () => {
  it('does not pour while upright', () => {
    const jug = makeJug();
    expect(jug.flowRate).toBe(0);
    expect(jug.pour(1 / 60, PARTICLE_VOLUME, new Rng(1))).toHaveLength(0);
  });

  it('pours faster the further it is tilted', () => {
    const jug = makeJug();
    const rates: number[] = [];
    for (const tilt of [0.4, 0.7, 1.0, 1.3, 1.5]) {
      jug.tilt = tilt;
      rates.push(jug.flowRate);
    }
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeGreaterThan(rates[i - 1]);
    }
  });

  it('tips over its lip sooner when full than when nearly empty', () => {
    const full = makeJug();
    const nearlyEmpty = makeJug();
    nearlyEmpty.remaining = nearlyEmpty.config.charge * 0.05;
    expect(full.pourThreshold).toBeLessThan(nearlyEmpty.pourThreshold);

    full.tilt = 0.5;
    nearlyEmpty.tilt = 0.5;
    expect(full.flowRate).toBeGreaterThan(0);
    expect(nearlyEmpty.flowRate).toBe(0);
  });

  it('never dispenses more than it holds', () => {
    const jug = makeJug({ charge: 0.01 });
    jug.tilt = 1.5;
    const rng = new Rng(7);
    let emitted = 0;
    for (let i = 0; i < 2000; i++) {
      emitted += jug.pour(1 / 120, PARTICLE_VOLUME, rng).length;
    }
    expect(jug.isEmpty).toBe(true);
    expect(emitted * PARTICLE_VOLUME).toBeLessThanOrEqual(0.01 + PARTICLE_VOLUME);
    expect(emitted).toBeGreaterThan(10);
  });

  it('conserves volume: dispensed + remaining equals the charge', () => {
    const jug = makeJug();
    jug.tilt = 0.9;
    const rng = new Rng(3);
    let dispensed = 0;
    for (let i = 0; i < 600; i++) {
      dispensed += jug.pour(1 / 120, PARTICLE_VOLUME, rng).length * PARTICLE_VOLUME;
    }
    expect(dispensed + jug.remaining).toBeCloseTo(jug.config.charge, 3);
  });

  it('aims the stream further right as it is tilted further', () => {
    const jug = makeJug();
    const rng = new Rng(11);
    jug.tilt = 0.5;
    const gentle = jug.pour(1 / 20, PARTICLE_VOLUME, rng)[0];
    jug.tilt = 1.5;
    const steep = jug.pour(1 / 20, PARTICLE_VOLUME, rng)[0];
    expect(gentle).toBeDefined();
    expect(steep).toBeDefined();
    expect(steep.vx).toBeGreaterThan(gentle.vx);
  });

  it('moves the spout with the jug and mirrors it when tilting left', () => {
    const jug = makeJug();
    jug.tilt = 1.2;
    const right = jug.spout;
    jug.tilt = -1.2;
    const left = jug.spout;
    expect(right.x).toBeGreaterThan(0);
    expect(left.x).toBeLessThan(0);
  });

  it('slows down as it drains at a fixed tilt', () => {
    const jug = makeJug();
    jug.tilt = 1.0;
    const rng = new Rng(5);
    const early = jug.flowRate;
    for (let i = 0; i < 400; i++) jug.pour(1 / 120, PARTICLE_VOLUME, rng);
    const late = jug.flowRate;
    expect(late).toBeLessThan(early);
  });
});

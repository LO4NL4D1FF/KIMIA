import { describe, it, expect } from 'vitest';
import {
  Fluid,
  defaultFluidParams,
  latticeRestDensity,
  poly6,
  spikyGradMagnitude,
} from '../src/core/fluid';
import { Body } from '../src/core/body';
import { makeGlass } from '../src/core/shapes';

const DOMAIN = { minX: -1, minY: -0.2, maxX: 1, maxY: 2 };

/** A box wide enough to hold a settled block, used as the reference vessel. */
function testVessel(): Body {
  return new Body('glass', makeGlass({ width: 0.5, height: 0.8, thickness: 0.03 }), {
    x: 0,
    y: 0,
  });
}

/** Fill the lower part of a vessel with a lattice of particles. */
function fillLattice(fluid: Fluid, columns: number, rows: number, originX = -0.2, originY = 0.05) {
  const s = fluid.params.spacing;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      fluid.spawn(originX + i * s, originY + j * s);
    }
  }
}

function settle(fluid: Fluid, bodies: Body[], seconds: number, dt = 1 / 120) {
  const steps = Math.round(seconds / dt);
  for (let s = 0; s < steps; s++) fluid.step(dt, bodies);
}

describe('smoothing kernels', () => {
  const h = 0.05;

  it('poly6 peaks at zero distance and vanishes at the cutoff', () => {
    expect(poly6(0, h)).toBeGreaterThan(0);
    expect(poly6(h, h)).toBe(0);
    expect(poly6(h * 1.5, h)).toBe(0);
  });

  it('poly6 decreases monotonically over its support', () => {
    let previous = poly6(0, h);
    for (let r = h / 20; r < h; r += h / 20) {
      const current = poly6(r, h);
      expect(current).toBeLessThan(previous);
      previous = current;
    }
  });

  it('spiky gradient is attractive-signed and vanishes at the cutoff', () => {
    expect(spikyGradMagnitude(h * 0.5, h)).toBeLessThan(0);
    expect(spikyGradMagnitude(h, h)).toBe(0);
    expect(spikyGradMagnitude(0, h)).toBe(0);
  });

  it('derives a rest density consistent with the kernel and spacing', () => {
    const h2 = 0.05;
    const spacing = h2 / 2;
    const mass = spacing * spacing;
    const rest = latticeRestDensity(h2, spacing, mass);
    // A lattice at `spacing` must register denser than an isolated particle and
    // stay finite — this is the invariant the whole solver is calibrated on.
    expect(rest).toBeGreaterThan(mass * poly6(0, h2));
    expect(Number.isFinite(rest)).toBe(true);
  });
});

describe('fluid solver stability', () => {
  it('never produces NaN or escapes the vessel when dropped from height', () => {
    const params = defaultFluidParams();
    const fluid = new Fluid(600, params, DOMAIN);
    const vessel = testVessel();
    fillLattice(fluid, 14, 14, -0.16, 0.4);

    settle(fluid, [vessel], 4);

    expect(fluid.count).toBe(196);
    for (let i = 0; i < fluid.count; i++) {
      expect(Number.isFinite(fluid.px[i])).toBe(true);
      expect(Number.isFinite(fluid.py[i])).toBe(true);
      // Inside the glass, allowing for the wall's own thickness.
      expect(fluid.py[i]).toBeGreaterThan(-0.02);
      expect(Math.abs(fluid.px[i])).toBeLessThan(0.28);
    }
  });

  it('comes to rest instead of jittering forever', () => {
    const fluid = new Fluid(600, defaultFluidParams(), DOMAIN);
    const vessel = testVessel();
    fillLattice(fluid, 12, 10, -0.13, 0.05);

    settle(fluid, [vessel], 5);

    expect(fluid.meanSpeed()).toBeLessThan(0.05);
  });

  it('resists compression: a settled pool keeps its volume as area', () => {
    const params = defaultFluidParams();
    const fluid = new Fluid(600, params, DOMAIN);
    const vessel = testVessel();
    fillLattice(fluid, 12, 12, -0.13, 0.1);
    const expectedVolume = fluid.volume;

    settle(fluid, [vessel], 5);

    // Measure the footprint of the settled pool: width times surface height.
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < fluid.count; i++) {
      maxY = Math.max(maxY, fluid.py[i]);
      minX = Math.min(minX, fluid.px[i]);
      maxX = Math.max(maxX, fluid.px[i]);
    }
    const occupied = (maxX - minX) * maxY;
    // A perfectly packed pool would equal expectedVolume; real packing plus the
    // meniscus leaves a bit of slack. Crucially it must not collapse to nothing.
    expect(occupied).toBeGreaterThan(expectedVolume * 0.7);
    expect(occupied).toBeLessThan(expectedVolume * 2.2);
  });

  it('is deterministic: identical setups produce identical state', () => {
    const run = () => {
      const fluid = new Fluid(400, defaultFluidParams(), DOMAIN);
      const vessel = testVessel();
      fillLattice(fluid, 10, 10, -0.11, 0.3);
      settle(fluid, [vessel], 2);
      return Array.from(fluid.px.slice(0, fluid.count)).concat(
        Array.from(fluid.py.slice(0, fluid.count)),
      );
    };
    expect(run()).toEqual(run());
  });

  it('keeps liquid in a tilted glass but lets it pour out past the tipping point', () => {
    const params = defaultFluidParams();
    const held = new Fluid(400, params, DOMAIN);
    const vesselHeld = testVessel();
    vesselHeld.angle = 0.35;
    fillLattice(held, 10, 6, -0.1, 0.05);
    settle(held, [vesselHeld], 3);
    const retained = countInside(held, vesselHeld);

    const tipped = new Fluid(400, params, DOMAIN);
    const vesselTipped = testVessel();
    vesselTipped.angle = 1.5;
    fillLattice(tipped, 10, 6, -0.1, 0.05);
    settle(tipped, [vesselTipped], 3);
    const spilled = countInside(tipped, vesselTipped);

    expect(retained).toBeGreaterThan(50);
    expect(spilled).toBeLessThan(retained * 0.6);
  });
});

function countInside(fluid: Fluid, body: Body): number {
  let inside = 0;
  for (let i = 0; i < fluid.count; i++) {
    if (body.containsPoint({ x: fluid.px[i], y: fluid.py[i] })) inside++;
  }
  return inside;
}

describe('kinematic bodies', () => {
  it('drags liquid around when spun', () => {
    const fluid = new Fluid(400, defaultFluidParams(), DOMAIN);
    const glass = testVessel();
    fillLattice(fluid, 10, 8, -0.11, 0.05);
    settle(fluid, [glass], 2);

    glass.angularVelocity = 6;
    let peakSpeed = 0;
    for (let s = 0; s < 120; s++) {
      glass.advance(1 / 120);
      fluid.step(1 / 120, [glass]);
      peakSpeed = Math.max(peakSpeed, fluid.meanSpeed());
    }

    expect(peakSpeed).toBeGreaterThan(0.2);
  });

  it('measures the capacity a container can really hold', () => {
    const glass = new Body('glass', makeGlass({ width: 0.4, height: 0.6, thickness: 0.02 }), {
      x: 0,
      y: 0,
    });
    const capacity = glass.measureCapacity(0.0125);
    const nominal = 0.4 * 0.6;
    // Wall clearance eats into the nominal box but must not dominate it.
    expect(capacity).toBeLessThan(nominal);
    expect(capacity).toBeGreaterThan(nominal * 0.75);
  });

  it('counts an obstacle as displaced volume', () => {
    const glass = new Body('glass', makeGlass({ width: 0.4, height: 0.6, thickness: 0.02 }), {
      x: 0,
      y: 0,
    });
    const bare = glass.measureCapacity(0.0125);
    const bar = new Body(
      'obstacle',
      { walls: [{ a: { x: -0.15, y: 0 }, b: { x: 0.15, y: 0 }, radius: 0.02 }], interior: [], rim: [{ x: 0, y: 0 }, { x: 0, y: 0 }] },
      { x: 0, y: 0.3 },
    );
    const blocked = glass.measureCapacity(0.0125, [bar]);
    expect(blocked).toBeLessThan(bare);
  });
});

describe('boundary integrity', () => {
  it('does not tunnel through a glass wall at speed', () => {
    // A wall thinner than the distance a fast particle covers in one step is
    // the classic tunnelling case: without a swept test the stream pours
    // straight through the side of the glass.
    const params = defaultFluidParams({ radius: 0.028, spacing: 0.014 });
    const fluid = new Fluid(64, params, DOMAIN);
    const glass = new Body(
      'glass',
      makeGlass({ width: 0.2, height: 0.3, thickness: 0.016 }),
      { x: 0, y: 0 },
    );

    // Fire particles horizontally at the left wall, hard.
    for (let k = 0; k < 8; k++) {
      fluid.spawn(0.05, 0.05 + k * params.spacing, -5.5, 0);
    }
    settle(fluid, [glass], 1.5);

    for (let i = 0; i < fluid.count; i++) {
      expect(glass.containsPoint({ x: fluid.px[i], y: fluid.py[i] })).toBe(true);
    }
  });

  it('holds a full glass without leaking through the base', () => {
    const params = defaultFluidParams({ radius: 0.028, spacing: 0.014 });
    const fluid = new Fluid(600, params, DOMAIN);
    const glass = new Body(
      'glass',
      makeGlass({ width: 0.22, height: 0.3, thickness: 0.022 }),
      { x: 0, y: 0 },
    );
    const s = params.spacing;
    for (let j = 0; j < 14; j++) {
      for (let i = 0; i < 12; i++) fluid.spawn(-0.08 + i * s, 0.02 + j * s);
    }
    const before = fluid.count;
    settle(fluid, [glass], 4);

    let inside = 0;
    for (let i = 0; i < fluid.count; i++) {
      if (glass.containsPoint({ x: fluid.px[i], y: fluid.py[i] })) inside++;
    }
    expect(inside).toBe(before);
  });
});

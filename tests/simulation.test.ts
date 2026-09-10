import { describe, it, expect } from 'vitest';
import { Simulation, PLAYFIELD } from '../src/core/simulation';
import { buildLevel } from '../src/levels/campaign';
import { buildEndlessStage } from '../src/levels/endless';
import type { LevelSpec } from '../src/levels/types';

/**
 * A reference autoplayer: aim at the mouth of whichever glass is furthest from
 * its target, tip the jug, and stop once what is poured plus what is still
 * falling will hit the mark.
 *
 * This is the yardstick for whether a level is playable. It does exactly what
 * the game asks a player to do — aim, meter the flow, stop at the right moment —
 * and nothing more. A level it cannot finish is asking for a skill the game does
 * not teach, which is a level design bug, not a difficulty setting.
 */
function autoPour(tilt = 1.0) {
  return (sim: Simulation) => {
    const needy = sim.neediestGlass();
    if (needy < 0) {
      sim.setTilt(0);
      return;
    }
    sim.setJugX(sim.aimTargetFor(needy));

    const captured = sim.fill.glasses.reduce((sum, g) => sum + g.volume, 0);
    const target = sim.totalTarget;
    sim.setTilt(captured + sim.fill.airborne < target * 0.995 ? tilt : 0);
  };
}

function play(spec: LevelSpec, controller = autoPour(), seconds = spec.timeLimit + 4) {
  const sim = new Simulation(spec);
  sim.runHeadless(seconds, controller);
  return sim;
}

describe('simulation loop', () => {
  it('builds a level with a real capacity and a reachable target', () => {
    const sim = new Simulation(buildLevel(1, 1));
    expect(sim.capacities[0]).toBeGreaterThan(0);
    expect(sim.totalTarget).toBeGreaterThan(0);
    expect(sim.totalTarget).toBeLessThan(sim.capacities[0]);
    // The jug must hold enough to finish the level.
    expect(sim.jug.config.charge).toBeGreaterThan(sim.totalTarget);
  });

  it('starts idle and only runs the clock once liquid is flowing', () => {
    const sim = new Simulation(buildLevel(1, 1));
    sim.runHeadless(1.5, (s) => s.setTilt(0));
    expect(sim.phase).toBe('ready');
    expect(sim.elapsed).toBe(0);
    expect(sim.poured).toBe(0);
  });

  it('plays the opening level to three stars', () => {
    const sim = play(buildLevel(1, 1));
    expect(sim.phase).toBe('complete');
    expect(sim.result).not.toBeNull();
    expect(sim.result!.timedOut).toBe(false);
    expect(sim.result!.stars).toBe(3);
  });

  it('conserves volume: everything poured is either captured or spilled', () => {
    const sim = play(buildLevel(1, 3));
    const result = sim.result!;
    expect(result.poured).toBeGreaterThan(0);
    expect(result.captured + result.spilled).toBeCloseTo(result.poured, 6);
  });

  it('overflows rather than exceeding the glass capacity', () => {
    // Pour and never stop.
    const sim = play(buildLevel(1, 2), (s) => s.setTilt(1.5));
    // Capacity is sampled on a grid, whereas settled liquid packs a little
    // tighter than that (measured at 1.02-1.14x), so a full glass holds
    // marginally more than the geometric figure. What matters is that it is
    // bounded at all: the excess must go over the side, not compress in.
    expect(sim.fill.glasses[0].volume).toBeLessThan(sim.capacities[0] * 1.2);
    expect(sim.fill.glasses[0].volume).toBeGreaterThan(sim.capacities[0] * 0.85);
    expect(sim.result!.spilled).toBeGreaterThan(0);
    expect(sim.result!.stars).toBeLessThan(3);
  });

  it('fails a pour aimed away from the glass, and calls it a spill', () => {
    const spec = buildLevel(1, 1);
    const sim = new Simulation(spec);
    sim.runHeadless(spec.timeLimit + 4, (s) => {
      s.setJugX(PLAYFIELD.maxX);
      s.setTilt(1.4);
    });
    expect(sim.result!.captured).toBeLessThan(sim.totalTarget * 0.5);
    expect(sim.result!.stars).toBe(0);
    expect(sim.result!.cleanliness).toBeLessThan(0.5);
  });

  it('judges the run shortly after the player stops pouring', () => {
    const spec = buildLevel(1, 1);
    const sim = new Simulation(spec);
    sim.runHeadless(spec.timeLimit + 4, autoPour());
    expect(sim.phase).toBe('complete');
    expect(sim.result!.timedOut).toBe(false);
    // Well inside the level's own time budget.
    expect(sim.result!.elapsed).toBeLessThan(spec.timeLimit);
  });

  it('does not end the level during a pause mid-pour', () => {
    const spec = buildLevel(1, 1);
    const sim = new Simulation(spec);
    // Pour, pause for a beat, pour again — this must still be one attempt.
    sim.runHeadless(6, (s, time) => s.setTilt(time > 1.2 && time < 2.2 ? 0 : 1.0));
    expect(sim.phase).not.toBe('complete');
    expect(sim.poured).toBeGreaterThan(0);
  });

  it('times out if the player never pours', () => {
    const spec = buildLevel(1, 1);
    const sim = new Simulation(spec);
    // The clock only starts on the first drop, so dribble one out then stall.
    sim.runHeadless(spec.timeLimit + 6, (s, time) => s.setTilt(time < 0.2 ? 1.2 : 0.0));
    expect(sim.phase).toBe('complete');
  });

  it('is deterministic: an identical run gives an identical result', () => {
    const run = () => {
      const sim = play(buildLevel(2, 7));
      return { ...sim.result! };
    };
    expect(run()).toEqual(run());
  });

  it('reaches the same outcome at 60Hz and at 144Hz', () => {
    const spec = buildLevel(1, 4);
    const atRate = (rate: number) => {
      const sim = new Simulation(spec);
      const dt = 1 / rate;
      const controller = autoPour();
      for (let t = 0; t < spec.timeLimit + 4 && !sim.isComplete; t += dt) {
        controller(sim);
        sim.update(dt);
      }
      return sim.result;
    };
    const slow = atRate(60)!;
    const fast = atRate(144)!;
    expect(slow.stars).toBe(fast.stars);
    // The fixed step means the two differ only by the leftover accumulator.
    expect(fast.captured).toBeCloseTo(slow.captured, 3);
  });

  it('emits the events the feedback layer needs', () => {
    const spec = buildLevel(1, 1);
    const sim = new Simulation(spec);
    const seen = new Set<string>();
    const controller = autoPour();
    for (let t = 0; t < spec.timeLimit + 4 && !sim.isComplete; t += 1 / 60) {
      controller(sim);
      for (const event of sim.update(1 / 60)) seen.add(event.type);
    }
    expect(seen.has('pour-start')).toBe(true);
    expect(seen.has('impact')).toBe(true);
    expect(seen.has('pour-stop')).toBe(true);
    expect(seen.has('complete')).toBe(true);
  });
});

describe('aiming', () => {
  it('aims at the mouth of a tilted glass, not its base', () => {
    // A glass leaning hard has its opening well to one side of where it stands.
    const spec = buildLevel(2, 25);
    const sim = new Simulation(spec);
    const tiltedGlass = sim.glasses.find((g) => Math.abs(g.angle) > 0.2);
    expect(tiltedGlass).toBeDefined();
    const index = sim.glasses.indexOf(tiltedGlass!);
    const [left, right] = tiltedGlass!.worldRim();
    const aim = sim.aimTargetFor(index);
    expect(aim).toBeGreaterThan(Math.min(left.x, right.x));
    expect(aim).toBeLessThan(Math.max(left.x, right.x));
  });

  it('finds the clear channel past an obstacle over the mouth', () => {
    // World 4 level 19 has a bar covering one half of the opening.
    const sim = new Simulation(buildLevel(4, 19));
    expect(sim.obstacles.length).toBeGreaterThan(0);
    const mouthY = sim.glasses[0].worldRim()[0].y;
    const aim = sim.aimTargetFor(0);
    // Whatever it picks must not be pointing straight at the obstacle.
    expect(sim.streamClearance(aim, mouthY)).toBeGreaterThan(0);
  });

  it('reports a blocked line of pour as no clearance', () => {
    const sim = new Simulation(buildLevel(4, 19));
    const obstacle = sim.obstacles[0];
    const mouthY = sim.glasses[0].worldRim()[0].y;
    expect(sim.streamClearance(obstacle.position.x, mouthY)).toBeLessThan(0.021);
  });
});

describe('every level is playable', () => {
  const sample: Array<[number, number]> = [
    [1, 1], [1, 12], [1, 25],
    [2, 2], [2, 16], [2, 25],
    [3, 3], [3, 18], [3, 25],
    [4, 4], [4, 20], [4, 25],
    [5, 5], [5, 22], [5, 25],
  ];

  for (const [world, index] of sample) {
    it(`w${world}-l${index} can be won by aiming, metering and stopping`, () => {
      // Two pour rates, as a player would find by feel.
      const attempts = [0.85, 1.2].map((tilt) => play(buildLevel(world, index), autoPour(tilt)));
      const best = attempts.reduce((a, b) => (b.result!.stars > a.result!.stars ? b : a));

      expect(best.phase).toBe('complete');
      for (const glass of best.fill.glasses) {
        expect(glass.volume, `a glass in w${world}-l${index} got nothing`).toBeGreaterThan(0);
      }
      // Passable is a hard requirement: an unwinnable level is a design bug.
      expect(best.result!.stars, `w${world}-l${index} is unwinnable`).toBeGreaterThanOrEqual(1);
      expect(best.result!.captured + best.result!.spilled).toBeCloseTo(best.result!.poured, 5);
    });
  }

  it('every endless stage up to 40 stays winnable', () => {
    for (const stage of [1, 5, 12, 20, 30, 40]) {
      const spec = buildEndlessStage(stage, 777);
      const attempts = [0.9, 1.3].map((tilt) => play(spec, autoPour(tilt)));
      const best = attempts.reduce((a, b) => (b.result!.stars > a.result!.stars ? b : a));
      expect(best.result!.stars, `endless stage ${stage} is unwinnable`).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps particles inside the playfield for a hard endless stage', () => {
    const sim = play(buildEndlessStage(60, 2024));
    for (let i = 0; i < sim.fluid.count; i++) {
      expect(Number.isFinite(sim.fluid.px[i])).toBe(true);
      expect(sim.fluid.py[i]).toBeGreaterThanOrEqual(PLAYFIELD.minY);
      expect(Math.abs(sim.fluid.px[i])).toBeLessThan(PLAYFIELD.maxX * 1.5);
    }
  });
});

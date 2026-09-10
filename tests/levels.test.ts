import { describe, it, expect } from 'vitest';
import {
  WORLDS,
  LEVELS_PER_WORLD,
  WORLD_COUNT,
  TOTAL_LEVELS,
  buildLevel,
  buildWorld,
  buildCampaign,
  unlockedMechanics,
  levelOrdinal,
  levelFromOrdinal,
} from '../src/levels/campaign';
import {
  buildEndlessStage,
  endlessUnlocked,
  escalation,
  startEndlessRun,
  advanceEndlessRun,
  isRunOver,
  ENDLESS_LIVES,
} from '../src/levels/endless';
import { MECHANIC_ORDER, type Mechanic } from '../src/levels/types';
import { FRAME_TOP, PLAYFIELD } from '../src/core/simulation';

describe('campaign structure', () => {
  it('has five worlds of twenty-five levels', () => {
    expect(WORLDS).toHaveLength(WORLD_COUNT);
    expect(buildWorld(1)).toHaveLength(LEVELS_PER_WORLD);
    expect(buildCampaign().flat()).toHaveLength(TOTAL_LEVELS);
  });

  it('introduces the mechanics in the designed order', () => {
    expect(WORLDS.map((w) => w.introduces)).toEqual(MECHANIC_ORDER);
  });

  it('closes every world with a boss that uses every mechanic so far', () => {
    for (let world = 1; world <= WORLD_COUNT; world++) {
      const boss = buildLevel(world, LEVELS_PER_WORLD);
      expect(boss.isBoss).toBe(true);
      for (const mechanic of unlockedMechanics(world)) {
        expect(boss.mechanics).toContain(mechanic);
      }
    }
  });

  it('never uses a mechanic the player has not been taught', () => {
    for (let world = 1; world <= WORLD_COUNT; world++) {
      const allowed = new Set<Mechanic>(unlockedMechanics(world));
      for (let index = 1; index <= LEVELS_PER_WORLD; index++) {
        const level = buildLevel(world, index);
        for (const mechanic of level.mechanics) {
          expect(allowed.has(mechanic), `${level.id} used ${mechanic}`).toBe(true);
        }
        // The mechanic geometry must agree with the declared mechanic list.
        if (!allowed.has('spin')) {
          expect(level.glasses.some((g) => g.spin || g.wobble)).toBe(false);
        }
        if (!allowed.has('obstacle')) expect(level.obstacles).toHaveLength(0);
        if (!allowed.has('multi')) expect(level.glasses).toHaveLength(1);
        if (!allowed.has('tilt')) {
          expect(level.glasses.every((g) => g.angle === 0)).toBe(true);
        }
      }
    }
  });

  it('teaches each new mechanic on its own for the first few levels', () => {
    for (let world = 2; world <= WORLD_COUNT; world++) {
      const introduced = WORLDS[world - 1].introduces;
      for (let index = 1; index <= 4; index++) {
        const level = buildLevel(world, index);
        const extras = level.mechanics.filter((m) => m !== 'still' && m !== introduced);
        expect(extras, `${level.id} piled on ${extras.join()}`).toHaveLength(0);
      }
    }
  });

  it('is deterministic: the same level id always builds the same level', () => {
    expect(buildLevel(3, 12)).toEqual(buildLevel(3, 12));
    expect(buildLevel(3, 12)).not.toEqual(buildLevel(3, 13));
  });

  it('tightens tolerance across the campaign', () => {
    expect(buildLevel(5, 20).tolerance).toBeLessThan(buildLevel(1, 2).tolerance);
    expect(buildLevel(1, 24).tolerance).toBeLessThan(buildLevel(1, 1).tolerance);
  });

  it('keeps every level inside the 15-30 second design window', () => {
    for (const level of buildCampaign().flat()) {
      expect(level.timeLimit).toBeGreaterThanOrEqual(15);
      expect(level.timeLimit).toBeLessThanOrEqual(30);
    }
  });

  it('always asks for a sane fraction of a real glass', () => {
    for (const level of buildCampaign().flat()) {
      expect(level.glasses.length).toBeGreaterThan(0);
      for (const glass of level.glasses) {
        expect(glass.targetFraction).toBeGreaterThan(0.3);
        expect(glass.targetFraction).toBeLessThan(0.95);
        expect(glass.width).toBeGreaterThan(0.1);
        expect(glass.height).toBeGreaterThan(0.15);
      }
      // Enough liquid to finish the job, never an unlimited supply.
      expect(level.jug.chargeFactor!).toBeGreaterThan(1.1);
      expect(level.jug.chargeFactor!).toBeLessThan(2);
    }
  });

  it('keeps every glass and obstacle inside the playfield, travel included', () => {
    for (const level of buildCampaign().flat()) {
      for (const glass of level.glasses) {
        const travel = Math.abs(glass.orbit?.radiusX ?? 0);
        expect(
          Math.abs(glass.x) + travel + glass.width / 2,
          `${level.id} glass leaves the frame`,
        ).toBeLessThanOrEqual(PLAYFIELD.maxX);
        expect(glass.y + glass.height).toBeLessThan(FRAME_TOP);
      }
      for (const obstacle of level.obstacles) {
        const travel = Math.abs(obstacle.orbit?.radiusX ?? 0);
        expect(Math.abs(obstacle.x) + travel + obstacle.length / 2).toBeLessThanOrEqual(
          PLAYFIELD.maxX,
        );
      }
      // The jug has to be reachable and in shot too.
      expect(Math.abs(level.jug.x)).toBeLessThan(PLAYFIELD.maxX);
      expect(level.jug.y).toBeLessThan(FRAME_TOP);
    }
  });

  it('round-trips level ordinals', () => {
    expect(levelOrdinal(1, 1)).toBe(0);
    expect(levelOrdinal(5, 25)).toBe(TOTAL_LEVELS - 1);
    for (const ordinal of [0, 7, 24, 25, 88, TOTAL_LEVELS - 1]) {
      const { world, index } = levelFromOrdinal(ordinal);
      expect(levelOrdinal(world, index)).toBe(ordinal);
    }
  });
});

describe('endless mode', () => {
  it('escalates monotonically without ever saturating', () => {
    let previous = -1;
    for (const stage of [1, 2, 5, 10, 25, 60, 150, 500]) {
      const value = escalation(stage);
      expect(value).toBeGreaterThan(previous);
      expect(value).toBeLessThan(1);
      previous = value;
    }
  });

  it('unlocks mechanics progressively, ending with the full pool', () => {
    expect(endlessUnlocked(1)).toEqual(['still']);
    expect(endlessUnlocked(4)).toContain('tilt');
    expect(endlessUnlocked(4)).not.toContain('spin');
    expect(endlessUnlocked(50).sort()).toEqual([...MECHANIC_ORDER].sort());
  });

  it('never uses a mechanic before its unlock stage', () => {
    for (let stage = 1; stage <= 40; stage++) {
      const allowed = new Set(endlessUnlocked(stage));
      const level = buildEndlessStage(stage, 1234);
      for (const mechanic of level.mechanics) expect(allowed.has(mechanic)).toBe(true);
    }
  });

  it('stacks more mechanics as stages climb', () => {
    const early = buildEndlessStage(4, 99).mechanics.length;
    const late = buildEndlessStage(80, 99).mechanics.length;
    expect(late).toBeGreaterThan(early);
  });

  it('gets stricter and shorter as it goes', () => {
    const early = buildEndlessStage(2, 5);
    const late = buildEndlessStage(90, 5);
    expect(late.tolerance).toBeLessThan(early.tolerance);
    expect(late.timeLimit).toBeLessThan(early.timeLimit);
    expect(late.jug.chargeFactor!).toBeLessThan(early.jug.chargeFactor!);
  });

  it('is deterministic per run seed and differs between runs', () => {
    expect(buildEndlessStage(12, 7)).toEqual(buildEndlessStage(12, 7));
    expect(buildEndlessStage(12, 7)).not.toEqual(buildEndlessStage(12, 8));
  });

  it('stays inside the playfield at extreme stages', () => {
    for (const stage of [1, 20, 100, 400]) {
      const level = buildEndlessStage(stage, 42);
      for (const glass of level.glasses) {
        const travel = Math.abs(glass.orbit?.radiusX ?? 0);
        expect(Math.abs(glass.x) + travel + glass.width / 2).toBeLessThanOrEqual(
          PLAYFIELD.maxX,
        );
        expect(glass.targetFraction).toBeGreaterThan(0.3);
      }
      expect(level.timeLimit).toBeGreaterThanOrEqual(13);
    }
  });

  it('advances on a pass and spends a life on a failure', () => {
    let run = startEndlessRun(1);
    expect(run.lives).toBe(ENDLESS_LIVES);

    run = advanceEndlessRun(run, 500, true, true);
    expect(run.stage).toBe(2);
    expect(run.score).toBe(500);
    expect(run.combo).toBe(1);

    run = advanceEndlessRun(run, 0, false, false);
    expect(run.stage).toBe(2);
    expect(run.lives).toBe(ENDLESS_LIVES - 1);
    expect(run.combo).toBe(0);
  });

  it('breaks the combo on a pass that is not perfect', () => {
    let run = advanceEndlessRun(startEndlessRun(1), 500, true, true);
    run = advanceEndlessRun(run, 400, true, false);
    expect(run.combo).toBe(0);
    expect(run.score).toBe(900);
  });

  it('ends the run when lives run out and remembers the best score', () => {
    let run = startEndlessRun(1);
    run = advanceEndlessRun(run, 900, true, true);
    for (let i = 0; i < ENDLESS_LIVES; i++) run = advanceEndlessRun(run, 0, false, false);
    expect(isRunOver(run)).toBe(true);
    expect(run.best).toBe(900);
  });
});

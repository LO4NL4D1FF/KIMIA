import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  emptySave,
  loadSave,
  recordEndless,
  recordLevel,
  starsInWorld,
  totalStars,
  markHintSeen,
} from '../src/game/save';
import { LEVELS_PER_WORLD, TOTAL_LEVELS, levelOrdinal } from '../src/levels/campaign';

/** A minimal localStorage, since these tests run headless. */
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
  return store;
}

describe('progress', () => {
  beforeEach(() => {
    installStorage();
  });

  it('starts with nothing earned and only the first level open', () => {
    const save = emptySave();
    expect(totalStars(save)).toBe(0);
    expect(save.unlocked).toBe(0);
    expect(save.stars).toHaveLength(TOTAL_LEVELS);
  });

  it('records stars and opens the next level on a pass', () => {
    const save = emptySave();
    const result = recordLevel(save, 1, 1, 2);
    expect(result.improved).toBe(true);
    expect(result.unlockedNext).toBe(true);
    expect(save.stars[levelOrdinal(1, 1)]).toBe(2);
    expect(save.unlocked).toBe(levelOrdinal(1, 2));
  });

  it('keeps the best result and never downgrades it', () => {
    const save = emptySave();
    recordLevel(save, 1, 1, 3);
    recordLevel(save, 1, 1, 1);
    expect(save.stars[levelOrdinal(1, 1)]).toBe(3);
  });

  it('does not open the next level on a failure', () => {
    const save = emptySave();
    const result = recordLevel(save, 1, 1, 0);
    expect(result.unlockedNext).toBe(false);
    expect(save.unlocked).toBe(0);
  });

  it('never walks progress backwards when replaying an old level', () => {
    const save = emptySave();
    recordLevel(save, 1, 1, 1);
    recordLevel(save, 1, 2, 1);
    const before = save.unlocked;
    recordLevel(save, 1, 1, 3);
    expect(save.unlocked).toBe(before);
  });

  it('stops unlocking at the end of the campaign', () => {
    const save = emptySave();
    save.unlocked = TOTAL_LEVELS - 1;
    recordLevel(save, 5, LEVELS_PER_WORLD, 3);
    expect(save.unlocked).toBe(TOTAL_LEVELS - 1);
  });

  it('totals stars per world and overall', () => {
    const save = emptySave();
    recordLevel(save, 1, 1, 3);
    recordLevel(save, 1, 2, 2);
    recordLevel(save, 2, 1, 1);
    expect(starsInWorld(save, 1, LEVELS_PER_WORLD)).toBe(5);
    expect(starsInWorld(save, 2, LEVELS_PER_WORLD)).toBe(1);
    expect(totalStars(save)).toBe(6);
  });

  it('keeps only the best endless score', () => {
    const save = emptySave();
    expect(recordEndless(save, 1200, 8)).toBe(true);
    expect(recordEndless(save, 900, 12)).toBe(false);
    expect(save.endlessBest).toBe(1200);
    // Furthest stage is tracked separately, so a long poor run still counts.
    expect(save.endlessFurthestStage).toBe(12);
  });

  it('shows each hint once', () => {
    const save = emptySave();
    markHintSeen(save, 'w1-l1-hint');
    markHintSeen(save, 'w1-l1-hint');
    expect(save.hintsSeen).toEqual(['w1-l1-hint']);
  });

  it('round-trips through storage', () => {
    const save = emptySave();
    recordLevel(save, 2, 3, 2);
    recordEndless(save, 4321, 20);
    const loaded = loadSave();
    expect(loaded.stars[levelOrdinal(2, 3)]).toBe(2);
    expect(loaded.endlessBest).toBe(4321);
  });

  it('survives corrupt or truncated saved data', () => {
    installStorage({ 'pour-it.save.v1': '{"stars":[9,"x",-4],"unlocked":' });
    const loaded = loadSave();
    expect(loaded.stars).toHaveLength(TOTAL_LEVELS);
    expect(totalStars(loaded)).toBe(0);
  });

  it('clamps nonsense star counts from an edited save', () => {
    installStorage({
      'pour-it.save.v1': JSON.stringify({ stars: [9, -3, 2], unlocked: 5 }),
    });
    const loaded = loadSave();
    expect(loaded.stars[0]).toBe(3);
    expect(loaded.stars[1]).toBe(0);
    expect(loaded.stars[2]).toBe(2);
  });

  it('keeps playing when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const loaded = loadSave();
    expect(loaded.stars).toHaveLength(TOTAL_LEVELS);
    expect(() => recordLevel(loaded, 1, 1, 3)).not.toThrow();
  });
});

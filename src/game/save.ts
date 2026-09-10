import { TOTAL_LEVELS, levelOrdinal } from '../levels/campaign';

/**
 * Progress, in localStorage.
 *
 * Stars never gate progress — the concept is explicit that completionists get a
 * reason to replay without anyone being walled out — so the only thing unlocked
 * by play is the next level.
 */
export interface SaveData {
  version: 1;
  /** Stars earned per level, indexed by flat ordinal. 0 = not yet cleared. */
  stars: number[];
  /** Highest level ordinal the player may enter. */
  unlocked: number;
  endlessBest: number;
  endlessFurthestStage: number;
  soundOn: boolean;
  hapticsOn: boolean;
  /** Hints already shown, so they appear once each. */
  hintsSeen: string[];
}

const KEY = 'pour-it.save.v1';

export function emptySave(): SaveData {
  return {
    version: 1,
    stars: new Array<number>(TOTAL_LEVELS).fill(0),
    unlocked: 0,
    endlessBest: 0,
    endlessFurthestStage: 0,
    soundOn: true,
    hapticsOn: true,
    hintsSeen: [],
  };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptySave();
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    const base = emptySave();
    const stars = Array.isArray(parsed.stars) ? parsed.stars : base.stars;
    return {
      ...base,
      ...parsed,
      version: 1,
      // Never trust stored length: the campaign may have grown since.
      stars: base.stars.map((_, i) => Math.max(0, Math.min(3, Number(stars[i]) || 0))),
      hintsSeen: Array.isArray(parsed.hintsSeen) ? parsed.hintsSeen : [],
    };
  } catch {
    return emptySave();
  }
}

export function persist(save: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    // Private browsing, or storage disabled. The game still plays.
  }
}

/** Record a finished level. Returns whether this beat the previous best. */
export function recordLevel(
  save: SaveData,
  world: number,
  index: number,
  stars: number,
): { improved: boolean; unlockedNext: boolean } {
  const ordinal = levelOrdinal(world, index);
  const previous = save.stars[ordinal] ?? 0;
  const improved = stars > previous;
  if (improved) save.stars[ordinal] = stars;

  let unlockedNext = false;
  if (stars > 0 && save.unlocked <= ordinal && ordinal + 1 < TOTAL_LEVELS) {
    save.unlocked = ordinal + 1;
    unlockedNext = true;
  }
  persist(save);
  return { improved, unlockedNext };
}

export function recordEndless(save: SaveData, score: number, stage: number): boolean {
  const improved = score > save.endlessBest;
  save.endlessBest = Math.max(save.endlessBest, score);
  save.endlessFurthestStage = Math.max(save.endlessFurthestStage, stage);
  persist(save);
  return improved;
}

export function starsInWorld(save: SaveData, world: number, levelsPerWorld: number): number {
  let total = 0;
  for (let i = 1; i <= levelsPerWorld; i++) {
    total += save.stars[levelOrdinal(world, i)] ?? 0;
  }
  return total;
}

export function totalStars(save: SaveData): number {
  return save.stars.reduce((sum, s) => sum + s, 0);
}

export function markHintSeen(save: SaveData, id: string): void {
  if (!save.hintsSeen.includes(id)) {
    save.hintsSeen.push(id);
    persist(save);
  }
}

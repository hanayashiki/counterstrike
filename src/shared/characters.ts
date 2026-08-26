/**
 * Playable character models.
 *
 * These are purely cosmetic. Every character is simulated with the identical
 * `PLAYER_RADIUS` / `PLAYER_HEIGHT` hull, so which one you pick changes nothing
 * about how easy you are to hit — a silhouette that was narrower than the hull
 * would be an unearned advantage, and one that was wider would be a penalty.
 * `tests/characters.test.ts` enforces that.
 *
 * All measurements are in metres and describe a standing 1.8 m figure.
 */

export type Build = 'heavy' | 'athletic';
export type Hair = 'none' | 'ponytail' | 'bun';

export interface CharacterDef {
  readonly id: number;
  readonly name: string;
  readonly build: Build;
  /** Shoulder plate span — the strongest silhouette cue at distance. */
  readonly shoulderWidth: number;
  readonly chestWidth: number;
  readonly chestDepth: number;
  /** Narrower than the chest on athletic builds, giving a waisted profile. */
  readonly waistWidth: number;
  readonly hipWidth: number;
  readonly headWidth: number;
  readonly armWidth: number;
  readonly legWidth: number;
  /** Horizontal offset of each leg from centre. */
  readonly legSpacing: number;
  readonly hair: Hair;
}

export const CHARACTERS: readonly CharacterDef[] = [
  {
    id: 0,
    name: 'Bulwark',
    build: 'heavy',
    shoulderWidth: 0.5,
    chestWidth: 0.46,
    chestDepth: 0.28,
    waistWidth: 0.44,
    hipWidth: 0.4,
    headWidth: 0.25,
    armWidth: 0.12,
    legWidth: 0.17,
    legSpacing: 0.13,
    hair: 'none',
  },
  {
    id: 1,
    name: 'Kite',
    build: 'athletic',
    shoulderWidth: 0.42,
    chestWidth: 0.37,
    chestDepth: 0.23,
    waistWidth: 0.29,
    hipWidth: 0.36,
    headWidth: 0.225,
    armWidth: 0.1,
    legWidth: 0.145,
    legSpacing: 0.105,
    hair: 'ponytail',
  },
  {
    id: 2,
    name: 'Wren',
    build: 'athletic',
    shoulderWidth: 0.41,
    chestWidth: 0.36,
    chestDepth: 0.225,
    waistWidth: 0.285,
    hipWidth: 0.355,
    headWidth: 0.222,
    armWidth: 0.098,
    legWidth: 0.142,
    legSpacing: 0.1,
    hair: 'bun',
  },
];

export const CHARACTER_COUNT = CHARACTERS.length;

export function getCharacter(id: number): CharacterDef {
  return CHARACTERS[id] ?? (CHARACTERS[0] as CharacterDef);
}

/** Stable pick for anyone who never chose one, so a bot keeps its look. */
export const characterForId = (id: number): number => id % CHARACTER_COUNT;

/** Widest point of a model, used to prove it stays inside the collision hull. */
export function widestPoint(c: CharacterDef): number {
  return Math.max(c.shoulderWidth, c.chestWidth, c.hipWidth, c.legSpacing * 2 + c.legWidth);
}

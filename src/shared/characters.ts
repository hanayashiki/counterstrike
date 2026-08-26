/**
 * Playable character models, described anatomically.
 *
 * Every measurement is in metres for a standing 1.8 m figure, taken from real
 * human landmark proportions: crotch at roughly 48% of height, knee at 27%,
 * shoulder at 82%, and a head about 1/7.8 of total height. Building to those
 * numbers is what makes a figure read as a person rather than a stack of boxes.
 *
 * The models are cosmetic. Everyone is simulated with the identical
 * `PLAYER_RADIUS` / `PLAYER_HEIGHT` hull, so a build cannot make you harder to
 * hit — including height, which is why all three stand 1.8 m rather than
 * varying the way real people do. `tests/characters.test.ts` enforces it.
 *
 * The strongest silhouette cue between builds is the shoulder-to-hip ratio: a
 * heavy build is widest at the shoulder, an athletic one is close to even.
 */

export type Build = 'heavy' | 'athletic';
export type Hair = 'crop' | 'ponytail' | 'bun';
/** Worn kit, which changes the outline as much as the body underneath does. */
export type Gear = 'plate' | 'vest' | 'jacket';

export interface CharacterDef {
  readonly id: number;
  readonly name: string;
  readonly build: Build;

  // Vertical landmarks, measured from the feet.
  readonly hipHeight: number;
  readonly kneeHeight: number;
  readonly waistHeight: number;
  readonly shoulderHeight: number;
  readonly neckHeight: number;

  // Girths. Width is across the body, depth is front to back.
  readonly shoulderSpan: number;
  readonly chestWidth: number;
  readonly chestDepth: number;
  readonly waistWidth: number;
  readonly waistDepth: number;
  readonly hipWidth: number;
  readonly hipDepth: number;

  // Limb radii.
  readonly upperArmRadius: number;
  readonly forearmRadius: number;
  readonly thighRadius: number;
  readonly calfRadius: number;
  readonly neckRadius: number;
  readonly headRadius: number;

  /** Bust projection forward of the ribcage. 0 on a male build. */
  readonly bust: number;
  /** Deltoid cap radius: the round mass that actually reads as a shoulder. */
  readonly deltoidRadius: number;

  readonly hair: Hair;
  readonly gear: Gear;

  /**
   * Rigged model to draw instead of the procedural figure. Optional: a
   * character without one, or whose asset fails to load, falls back to
   * `buildFigure`, so the game still runs with no art assets present.
   */
  readonly modelUrl?: string;
}

export const CHARACTERS: readonly CharacterDef[] = [
  {
    id: 0,
    name: 'Bulwark',
    build: 'heavy',
    hipHeight: 0.88,
    kneeHeight: 0.49,
    waistHeight: 1.08,
    shoulderHeight: 1.47,
    neckHeight: 1.53,
    // Broad at the shoulder, narrow at the hip: the classic male outline.
    shoulderSpan: 0.46,
    chestWidth: 0.35,
    chestDepth: 0.245,
    waistWidth: 0.32,
    waistDepth: 0.22,
    hipWidth: 0.34,
    hipDepth: 0.23,
    upperArmRadius: 0.058,
    forearmRadius: 0.05,
    thighRadius: 0.085,
    calfRadius: 0.062,
    neckRadius: 0.058,
    headRadius: 0.113,
    bust: 0,
    deltoidRadius: 0.075,
    hair: 'crop',
    gear: 'plate',
    modelUrl: '/models/Male.glb',
  },
  {
    id: 1,
    name: 'Kite',
    build: 'athletic',
    hipHeight: 0.9,
    kneeHeight: 0.5,
    waistHeight: 1.09,
    shoulderHeight: 1.45,
    neckHeight: 1.52,
    // Shoulders and hips near even, with a markedly narrower waist between.
    shoulderSpan: 0.385,
    chestWidth: 0.3,
    chestDepth: 0.215,
    waistWidth: 0.25,
    waistDepth: 0.185,
    hipWidth: 0.355,
    hipDepth: 0.225,
    upperArmRadius: 0.046,
    forearmRadius: 0.039,
    thighRadius: 0.077,
    calfRadius: 0.054,
    neckRadius: 0.047,
    headRadius: 0.109,
    bust: 0.058,
    deltoidRadius: 0.058,
    hair: 'ponytail',
    gear: 'vest',
    modelUrl: '/models/Female.glb',
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
  return Math.max(c.shoulderSpan, c.chestWidth, c.hipWidth);
}

/**
 * Vertical stretch applied to the skull sphere when the figure is built. Lives
 * here rather than in the renderer so the proportion tests measure the head the
 * viewer actually sees.
 */
export const SKULL_Y_SCALE = 1.06;

/** Chin-to-crown height, the unit figure drawing measures a body in. */
export const headHeight = (c: CharacterDef): number => c.headRadius * 2 * SKULL_Y_SCALE;

/** Shoulder-to-hip ratio: above 1.2 reads as a heavy build, near 1.1 as lean. */
export const shoulderHipRatio = (c: CharacterDef): number => c.shoulderSpan / c.hipWidth;

/** Every distinct rigged model referenced by a character, for preloading. */
export const MODEL_URLS: readonly string[] = [
  ...new Set(CHARACTERS.map((c) => c.modelUrl).filter((url): url is string => !!url)),
];

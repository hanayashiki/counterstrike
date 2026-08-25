/**
 * Tuning constants shared by the authoritative server and the predicting client.
 * Anything in here MUST stay identical on both sides or prediction will diverge.
 */

/** Simulation ticks per second. The server steps the world at this rate. */
export const TICK_RATE = 64;
export const TICK_DT = 1 / TICK_RATE;

/** Snapshots per second sent to each client. */
export const SNAPSHOT_RATE = 32;

/** Client input sends per second. */
export const INPUT_RATE = 64;

/** How long the server keeps historical positions around for lag compensation. */
export const LAG_COMP_HISTORY_MS = 1000;
/** Hard cap on how far back a client may rewind the world (anti-cheat sanity). */
export const MAX_REWIND_MS = 250;

/** Client renders other players this far in the past, to interpolate smoothly. */
export const INTERP_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// Player physics
// ---------------------------------------------------------------------------

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_CROUCH_HEIGHT = 1.15;
export const EYE_OFFSET = 0.15; // eye sits this far below the top of the hull
export const HEAD_HEIGHT = 0.28; // top slice of the hull counts as a headshot

export const GRAVITY = 22;
export const JUMP_SPEED = 7.2;

export const MAX_GROUND_SPEED = 7.4;
export const MAX_CROUCH_SPEED = 3.4;
export const MAX_AIR_WISH_SPEED = 1.2; // classic air-control cap
export const GROUND_ACCEL = 85;
export const AIR_ACCEL = 60;
export const GROUND_FRICTION = 8.5;
export const STOP_SPEED = 1.2;
export const STEP_HEIGHT = 0.45;

/** Speed below which the movement inaccuracy penalty disappears entirely. */
export const ACCURATE_MOVE_SPEED = 1.6;

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

export const MAX_HEALTH = 100;
export const START_ARMOR = 50;
/** Fraction of incoming damage absorbed while armor remains. */
export const ARMOR_ABSORB = 0.45;

export const RESPAWN_DELAY_MS = 3000;
export const SPAWN_PROTECTION_MS = 1200;
export const FALL_DAMAGE_THRESHOLD = 14; // m/s of downward speed before it hurts
export const FALL_DAMAGE_PER_MS = 9;

// ---------------------------------------------------------------------------
// Match flow
// ---------------------------------------------------------------------------

export const WARMUP_MS = 5000;
export const ROUND_MS = 5 * 60 * 1000;
export const ROUND_END_MS = 6000;
export const SCORE_LIMIT = 50;

export const MAX_PLAYERS = 16;
/** Match fills up to this headcount with bots. */
export const TARGET_PLAYERS = 10;

export const DEFAULT_PORT = 8787;

// ---------------------------------------------------------------------------
// Input button bitmask
// ---------------------------------------------------------------------------

export const BTN_FORWARD = 1 << 0;
export const BTN_BACK = 1 << 1;
export const BTN_LEFT = 1 << 2;
export const BTN_RIGHT = 1 << 3;
export const BTN_JUMP = 1 << 4;
export const BTN_CROUCH = 1 << 5;
export const BTN_ATTACK = 1 << 6;
export const BTN_RELOAD = 1 << 7;
export const BTN_WALK = 1 << 8;
export const BTN_ADS = 1 << 9;

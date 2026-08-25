/**
 * Axis-aligned world collision. The map is a soup of AABB brushes, and players
 * are AABB hulls whose origin sits at their feet. Everything here is
 * deterministic and shared, so the client can predict exactly what the server
 * will compute.
 */
import { PLAYER_RADIUS, STEP_HEIGHT } from './config';
import { type Vec3, set } from './math';

const EPSILON = 1e-3;

export interface Brush {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface RayHit {
  /** Distance along the ray to the impact point. */
  t: number;
  nx: number;
  ny: number;
  nz: number;
  brush: Brush | null;
}

export const makeBrush = (
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): Brush => ({ minX, minY, minZ, maxX, maxY, maxZ });

/** Build a brush from a center point and full-size extents. */
export function brushFromBox(center: Vec3, size: Vec3): Brush {
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;
  return makeBrush(
    center.x - hx,
    center.y - hy,
    center.z - hz,
    center.x + hx,
    center.y + hy,
    center.z + hz,
  );
}

// ---------------------------------------------------------------------------
// Overlap tests
// ---------------------------------------------------------------------------

export function hullOverlapsBrush(
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
  b: Brush,
): boolean {
  return (
    x + radius > b.minX &&
    x - radius < b.maxX &&
    y + height > b.minY &&
    y < b.maxY &&
    z + radius > b.minZ &&
    z - radius < b.maxZ
  );
}

export function hullOverlapsWorld(
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
  brushes: readonly Brush[],
): boolean {
  for (const b of brushes) {
    if (hullOverlapsBrush(x, y, z, radius, height, b)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Raycasting
// ---------------------------------------------------------------------------

/**
 * Slab-method ray/AABB intersection.
 * Returns the entry distance, or -1 when the ray misses within `maxT`.
 * Writes the surface normal into `out` when it hits.
 */
export function rayVsBrush(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  b: Brush,
  maxT: number,
  out: RayHit,
): number {
  let tMin = 0;
  let tMax = maxT;
  let axis = -1;
  let sign = 1;

  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (ox < b.minX || ox > b.maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (b.minX - ox) * inv;
    let t2 = (b.maxX - ox) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = 0;
      sign = s;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (oy < b.minY || oy > b.maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (b.minY - oy) * inv;
    let t2 = (b.maxY - oy) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = 1;
      sign = s;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (oz < b.minZ || oz > b.maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (b.minZ - oz) * inv;
    let t2 = (b.maxZ - oz) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = 2;
      sign = s;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  out.nx = axis === 0 ? sign : 0;
  out.ny = axis === 1 ? sign : 0;
  out.nz = axis === 2 ? sign : 0;
  return tMin;
}

const scratchHit: RayHit = { t: 0, nx: 0, ny: 0, nz: 0, brush: null };

/** Nearest world hit along a ray. `dir` must be normalized. */
export function raycastWorld(
  brushes: readonly Brush[],
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  out: RayHit,
): boolean {
  let best = maxDist;
  let found = false;
  for (const b of brushes) {
    const t = rayVsBrush(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, b, best, scratchHit);
    if (t >= 0 && t < best) {
      best = t;
      found = true;
      out.t = t;
      out.nx = scratchHit.nx;
      out.ny = scratchHit.ny;
      out.nz = scratchHit.nz;
      out.brush = b;
    }
  }
  return found;
}

/** True when nothing solid sits between the two points. */
export function hasLineOfSight(brushes: readonly Brush[], from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  const inv = 1 / dist;
  for (const b of brushes) {
    const t = rayVsBrush(
      from.x,
      from.y,
      from.z,
      dx * inv,
      dy * inv,
      dz * inv,
      b,
      dist - 1e-4,
      scratchHit,
    );
    if (t >= 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Player movement collision
// ---------------------------------------------------------------------------

export interface MoveResult {
  onGround: boolean;
  hitWall: boolean;
  hitCeiling: boolean;
  /** Downward speed at the moment of landing, for fall damage. */
  landingSpeed: number;
}

function resolveAxisX(
  pos: Vec3,
  radius: number,
  height: number,
  brushes: readonly Brush[],
  dir: number,
): boolean {
  if (dir === 0) return false;
  let target = pos.x;
  let hit = false;
  for (const b of brushes) {
    if (!hullOverlapsBrush(pos.x, pos.y, pos.z, radius, height, b)) continue;
    hit = true;
    target =
      dir > 0
        ? Math.min(target, b.minX - radius - EPSILON)
        : Math.max(target, b.maxX + radius + EPSILON);
  }
  if (hit) pos.x = target;
  return hit;
}

function resolveAxisZ(
  pos: Vec3,
  radius: number,
  height: number,
  brushes: readonly Brush[],
  dir: number,
): boolean {
  if (dir === 0) return false;
  let target = pos.z;
  let hit = false;
  for (const b of brushes) {
    if (!hullOverlapsBrush(pos.x, pos.y, pos.z, radius, height, b)) continue;
    hit = true;
    target =
      dir > 0
        ? Math.min(target, b.minZ - radius - EPSILON)
        : Math.max(target, b.maxZ + radius + EPSILON);
  }
  if (hit) pos.z = target;
  return hit;
}

/** Returns 1 when the hull landed on something, -1 when it hit a ceiling, 0 otherwise. */
function resolveAxisY(
  pos: Vec3,
  radius: number,
  height: number,
  brushes: readonly Brush[],
  dir: number,
): number {
  let result = 0;
  let target = pos.y;
  for (const b of brushes) {
    if (!hullOverlapsBrush(pos.x, pos.y, pos.z, radius, height, b)) continue;
    if (dir > 0) {
      target = Math.min(target, b.minY - height - EPSILON);
      result = -1;
    } else {
      target = Math.max(target, b.maxY + EPSILON);
      result = 1;
    }
  }
  if (result !== 0) pos.y = target;
  return result;
}

/**
 * Is the hull resting on (or a hair above) solid ground? Only the footprint
 * matters here, so the hull height is irrelevant.
 */
export function isGrounded(pos: Vec3, radius: number, brushes: readonly Brush[]): boolean {
  return hullOverlapsWorld(pos.x, pos.y - 0.06, pos.z, radius, 0.05, brushes);
}

const stepStart: Vec3 = { x: 0, y: 0, z: 0 };
const stepTry: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Collision here resolves overlap at the destination rather than sweeping, so a
 * single step must never travel further than the thinnest brush. Anything
 * longer is split into sub-steps.
 */
const MAX_SUBSTEP_DISTANCE = 0.35;
const MAX_SUBSTEPS = 16;

/**
 * Integrate `pos` by `vel * dt` against the world, sliding along surfaces and
 * stepping up small ledges. Mutates both `pos` and `vel`.
 *
 * Sub-steps automatically when the displacement is large (a long frame, or a
 * player at terminal velocity), so nothing can tunnel through the floor.
 */
export function moveAndSlide(
  pos: Vec3,
  vel: Vec3,
  radius: number,
  height: number,
  brushes: readonly Brush[],
  dt: number,
  out: MoveResult,
): MoveResult {
  const fastestAxis = Math.max(Math.abs(vel.x), Math.abs(vel.y), Math.abs(vel.z));
  const travel = fastestAxis * dt;
  const substeps =
    travel > MAX_SUBSTEP_DISTANCE
      ? Math.min(MAX_SUBSTEPS, Math.ceil(travel / MAX_SUBSTEP_DISTANCE))
      : 1;

  if (substeps === 1) return integrate(pos, vel, radius, height, brushes, dt, out);

  const sub = dt / substeps;
  let hitWall = false;
  let hitCeiling = false;
  let landingSpeed = 0;
  for (let i = 0; i < substeps; i++) {
    integrate(pos, vel, radius, height, brushes, sub, out);
    hitWall = hitWall || out.hitWall;
    hitCeiling = hitCeiling || out.hitCeiling;
    landingSpeed = Math.max(landingSpeed, out.landingSpeed);
  }
  // `onGround` is whatever the final sub-step concluded; the rest are sticky.
  out.hitWall = hitWall;
  out.hitCeiling = hitCeiling;
  out.landingSpeed = landingSpeed;
  return out;
}

function integrate(
  pos: Vec3,
  vel: Vec3,
  radius: number,
  height: number,
  brushes: readonly Brush[],
  dt: number,
  out: MoveResult,
): MoveResult {
  out.hitWall = false;
  out.hitCeiling = false;
  out.landingSpeed = 0;

  const wasGrounded = isGrounded(pos, radius, brushes);
  set(stepStart, pos.x, pos.y, pos.z);

  const dx = vel.x * dt;
  const dz = vel.z * dt;

  pos.x += dx;
  const blockedX = resolveAxisX(pos, radius, height, brushes, Math.sign(dx));
  pos.z += dz;
  const blockedZ = resolveAxisZ(pos, radius, height, brushes, Math.sign(dz));

  // Try to step up over a low obstacle rather than grinding to a halt on it.
  if ((blockedX || blockedZ) && wasGrounded) {
    set(stepTry, stepStart.x, stepStart.y + STEP_HEIGHT, stepStart.z);
    if (!hullOverlapsWorld(stepTry.x, stepTry.y, stepTry.z, radius, height, brushes)) {
      stepTry.x += dx;
      resolveAxisX(stepTry, radius, height, brushes, Math.sign(dx));
      stepTry.z += dz;
      resolveAxisZ(stepTry, radius, height, brushes, Math.sign(dz));

      // Drop back down onto whatever we stepped onto.
      const beforeDrop = stepTry.y;
      stepTry.y -= STEP_HEIGHT + EPSILON;
      resolveAxisY(stepTry, radius, height, brushes, -1);
      const climbed = stepTry.y - stepStart.y;

      const gainedGround =
        Math.hypot(stepTry.x - stepStart.x, stepTry.z - stepStart.z) >
        Math.hypot(pos.x - stepStart.x, pos.z - stepStart.z) + 1e-4;

      if (gainedGround && climbed <= STEP_HEIGHT + EPSILON && stepTry.y <= beforeDrop) {
        pos.x = stepTry.x;
        pos.y = stepTry.y;
        pos.z = stepTry.z;
      }
    }
  }

  if (blockedX) vel.x = 0;
  if (blockedZ) vel.z = 0;
  out.hitWall = blockedX || blockedZ;

  pos.y += vel.y * dt;
  const vertical = resolveAxisY(pos, radius, height, brushes, Math.sign(vel.y));
  if (vertical === 1) {
    out.landingSpeed = -vel.y;
    vel.y = 0;
  } else if (vertical === -1) {
    out.hitCeiling = true;
    vel.y = 0;
  }

  out.onGround = vertical === 1 || (vel.y <= 0 && isGrounded(pos, radius, brushes));
  return out;
}

/** Convenience for the default player hull. */
export const playerRadius = PLAYER_RADIUS;

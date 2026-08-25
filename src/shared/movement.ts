import {
  type Brush,
  type MoveResult,
  hullOverlapsWorld,
  isGrounded,
  moveAndSlide,
} from './collision';
/**
 * Quake-style player movement. This exact function runs on the server (as the
 * authority) and on the client (as prediction), so it must be deterministic:
 * no wall-clock reads, no unseeded randomness, and dt is always an integer
 * number of milliseconds.
 */
import {
  AIR_ACCEL,
  BTN_ADS,
  BTN_CROUCH,
  BTN_JUMP,
  BTN_WALK,
  EYE_OFFSET,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  JUMP_SPEED,
  MAX_AIR_WISH_SPEED,
  MAX_CROUCH_SPEED,
  MAX_GROUND_SPEED,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STOP_SPEED,
} from './config';
import type { Vec3 } from './math';

export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  crouching: boolean;
  /** Current hull height; interpolates between standing and crouching. */
  height: number;
}

export interface MoveInput {
  buttons: number;
  yaw: number;
  pitch: number;
  /** Strafe axis, -1..1 (positive is right). */
  moveX: number;
  /** Forward axis, -1..1 (positive is forward). */
  moveZ: number;
}

export const WALK_SPEED_SCALE = 0.52;
export const ADS_SPEED_SCALE = 0.62;
const CROUCH_TRANSITION_PER_SEC = 6;

export const eyeHeight = (state: MoveState): number => state.height - EYE_OFFSET;
export const eyeY = (state: MoveState): number => state.pos.y + state.height - EYE_OFFSET;

function applyFriction(vel: Vec3, dt: number): void {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 1e-4) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const control = Math.max(speed, STOP_SPEED);
  const newSpeed = Math.max(0, speed - control * GROUND_FRICTION * dt);
  const k = newSpeed / speed;
  vel.x *= k;
  vel.z *= k;
}

function accelerate(
  vel: Vec3,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
  dt: number,
): void {
  const currentSpeed = vel.x * wishX + vel.z * wishZ;
  const addSpeed = wishSpeed - currentSpeed;
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed);
  vel.x += accelSpeed * wishX;
  vel.z += accelSpeed * wishZ;
}

/** Can the player stand up here without clipping into the ceiling? */
export function canStand(pos: Vec3, brushes: readonly Brush[]): boolean {
  return !hullOverlapsWorld(pos.x, pos.y, pos.z, PLAYER_RADIUS, PLAYER_HEIGHT, brushes);
}

/**
 * Advance one movement tick. Mutates `state` and fills `out`.
 * `speedScale` folds in the equipped weapon's movement multiplier.
 */
export function stepMovement(
  state: MoveState,
  input: MoveInput,
  brushes: readonly Brush[],
  dt: number,
  speedScale: number,
  out: MoveResult,
): MoveResult {
  state.yaw = input.yaw;
  state.pitch = input.pitch;

  const wantsCrouch = (input.buttons & BTN_CROUCH) !== 0;
  state.crouching = wantsCrouch || !canStand(state.pos, brushes);

  const targetHeight = state.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
  const heightStep = (PLAYER_HEIGHT - PLAYER_CROUCH_HEIGHT) * CROUCH_TRANSITION_PER_SEC * dt;
  if (state.height < targetHeight) state.height = Math.min(targetHeight, state.height + heightStep);
  else if (state.height > targetHeight)
    state.height = Math.max(targetHeight, state.height - heightStep);

  state.onGround = isGrounded(state.pos, PLAYER_RADIUS, brushes) && state.vel.y <= 0.1;

  // Build the wish direction in world space from the yaw-relative input axes.
  const sinYaw = Math.sin(state.yaw);
  const cosYaw = Math.cos(state.yaw);
  // Forward is (-sin, -cos); right is (-cos, sin) in the (x, z) plane.
  let wishX = input.moveZ * -sinYaw + input.moveX * cosYaw;
  let wishZ = input.moveZ * -cosYaw - input.moveX * sinYaw;
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1e-5) {
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  let maxSpeed = state.crouching ? MAX_CROUCH_SPEED : MAX_GROUND_SPEED;
  maxSpeed *= speedScale;
  if ((input.buttons & BTN_WALK) !== 0) maxSpeed *= WALK_SPEED_SCALE;
  if ((input.buttons & BTN_ADS) !== 0) maxSpeed *= ADS_SPEED_SCALE;
  const wishSpeed = Math.min(wishLen, 1) * maxSpeed;

  if (state.onGround) {
    applyFriction(state.vel, dt);
    accelerate(state.vel, wishX, wishZ, wishSpeed, GROUND_ACCEL, dt);

    if ((input.buttons & BTN_JUMP) !== 0) {
      state.vel.y = JUMP_SPEED;
      state.onGround = false;
    } else {
      state.vel.y = Math.min(state.vel.y, 0);
    }
  } else {
    accelerate(state.vel, wishX, wishZ, Math.min(wishSpeed, MAX_AIR_WISH_SPEED), AIR_ACCEL, dt);
  }

  state.vel.y -= GRAVITY * dt;
  if (state.vel.y < -60) state.vel.y = -60;

  moveAndSlide(state.pos, state.vel, PLAYER_RADIUS, state.height, brushes, dt, out);
  state.onGround = out.onGround;
  return out;
}

/** Horizontal speed, used for movement inaccuracy. */
export const horizontalSpeed = (state: MoveState): number => Math.hypot(state.vel.x, state.vel.z);

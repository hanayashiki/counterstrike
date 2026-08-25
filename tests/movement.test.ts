import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type MoveResult, makeBrush } from '../src/shared/collision';
import {
  BTN_CROUCH,
  BTN_JUMP,
  BTN_WALK,
  MAX_AIR_WISH_SPEED,
  MAX_CROUCH_SPEED,
  MAX_GROUND_SPEED,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
} from '../src/shared/config';
import { vec3 } from '../src/shared/math';
import { type MoveInput, type MoveState, canStand, stepMovement } from '../src/shared/movement';

const floor = [makeBrush(-60, -2, -60, 60, 0, 60)];
const DT = 1 / 64;

const freshState = (): MoveState => ({
  pos: vec3(0, 0, 0),
  vel: vec3(),
  yaw: 0,
  pitch: 0,
  onGround: true,
  crouching: false,
  height: PLAYER_HEIGHT,
});

const input = (over: Partial<MoveInput> = {}): MoveInput => ({
  buttons: 0,
  yaw: 0,
  pitch: 0,
  moveX: 0,
  moveZ: 0,
  ...over,
});

const out = (): MoveResult => ({
  onGround: false,
  hitWall: false,
  hitCeiling: false,
  landingSpeed: 0,
});

function run(state: MoveState, cmd: MoveInput, ticks: number, scale = 1): void {
  const result = out();
  for (let i = 0; i < ticks; i++) stepMovement(state, cmd, floor, DT, scale, result);
}

test('yaw = 0 moves the player along -Z', () => {
  const state = freshState();
  run(state, input({ moveZ: 1 }), 64);
  assert.ok(state.pos.z < -3, `expected to run toward -Z, got z=${state.pos.z}`);
  assert.ok(Math.abs(state.pos.x) < 0.001, `should not drift on x, got ${state.pos.x}`);
});

test('strafing right at yaw = 0 moves along +X', () => {
  const state = freshState();
  run(state, input({ moveX: 1 }), 64);
  assert.ok(state.pos.x > 3, `expected to strafe toward +X, got x=${state.pos.x}`);
});

test('a quarter turn rotates the movement frame', () => {
  const state = freshState();
  run(state, input({ moveZ: 1, yaw: Math.PI / 2 }), 64);
  // yaw = +90 degrees points forward down -X.
  assert.ok(state.pos.x < -3, `expected forward to become -X, got x=${state.pos.x}`);
  assert.ok(Math.abs(state.pos.z) < 0.001);
});

test('ground speed converges on the configured maximum', () => {
  const state = freshState();
  run(state, input({ moveZ: 1 }), 128);
  const speed = Math.hypot(state.vel.x, state.vel.z);
  assert.ok(speed <= MAX_GROUND_SPEED + 0.01, `speed ${speed} exceeded the cap`);
  assert.ok(speed > MAX_GROUND_SPEED - 0.2, `speed ${speed} never reached the cap`);
});

test('diagonal input is normalized, so it is not faster', () => {
  const straight = freshState();
  run(straight, input({ moveZ: 1 }), 128);
  const diagonal = freshState();
  run(diagonal, input({ moveZ: 1, moveX: 1 }), 128);

  const straightSpeed = Math.hypot(straight.vel.x, straight.vel.z);
  const diagonalSpeed = Math.hypot(diagonal.vel.x, diagonal.vel.z);
  assert.ok(
    Math.abs(diagonalSpeed - straightSpeed) < 0.05,
    `diagonal ${diagonalSpeed} vs straight ${straightSpeed}`,
  );
});

test('walking and crouching both slow the player down', () => {
  const walking = freshState();
  run(walking, input({ moveZ: 1, buttons: BTN_WALK }), 128);
  assert.ok(Math.hypot(walking.vel.x, walking.vel.z) < MAX_GROUND_SPEED * 0.6);

  const crouching = freshState();
  run(crouching, input({ moveZ: 1, buttons: BTN_CROUCH }), 128);
  assert.ok(Math.hypot(crouching.vel.x, crouching.vel.z) <= MAX_CROUCH_SPEED + 0.01);
  assert.equal(crouching.crouching, true);
  assert.ok(crouching.height < PLAYER_HEIGHT);
});

test('the weapon speed multiplier scales top speed', () => {
  const slow = freshState();
  run(slow, input({ moveZ: 1 }), 128, 0.5);
  assert.ok(Math.hypot(slow.vel.x, slow.vel.z) < MAX_GROUND_SPEED * 0.55);
});

test('friction brings a released player to a stop', () => {
  const state = freshState();
  run(state, input({ moveZ: 1 }), 64);
  run(state, input(), 128);
  assert.ok(Math.hypot(state.vel.x, state.vel.z) < 0.01, 'should have come to rest');
});

test('jumping leaves the ground and gravity brings it back', () => {
  const state = freshState();
  const result = out();
  stepMovement(state, input({ buttons: BTN_JUMP }), floor, DT, 1, result);
  assert.ok(state.vel.y > 0, 'jump should impart upward velocity');
  assert.equal(state.onGround, false);

  let peak = 0;
  for (let i = 0; i < 128; i++) {
    stepMovement(state, input(), floor, DT, 1, result);
    peak = Math.max(peak, state.pos.y);
  }
  assert.ok(peak > 0.8, `jump was too low: ${peak}`);
  assert.ok(Math.abs(state.pos.y) < 0.01, `should have landed, y=${state.pos.y}`);
  assert.equal(state.onGround, true);
});

test('air control adds at most the air wish speed', () => {
  const state = freshState();
  const result = out();
  stepMovement(state, input({ buttons: BTN_JUMP }), floor, DT, 1, result);
  // Stay well inside the ~0.65 s hang time so we only measure airborne accel.
  for (let i = 0; i < 20; i++) stepMovement(state, input({ moveX: 1 }), floor, DT, 1, result);

  assert.equal(state.onGround, false, 'still airborne');
  assert.ok(
    Math.hypot(state.vel.x, state.vel.z) <= MAX_AIR_WISH_SPEED + 0.01,
    `air control gained ${Math.hypot(state.vel.x, state.vel.z)} m/s`,
  );
});

test('bunny hopping does not accumulate unbounded speed', () => {
  const state = freshState();
  const result = out();
  let peak = 0;
  // Hold forward and jump for five seconds, turning slightly - the classic
  // air-strafe speed exploit if the air acceleration cap is wrong.
  for (let i = 0; i < 320; i++) {
    stepMovement(
      state,
      input({ moveZ: 1, moveX: Math.sin(i / 9) > 0 ? 1 : -1, buttons: BTN_JUMP, yaw: i / 60 }),
      floor,
      DT,
      1,
      result,
    );
    peak = Math.max(peak, Math.hypot(state.vel.x, state.vel.z));
  }
  assert.ok(peak < MAX_GROUND_SPEED * 1.6, `bunny hop reached ${peak.toFixed(2)} m/s`);
});

test('a player under a low ceiling cannot stand back up', () => {
  const ceiling = [...floor, makeBrush(-2, PLAYER_CROUCH_HEIGHT + 0.1, -2, 2, 4, 2)];
  const state = freshState();
  state.height = PLAYER_CROUCH_HEIGHT;
  state.crouching = true;
  assert.equal(canStand(state.pos, ceiling), false);

  const result = out();
  for (let i = 0; i < 64; i++) stepMovement(state, input(), ceiling, DT, 1, result);
  assert.equal(state.crouching, true, 'should stay crouched under the ceiling');
  assert.ok(state.height <= PLAYER_CROUCH_HEIGHT + 0.001);
});

test('movement is deterministic: identical inputs give identical output', () => {
  const commands: MoveInput[] = [];
  for (let i = 0; i < 200; i++) {
    commands.push(
      input({
        moveZ: i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0,
        moveX: i % 5 === 0 ? 1 : 0,
        buttons: i % 17 === 0 ? BTN_JUMP : i % 23 === 0 ? BTN_CROUCH : 0,
        yaw: Math.sin(i / 11) * 2,
      }),
    );
  }

  const play = (): MoveState => {
    const state = freshState();
    const result = out();
    for (const cmd of commands) stepMovement(state, cmd, floor, DT, 0.93, result);
    return state;
  };

  const a = play();
  const b = play();
  assert.deepEqual(a.pos, b.pos);
  assert.deepEqual(a.vel, b.vel);
  assert.equal(a.height, b.height);
  assert.equal(a.onGround, b.onGround);
  assert.ok(Number.isFinite(a.pos.x) && Number.isFinite(a.pos.y) && Number.isFinite(a.pos.z));
});

test('replaying a prefix then the rest matches replaying it all at once', () => {
  // This is exactly what reconciliation does, so it must be path-independent.
  const commands: MoveInput[] = Array.from({ length: 120 }, (_, i) =>
    input({ moveZ: 1, moveX: i % 4 === 0 ? 1 : -1, yaw: i / 40 }),
  );

  const straightThrough = freshState();
  const resultA = out();
  for (const cmd of commands) stepMovement(straightThrough, cmd, floor, DT, 1, resultA);

  const inTwoHalves = freshState();
  const resultB = out();
  for (const cmd of commands.slice(0, 60)) stepMovement(inTwoHalves, cmd, floor, DT, 1, resultB);
  for (const cmd of commands.slice(60)) stepMovement(inTwoHalves, cmd, floor, DT, 1, resultB);

  assert.deepEqual(straightThrough.pos, inTwoHalves.pos);
  assert.deepEqual(straightThrough.vel, inTwoHalves.vel);
});

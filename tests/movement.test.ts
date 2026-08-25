import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type MoveResult, hullOverlapsWorld, makeBrush } from '../src/shared/collision';
import {
  BTN_CROUCH,
  BTN_JUMP,
  BTN_LEAN_LEFT,
  BTN_LEAN_RIGHT,
  BTN_WALK,
  LEAN_DISTANCE,
  MAX_AIR_WISH_SPEED,
  MAX_CROUCH_SPEED,
  MAX_GROUND_SPEED,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
} from '../src/shared/config';
import { vec3 } from '../src/shared/math';
import {
  type MoveInput,
  type MoveState,
  canStand,
  eyePosition,
  stepMovement,
} from '../src/shared/movement';

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
  lean: 0,
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

test('leaning eases in, tops out at full lean, and returns to centre', () => {
  const state = freshState();
  const result = out();
  for (let i = 0; i < 64; i++) {
    stepMovement(state, input({ buttons: BTN_LEAN_RIGHT }), floor, DT, 1, result);
  }
  assert.ok(Math.abs(state.lean - 1) < 0.001, `lean settled at ${state.lean}`);

  for (let i = 0; i < 64; i++) stepMovement(state, input(), floor, DT, 1, result);
  assert.equal(state.lean, 0, 'lean must return to centre when released');
});

test('leaning both ways at once cancels out', () => {
  const state = freshState();
  const result = out();
  for (let i = 0; i < 32; i++) {
    stepMovement(state, input({ buttons: BTN_LEAN_LEFT | BTN_LEAN_RIGHT }), floor, DT, 1, result);
  }
  assert.equal(state.lean, 0);
});

test('lean takes about a sixth of a second, not a frame', () => {
  const state = freshState();
  const result = out();
  stepMovement(state, input({ buttons: BTN_LEAN_LEFT }), floor, DT, 1, result);
  assert.ok(Math.abs(state.lean) < 0.2, `lean snapped to ${state.lean} in one tick`);
  assert.ok(state.lean < 0, 'Q must lean left, i.e. negative');
});

test('a wall clamps the lean, and the closer it is the less you get', () => {
  // Walls to the player's right at yaw = 0 (right is +X), at three distances.
  const leanAgainst = (wallX: number): number => {
    const world = [...floor, makeBrush(wallX, 0, -5, wallX + 4, 4, 5)];
    const state = freshState();
    const result = out();
    for (let i = 0; i < 64; i++) {
      stepMovement(state, input({ buttons: BTN_LEAN_RIGHT }), world, DT, 1, result);
    }
    // Whatever lean survived, the head must not be inside the wall.
    const eye = eyePosition(vec3(), state);
    assert.equal(
      hullOverlapsWorld(eye.x, eye.y - 0.21, eye.z, 0.22, 0.42, world),
      false,
      `head clipped into the wall at lean ${state.lean}`,
    );
    return state.lean;
  };

  // The probe reaches LEAN_DISTANCE + LEAN_PROBE_RADIUS ~= 0.64 m at full
  // lean, so only walls inside that range clamp anything.
  const flush = leanAgainst(0.42);
  const near = leanAgainst(0.55);
  const clear = leanAgainst(2.5);

  assert.ok(clear > 0.99, `should lean fully with no wall nearby, got ${clear}`);
  assert.ok(near < clear, `a nearby wall should clamp the lean (${near} vs ${clear})`);
  assert.ok(flush <= near, `a flush wall should clamp at least as hard (${flush} vs ${near})`);
  assert.ok(flush < 0.6, `leaned ${flush} into a wall right beside us`);
});

test('leaning away from a wall is unaffected', () => {
  const world = [...floor, makeBrush(0.42, 0, -5, 4, 4, 5)];
  const state = freshState();
  const result = out();
  for (let i = 0; i < 64; i++) {
    stepMovement(state, input({ buttons: BTN_LEAN_LEFT }), world, DT, 1, result);
  }
  assert.ok(Math.abs(state.lean - -1) < 0.001, `expected a full left lean, got ${state.lean}`);
});

test('you cannot lean in mid-air', () => {
  const state = freshState();
  const result = out();
  for (let i = 0; i < 32; i++) {
    stepMovement(state, input({ buttons: BTN_LEAN_RIGHT }), floor, DT, 1, result);
  }
  assert.ok(state.lean > 0.5, 'should be leaning on the ground first');

  stepMovement(state, input({ buttons: BTN_JUMP | BTN_LEAN_RIGHT }), floor, DT, 1, result);
  for (let i = 0; i < 20; i++) {
    stepMovement(state, input({ buttons: BTN_LEAN_RIGHT }), floor, DT, 1, result);
  }
  assert.equal(state.onGround, false, 'still airborne');
  assert.ok(state.lean < 0.2, `kept leaning ${state.lean} in the air`);
});

test('the eye moves sideways with the lean, and drops slightly', () => {
  const state = freshState();
  const upright = eyePosition(vec3(), state);
  assert.equal(upright.x, 0);
  assert.ok(Math.abs(upright.y - (PLAYER_HEIGHT - 0.15)) < 1e-9);

  // yaw = 0 looks down -Z, so right is +X.
  state.lean = 1;
  const right = eyePosition(vec3(), state);
  assert.ok(Math.abs(right.x - LEAN_DISTANCE) < 1e-9, `eye at x=${right.x}`);
  assert.ok(Math.abs(right.z) < 1e-9);
  assert.ok(right.y < upright.y, 'the head should dip when leaning');

  state.lean = -1;
  assert.ok(Math.abs(eyePosition(vec3(), state).x + LEAN_DISTANCE) < 1e-9);

  // A quarter turn rotates the offset with the player.
  state.yaw = Math.PI / 2;
  state.lean = 1;
  const turned = eyePosition(vec3(), state);
  assert.ok(Math.abs(turned.x) < 1e-9, `x=${turned.x}`);
  assert.ok(Math.abs(turned.z + LEAN_DISTANCE) < 1e-9, `z=${turned.z}`);
});

test('leaning slows you down', () => {
  const upright = freshState();
  run(upright, input({ moveZ: 1 }), 128);
  const leaning = freshState();
  run(leaning, input({ moveZ: 1, buttons: BTN_LEAN_RIGHT }), 128);
  assert.ok(
    Math.hypot(leaning.vel.x, leaning.vel.z) < Math.hypot(upright.vel.x, upright.vel.z) * 0.85,
    'a leaning player should move slower',
  );
});

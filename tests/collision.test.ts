import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type MoveResult,
  type RayHit,
  hasLineOfSight,
  hullOverlapsWorld,
  isGrounded,
  makeBrush,
  moveAndSlide,
  raycastWorld,
  rayVsBrush,
} from '../src/shared/collision';
import { PLAYER_HEIGHT, PLAYER_RADIUS, STEP_HEIGHT } from '../src/shared/config';
import { vec3 } from '../src/shared/math';

const hit = (): RayHit => ({ t: 0, nx: 0, ny: 0, nz: 0, brush: null });
const result = (): MoveResult => ({
  onGround: false,
  hitWall: false,
  hitCeiling: false,
  landingSpeed: 0,
});

const floor = makeBrush(-50, -1, -50, 50, 0, 50);
const wall = makeBrush(4, 0, -10, 5, 4, 10);

test('a ray hits a brush head-on and reports the facing normal', () => {
  const out = hit();
  const t = rayVsBrush(0, 1, 0, 1, 0, 0, wall, 100, out);
  assert.ok(Math.abs(t - 4) < 1e-6, `t=${t}`);
  assert.equal(out.nx, -1);
});

test('a ray that misses returns -1', () => {
  assert.equal(rayVsBrush(0, 1, 0, 0, 0, 1, wall, 100, hit()), -1);
  assert.equal(rayVsBrush(0, 99, 0, 1, 0, 0, wall, 100, hit()), -1);
});

test('a ray stops short when maxT is closer than the brush', () => {
  assert.equal(rayVsBrush(0, 1, 0, 1, 0, 0, wall, 2, hit()), -1);
});

test('raycastWorld returns the nearest of several brushes', () => {
  const near = makeBrush(1, 0, -2, 2, 4, 2);
  const out = hit();
  assert.equal(raycastWorld([wall, near, floor], vec3(0, 1, 0), vec3(1, 0, 0), 50, out), true);
  assert.ok(Math.abs(out.t - 1) < 1e-6, `expected the nearer brush, got t=${out.t}`);
});

test('line of sight is blocked by geometry and clear otherwise', () => {
  assert.equal(hasLineOfSight([wall], vec3(0, 1, 0), vec3(10, 1, 0)), false);
  assert.equal(hasLineOfSight([wall], vec3(0, 1, 0), vec3(0, 1, 9)), true);
  // The wall only spans z in [-10, 10]; go around it.
  assert.equal(hasLineOfSight([wall], vec3(0, 1, 20), vec3(10, 1, 20)), true);
});

test('line of sight to a coincident point is trivially clear', () => {
  assert.equal(hasLineOfSight([wall], vec3(1, 1, 1), vec3(1, 1, 1)), true);
});

test('a hull resting on the floor reports grounded', () => {
  assert.equal(isGrounded(vec3(0, 0, 0), PLAYER_RADIUS, [floor]), true);
  assert.equal(isGrounded(vec3(0, 3, 0), PLAYER_RADIUS, [floor]), false);
});

test('hull overlap respects the radius footprint', () => {
  // The wall starts at x = 4, so a hull centred at 3.7 with r = 0.4 reaches it
  // while one at 3.5 does not.
  assert.equal(hullOverlapsWorld(3.7, 0, 0, PLAYER_RADIUS, PLAYER_HEIGHT, [wall]), true);
  assert.equal(hullOverlapsWorld(3.5, 0, 0, PLAYER_RADIUS, PLAYER_HEIGHT, [wall]), false);
  // Above the wall's 4 m height there is nothing to hit.
  assert.equal(hullOverlapsWorld(3.7, 5, 0, PLAYER_RADIUS, PLAYER_HEIGHT, [wall]), false);
});

test('moving into a wall stops the hull and zeroes that axis of velocity', () => {
  const pos = vec3(0, 0, 0);
  const vel = vec3(20, 0, 0);
  const out = result();
  let everHitWall = false;
  for (let i = 0; i < 30; i++) {
    moveAndSlide(pos, vel, PLAYER_RADIUS, PLAYER_HEIGHT, [floor, wall], 1 / 64, out);
    everHitWall ||= out.hitWall;
  }
  assert.ok(pos.x <= 4 - PLAYER_RADIUS + 1e-3, `hull tunnelled to x=${pos.x}`);
  assert.ok(pos.x > 3.5, `hull should rest against the wall, got x=${pos.x}`);
  assert.equal(vel.x, 0);
  assert.equal(everHitWall, true);
});

test('sliding along a wall preserves the tangential component', () => {
  const pos = vec3(0, 0, 0);
  const vel = vec3(8, 0, 6);
  const out = result();
  moveAndSlide(pos, vel, PLAYER_RADIUS, PLAYER_HEIGHT, [floor, wall], 0.5, out);
  assert.equal(vel.x, 0, 'blocked axis is cancelled');
  assert.equal(vel.z, 6, 'free axis keeps moving');
  assert.ok(pos.z > 2, `expected to slide along z, got ${pos.z}`);
});

test('gravity lands the hull on the floor and reports the impact speed', () => {
  const pos = vec3(0, 5, 0);
  const vel = vec3(0, -20, 0);
  const out = result();
  let landing = 0;
  for (let i = 0; i < 64; i++) {
    moveAndSlide(pos, vel, PLAYER_RADIUS, PLAYER_HEIGHT, [floor], 1 / 64, out);
    landing = Math.max(landing, out.landingSpeed);
  }
  assert.ok(Math.abs(pos.y) < 0.01, `landed at y=${pos.y}`);
  assert.equal(vel.y, 0);
  assert.equal(out.onGround, true);
  assert.ok(landing > 15, `landing speed was ${landing}`);
});

test('a single huge step cannot tunnel through the floor', () => {
  // 60 m/s (terminal velocity) for a whole 50 ms command is 3 m of travel,
  // more than the map's floor is thick. Sub-stepping must catch it.
  const pos = vec3(0, 4, 0);
  const vel = vec3(0, -60, 0);
  const out = result();
  moveAndSlide(pos, vel, PLAYER_RADIUS, PLAYER_HEIGHT, [floor], 0.05, out);
  assert.ok(pos.y >= -0.01, `tunnelled to y=${pos.y}`);

  // And the pathological case: a full second of freefall in one call.
  const far = vec3(0, 40, 0);
  const farVel = vec3(0, -60, 0);
  moveAndSlide(far, farVel, PLAYER_RADIUS, PLAYER_HEIGHT, [floor], 1, out);
  assert.ok(far.y >= -0.01, `tunnelled to y=${far.y}`);
});

test('a low ledge is stepped onto, a high one is not', () => {
  const low = makeBrush(1, 0, -5, 3, STEP_HEIGHT - 0.05, 5);
  const high = makeBrush(1, 0, -5, 3, STEP_HEIGHT + 1.2, 5);

  const climbing = vec3(0, 0, 0);
  const climbVel = vec3(5, 0, 0);
  const out = result();
  for (let i = 0; i < 40; i++) {
    climbVel.x = 5;
    moveAndSlide(climbing, climbVel, PLAYER_RADIUS, PLAYER_HEIGHT, [floor, low], 1 / 64, out);
    climbVel.y -= 22 / 64;
  }
  assert.ok(climbing.x > 1, `should have stepped up, x=${climbing.x}`);
  assert.ok(climbing.y > 0.2, `should be standing on the ledge, y=${climbing.y}`);

  const blocked = vec3(0, 0, 0);
  const blockedVel = vec3(5, 0, 0);
  for (let i = 0; i < 40; i++) {
    blockedVel.x = 5;
    moveAndSlide(blocked, blockedVel, PLAYER_RADIUS, PLAYER_HEIGHT, [floor, high], 1 / 64, out);
    blockedVel.y -= 22 / 64;
  }
  assert.ok(blocked.x < 1, `should have been blocked, x=${blocked.x}`);
});

test('a ceiling stops upward motion', () => {
  const ceiling = makeBrush(-5, 2.2, -5, 5, 3, 5);
  const pos = vec3(0, 0, 0);
  const vel = vec3(0, 12, 0);
  const out = result();
  moveAndSlide(pos, vel, PLAYER_RADIUS, PLAYER_HEIGHT, [floor, ceiling], 0.2, out);
  assert.equal(out.hitCeiling, true);
  assert.equal(vel.y, 0);
  assert.ok(pos.y + PLAYER_HEIGHT <= 2.2 + 1e-3);
});

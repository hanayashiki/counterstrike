import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBot } from '../src/game/bot';
import type { Combatant } from '../src/game/combatant';
import { GameWorld, TICK_MS, emptySnapshot } from '../src/game/world';
import {
  BTN_ATTACK,
  BTN_CROUCH,
  BTN_LEAN_RIGHT,
  LEAN_DISTANCE,
  MAX_HEALTH,
  TICK_RATE,
} from '../src/shared/config';
import { TEAM_BLUE, TEAM_RED } from '../src/shared/map';
import { anglesFromForward, vec3 } from '../src/shared/math';
import { EventKind, type InputCommand, MatchPhase, PF_ALIVE } from '../src/shared/protocol';
import { WeaponId } from '../src/shared/weapons';

const ticksFor = (seconds: number): number => Math.round((seconds * 1000) / TICK_MS);

function makeWorld(targetPlayers = 10, seed = 4242): GameWorld {
  const world = new GameWorld({ targetPlayers, botSkill: 'normal', seed });
  world.setBotFactory(createBot);
  return world;
}

/**
 * A patch of open floor on the east lane, clear of cover, the lane dividers and
 * the central platform. Combat tests need somewhere a bullet can actually
 * travel; dropping players at the origin would bury them inside the platform.
 */
const OPEN_X = 31;
const OPEN_Z = -13;

function place(c: Combatant, x: number, z: number): void {
  c.move.pos.x = x;
  c.move.pos.y = 0;
  c.move.pos.z = z;
  c.move.vel.x = 0;
  c.move.vel.y = 0;
  c.move.vel.z = 0;
  c.spawnProtectedUntilMs = 0;
}

/** Angles that put the crosshair on `(x, y, z)` from `shooter`'s eye. */
function aimAt(
  shooter: Combatant,
  x: number,
  y: number,
  z: number,
): { yaw: number; pitch: number } {
  const eye = vec3();
  shooter.eyePosition(eye);
  return anglesFromForward(vec3(x - eye.x, y - eye.y, z - eye.z));
}

const attackCommand = (seq: number, yaw: number, pitch: number): InputCommand => ({
  seq,
  dtMs: 16,
  buttons: BTN_ATTACK,
  yaw,
  pitch,
  moveX: 0,
  moveZ: 0,
});

test('the room fills with bots and keeps the teams balanced', () => {
  const world = makeWorld(10);
  world.balanceBots();
  assert.equal(world.playerCount, 10);
  assert.equal(world.humanCount, 0);

  let red = 0;
  let blue = 0;
  for (const c of world.combatants.values()) {
    if (c.team === TEAM_RED) red++;
    else blue++;
  }
  assert.ok(Math.abs(red - blue) <= 1, `teams are lopsided: ${red} vs ${blue}`);
});

test('a joining human displaces a bot and the teams re-balance', () => {
  const world = makeWorld(10);
  world.balanceBots();
  const human = world.addPlayer('Tester', false, -1, WeaponId.Rifle);
  world.balanceBots();

  assert.equal(world.playerCount, 10);
  assert.equal(world.humanCount, 1);
  assert.ok(world.combatants.has(human.id));

  world.removePlayer(human.id);
  world.balanceBots();
  assert.equal(world.playerCount, 10);
  assert.equal(world.humanCount, 0);
});

test('every removal is announced so client rosters cannot accumulate ghosts', () => {
  const world = makeWorld(10);
  world.balanceBots();
  world.departed.length = 0;

  // A human joining pushes the room over its headcount, so balancing drops a
  // bot. That bot has to be announced or every existing client keeps it.
  const human = world.addPlayer('Tester', false, -1, WeaponId.Rifle);
  world.balanceBots();

  assert.equal(world.playerCount, 10);
  assert.ok(world.departed.length > 0, 'a displaced bot was removed without notice');
  for (const id of world.departed) {
    assert.ok(!world.combatants.has(id), `id ${id} was announced as gone but is still present`);
    assert.ok(!world.dirtyRoster.has(id), 'a departed id must not still be queued for PlayerInfo');
  }

  // Model what a client does with the two message streams and check the
  // resulting roster matches the server exactly.
  const roster = new Set<number>(world.combatants.keys());
  for (const id of world.departed) roster.delete(id);
  world.departed.length = 0;

  world.removePlayer(human.id);
  world.balanceBots();
  for (const id of world.dirtyRoster) roster.add(id);
  for (const id of world.departed) roster.delete(id);

  assert.equal(roster.size, world.playerCount, 'client roster drifted from the server');
  assert.deepEqual([...roster].toSorted(), [...world.combatants.keys()].toSorted());
});

test('removing the same player twice announces it once', () => {
  const world = makeWorld(4);
  const player = world.addPlayer('Tester', false, -1, WeaponId.Rifle);
  world.departed.length = 0;
  world.removePlayer(player.id);
  world.removePlayer(player.id);
  assert.deepEqual(world.departed, [player.id]);
});

test('a full minute of bot combat produces a coherent match', () => {
  const world = makeWorld(10, 987);
  world.balanceBots();
  const snapshot = emptySnapshot();

  let shots = 0;
  let kills = 0;
  let spawns = 0;

  for (let i = 0; i < ticksFor(60); i++) {
    world.step();
    if (i % 2 !== 0) continue;
    // Draining events the way the server does keeps the accounting honest.
    const first = world.combatants.values().next().value;
    if (first) {
      world.buildSnapshot(first.id, snapshot);
      for (const event of snapshot.events) {
        if (event.kind === EventKind.Shot) shots++;
        else if (event.kind === EventKind.Kill) kills++;
        else if (event.kind === EventKind.Spawn) spawns++;
      }
    }
    world.clearEvents();
  }

  assert.ok(shots > 100, `bots barely fired (${shots} shots)`);
  assert.ok(kills > 5, `bots barely killed anyone (${kills} kills)`);
  assert.equal(world.scoreRed + world.scoreBlue, kills, 'team scores must equal total kills');
  assert.ok(spawns >= kills, 'every death should be followed by a respawn');
  assert.equal(world.phase, MatchPhase.Live);

  for (const c of world.combatants.values()) {
    const p = c.move.pos;
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), 'NaN position');
    assert.ok(
      Math.abs(p.x) <= 36 && Math.abs(p.z) <= 36,
      `${c.name} escaped the map at ${p.x},${p.z}`,
    );
    assert.ok(p.y > -2 && p.y < 12, `${c.name} is at y=${p.y}`);
    assert.ok(c.health <= MAX_HEALTH && c.health >= 0);
    assert.ok(c.weapon.ammo >= 0 && c.weapon.reserve >= 0, 'ammo went negative');
  }

  const totalKills = [...world.combatants.values()].reduce((sum, c) => sum + c.kills, 0);
  assert.equal(totalKills, kills, 'per-player kill totals must match the killfeed');
});

test('bots reload, take damage and get their health back on respawn', () => {
  const world = makeWorld(6, 31337);
  world.balanceBots();
  let sawReload = false;
  const snapshot = emptySnapshot();

  for (let i = 0; i < ticksFor(45); i++) {
    world.step();
    if (i % 2 !== 0) continue;
    const first = world.combatants.values().next().value;
    if (first) {
      world.buildSnapshot(first.id, snapshot);
      for (const event of snapshot.events) {
        if (event.kind === EventKind.Reload) sawReload = true;
      }
    }
    world.clearEvents();
  }
  assert.ok(sawReload, 'no bot ever reloaded');

  for (const c of world.combatants.values()) {
    if (c.alive) continue;
    assert.ok(c.respawnAtMs > world.timeMs - 1, 'a dead bot has no respawn scheduled');
  }
});

test('point-blank fire damages an enemy and never a teammate', () => {
  const world = makeWorld(2, 7);
  const shooter = world.addPlayer('Shooter', false, TEAM_RED, WeaponId.Rifle);
  const enemy = world.addPlayer('Enemy', false, TEAM_BLUE, WeaponId.Rifle);
  const friend = world.addPlayer('Friend', false, TEAM_RED, WeaponId.Rifle);

  place(shooter, OPEN_X, OPEN_Z);
  place(enemy, OPEN_X, OPEN_Z + 5);
  place(friend, OPEN_X, OPEN_Z - 5);
  // Let them settle onto the floor before anyone pulls a trigger.
  for (let i = 0; i < 4; i++) {
    world.step();
    place(shooter, OPEN_X, OPEN_Z);
    place(enemy, OPEN_X, OPEN_Z + 5);
    place(friend, OPEN_X, OPEN_Z - 5);
  }
  world.clearEvents();

  const atEnemy = aimAt(shooter, OPEN_X, 1.2, OPEN_Z + 5);
  world.queueInput(shooter.id, [attackCommand(1, atEnemy.yaw, atEnemy.pitch)]);
  world.step();

  assert.ok(enemy.health < MAX_HEALTH, `enemy took no damage (hp ${enemy.health})`);
  assert.equal(friend.health, MAX_HEALTH, 'friendly fire must be off');
  assert.equal(shooter.weapon.ammo, 29, 'a round should have been consumed');

  // Now put the crosshair squarely on the teammate: still no damage.
  const before = friend.health;
  const atFriend = aimAt(shooter, OPEN_X, 1.2, OPEN_Z - 5);
  shooter.nextFireAtMs = 0;
  shooter.triggerWasDown = false;
  world.queueInput(shooter.id, [attackCommand(2, atFriend.yaw, atFriend.pitch)]);
  world.step();
  assert.equal(friend.health, before);
});

test("a gap in the input stream does not release the player's keys", () => {
  const world = makeWorld(2, 21);
  const player = world.addPlayer('Holder', false, TEAM_RED, WeaponId.Rifle);
  place(player, OPEN_X, OPEN_Z);

  // Establish a held pose: crouched and leaning.
  for (let seq = 1; seq <= 30; seq++) {
    world.queueInput(player.id, [
      {
        seq,
        dtMs: 16,
        buttons: BTN_CROUCH | BTN_LEAN_RIGHT,
        yaw: 0,
        pitch: 0,
        moveX: 0,
        moveZ: 0,
      },
    ]);
    world.step();
    place(player, OPEN_X, OPEN_Z);
  }
  assert.ok(player.move.lean > 0.95, `lean did not commit (${player.move.lean})`);
  assert.equal(player.move.crouching, true);

  // Now the packets stop. Ordinary jitter is a tick or two; the pose must hold.
  for (let i = 0; i < 4; i++) {
    world.step();
    place(player, OPEN_X, OPEN_Z);
  }
  assert.ok(player.move.lean > 0.95, `lean decayed to ${player.move.lean} after a brief gap`);
  assert.equal(player.move.crouching, true, 'a dropped packet must not stand the player up');

  // A client that genuinely stops talking comes to rest instead.
  for (let i = 0; i < 40; i++) {
    world.step();
    place(player, OPEN_X, OPEN_Z);
  }
  assert.ok(player.move.lean < 0.05, `lean never released (${player.move.lean})`);
});

test('a stalled client cannot keep firing or jumping', () => {
  const world = makeWorld(2, 22);
  const player = world.addPlayer('Stalled', false, TEAM_RED, WeaponId.Rifle);
  place(player, OPEN_X, OPEN_Z);

  world.queueInput(player.id, [
    { seq: 1, dtMs: 16, buttons: BTN_ATTACK, yaw: 0, pitch: -0.1, moveX: 0, moveZ: 0 },
  ]);
  world.step();
  const ammoAfterFirstShot = player.weapon.ammo;
  assert.equal(ammoAfterFirstShot, 29, 'the real command should have fired once');

  // Input stops. The trigger must not be held down on our behalf.
  for (let i = 0; i < 30; i++) world.step();
  assert.equal(player.weapon.ammo, ammoAfterFirstShot, 'a stalled client kept shooting');
  assert.ok(player.move.onGround, 'a stalled client kept jumping');
});

test('the server traces shots from the leaned eye, not the hull centre', () => {
  const world = makeWorld(2, 5);
  const shooter = world.addPlayer('Peeker', false, TEAM_RED, WeaponId.Rifle);
  place(shooter, OPEN_X, OPEN_Z);

  // Hold the lean until it is fully committed.
  const yaw = 0;
  for (let seq = 1; seq <= 24; seq++) {
    world.queueInput(shooter.id, [
      { seq, dtMs: 16, buttons: BTN_LEAN_RIGHT, yaw, pitch: 0, moveX: 0, moveZ: 0 },
    ]);
    world.step();
    shooter.move.pos.x = OPEN_X;
    shooter.move.pos.z = OPEN_Z;
  }
  world.clearEvents();

  assert.ok(shooter.move.lean > 0.95, `lean only reached ${shooter.move.lean}`);

  // At yaw = 0 the player looks down -Z and right is +X, so a full right lean
  // should slide the viewpoint a full LEAN_DISTANCE toward +X.
  const eye = shooter.eyePosition(vec3());
  assert.ok(
    Math.abs(eye.x - (OPEN_X + LEAN_DISTANCE)) < 0.01,
    `leaned eye sits at x=${eye.x}, expected ${OPEN_X + LEAN_DISTANCE}`,
  );
  assert.ok(Math.abs(eye.z - OPEN_Z) < 0.01, 'lean must not move the eye forward or back');

  // Fire, and confirm the authoritative tracer starts from that leaned eye.
  world.queueInput(shooter.id, [
    { seq: 100, dtMs: 16, buttons: BTN_ATTACK | BTN_LEAN_RIGHT, yaw, pitch: 0, moveX: 0, moveZ: 0 },
  ]);
  world.step();

  const snapshot = emptySnapshot();
  world.buildSnapshot(shooter.id, snapshot);
  const shot = snapshot.events.find((e) => e.kind === EventKind.Shot);
  assert.ok(shot && shot.kind === EventKind.Shot, 'no shot was recorded');
  assert.ok(
    Math.abs(shot.ox - (OPEN_X + LEAN_DISTANCE)) < 0.05,
    `bullet came from x=${shot.ox}, not the leaned eye at ${OPEN_X + LEAN_DISTANCE}`,
  );
  assert.ok(
    shot.ox - OPEN_X > 0.3,
    'the shot origin must be meaningfully displaced from the hull centre',
  );
});

test('lag compensation rewinds a moving target to where the shooter saw it', () => {
  const world = makeWorld(2, 11);
  const shooter = world.addPlayer('Shooter', false, TEAM_RED, WeaponId.Rifle);
  const target = world.addPlayer('Target', false, TEAM_BLUE, WeaponId.Rifle);

  const targetZ = OPEN_Z + 5;
  const startX = OPEN_X - 3;
  const perTick = 0.12;
  const totalTicks = 48;

  place(shooter, OPEN_X, OPEN_Z);

  // Slide the target across the shooter's view, one tick at a time, so the
  // server builds up a real position history to rewind through.
  for (let i = 0; i < totalTicks; i++) {
    place(target, startX + i * perTick, targetZ);
    world.step();
    place(shooter, OPEN_X, OPEN_Z);
    place(target, startX + i * perTick, targetZ);
  }
  world.clearEvents();

  // 200 ms of rewind = 100 ms interpolation delay + half of a 200 ms ping.
  const rewindTicks = 200 / TICK_MS;
  const seenX = startX + (totalTicks - 1 - rewindTicks) * perTick;
  const nowX = startX + (totalTicks - 1) * perTick;
  assert.ok(Math.abs(nowX - seenX) > 1, 'the target must have moved more than its own width');

  const aim = aimAt(shooter, seenX, 1.1, targetZ);

  const damageWithPing = (pingMs: number, seq: number): number => {
    const before = target.health;
    shooter.pingMs = pingMs;
    shooter.nextFireAtMs = 0;
    shooter.triggerWasDown = false;
    shooter.spread = 0;
    world.queueInput(shooter.id, [attackCommand(seq, aim.yaw, aim.pitch)]);
    world.step();
    place(shooter, OPEN_X, OPEN_Z);
    place(target, nowX, targetZ);
    const dealt = before - target.health;
    target.health = MAX_HEALTH;
    target.armor = 50;
    world.clearEvents();
    return dealt;
  };

  const withLagComp = damageWithPing(200, 900);
  const withoutLagComp = damageWithPing(0, 901);

  assert.ok(withLagComp > 0, 'a lag-compensated shot at the seen position should connect');
  assert.equal(withoutLagComp, 0, 'the same shot without rewind should miss the moved target');
});

test('rewinding further than MAX_REWIND_MS is refused', () => {
  const world = makeWorld(2, 13);
  const shooter = world.addPlayer('Shooter', false, TEAM_RED, WeaponId.Rifle);
  shooter.pingMs = 100_000;
  // The clamp lives in fireShot; this just proves an absurd ping cannot crash
  // or rewind past the history buffer.
  world.queueInput(shooter.id, [attackCommand(1, 0, 0)]);
  world.step();
  assert.ok(Number.isFinite(shooter.move.pos.x));
});

test('snapshots describe every other player and never the viewer', () => {
  const world = makeWorld(8);
  world.balanceBots();
  for (let i = 0; i < 64; i++) world.step();

  const snapshot = emptySnapshot();
  for (const viewer of world.combatants.values()) {
    world.buildSnapshot(viewer.id, snapshot);
    assert.equal(snapshot.entities.length, world.playerCount - 1);
    assert.ok(!snapshot.entities.some((e) => e.id === viewer.id), 'viewer leaked into entities');
    assert.equal(snapshot.local.health, Math.round(viewer.health));
    if (viewer.alive) assert.ok((snapshot.local.flags & PF_ALIVE) !== 0);
    for (const entity of snapshot.entities) {
      assert.ok(entity.heightCm > 100 && entity.heightCm <= 200);
    }
  }
});

test('the warm-up gives way to a live round', () => {
  const world = makeWorld(4);
  world.balanceBots();
  assert.equal(world.phase, MatchPhase.Warmup);
  for (let i = 0; i < ticksFor(6); i++) world.step();
  assert.equal(world.phase, MatchPhase.Live);
  assert.ok(world.matchState().timeLeftMs > 0);
});

test('input sequence numbers are acknowledged and replayed only once', () => {
  const world = makeWorld(2);
  const player = world.addPlayer('Tester', false, TEAM_RED, WeaponId.Rifle);
  const commands: InputCommand[] = [1, 2, 3].map((seq) => ({
    seq,
    dtMs: 16,
    buttons: 0,
    yaw: 0,
    pitch: 0,
    moveX: 0,
    moveZ: 1,
  }));

  world.queueInput(player.id, commands);
  // Re-sending the same batch must not double-apply it.
  world.queueInput(player.id, commands);
  assert.equal(player.pendingInputs.length, 3);

  world.step();
  assert.equal(player.lastProcessedSeq, 3);

  world.queueInput(player.id, commands);
  assert.equal(player.pendingInputs.length, 0, 'already-acked commands must be dropped');
});

test('the tick clock advances at the configured rate', () => {
  const world = makeWorld(2);
  for (let i = 0; i < TICK_RATE; i++) world.step();
  assert.equal(world.tick, TICK_RATE);
  assert.ok(Math.abs(world.timeMs - 1000) < 0.001, `one second of ticks gave ${world.timeMs}ms`);
});

/**
 * Character models are cosmetic. The simulation collides and hitscans against
 * one hull for everybody, so a model that poked outside it would be a penalty
 * to whoever picked it, and one that sat well inside it would be an unearned
 * advantage. These tests are the thing keeping that honest.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBot } from '../src/game/bot';
import { GameWorld, emptySnapshot } from '../src/game/world';
import {
  CHARACTERS,
  CHARACTER_COUNT,
  characterForId,
  getCharacter,
  headHeight,
  shoulderHipRatio,
  widestPoint,
} from '../src/shared/characters';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../src/shared/config';
import { WeaponId } from '../src/shared/weapons';

const HULL_WIDTH = PLAYER_RADIUS * 2;

test('the table is indexed by character id', () => {
  for (const [index, character] of CHARACTERS.entries()) {
    assert.equal(character.id, index, `${character.name} is out of order`);
  }
  assert.equal(CHARACTER_COUNT, CHARACTERS.length);
  assert.ok(CHARACTER_COUNT >= 2, 'there should be a choice to make');
});

test('getCharacter falls back rather than returning undefined', () => {
  assert.equal(getCharacter(0).name, 'Bulwark');
  assert.equal(getCharacter(99).id, 0);
  assert.equal(getCharacter(-1).id, 0);
});

test('no model is wider than the collision hull', () => {
  for (const character of CHARACTERS) {
    const widest = widestPoint(character);
    assert.ok(
      widest <= HULL_WIDTH + 1e-9,
      `${character.name} is ${widest.toFixed(3)} m across but the hull is only ${HULL_WIDTH} m`,
    );
  }
});

test('the models sit inside one generous hitbox, and close to each other', () => {
  // The hull is deliberately wider than any human silhouette, so a shot that
  // looks like it should connect does. What matters for fairness is that the
  // spread BETWEEN models is small next to the hull they all share: picking the
  // leanest operator must not measurably change how hard you are to hit.
  const widths = CHARACTERS.map((c) => widestPoint(c));
  const widest = Math.max(...widths);
  const narrowest = Math.min(...widths);

  assert.ok(widest < HULL_WIDTH, 'the hitbox should be at least as generous as every model');
  assert.ok(
    widest - narrowest < HULL_WIDTH * 0.15,
    `models span ${(widest - narrowest).toFixed(3)} m, which is a lot against a ${HULL_WIDTH} m hull`,
  );
});

test('every model is anatomically coherent', () => {
  for (const c of CHARACTERS) {
    assert.ok(c.shoulderSpan > c.chestWidth, `${c.name}: shoulders inside the chest`);
    assert.ok(c.chestWidth > c.waistWidth, `${c.name}: no waist`);
    assert.ok(c.chestDepth < c.chestWidth, `${c.name}: deeper than it is wide`);
    assert.ok(c.headRadius > 0.08 && c.headRadius < 0.16, `${c.name}: head size`);
    assert.ok(c.upperArmRadius > c.forearmRadius, `${c.name}: forearm thicker than upper arm`);
    assert.ok(c.thighRadius > c.calfRadius, `${c.name}: calf thicker than thigh`);
  }
});

test('the vertical landmarks match human proportions', () => {
  // Measured against standard figure-drawing landmarks for a 1.8 m adult.
  for (const c of CHARACTERS) {
    const h = PLAYER_HEIGHT;
    assert.ok(c.kneeHeight / h > 0.25 && c.kneeHeight / h < 0.31, `${c.name}: knee height`);
    assert.ok(c.hipHeight / h > 0.46 && c.hipHeight / h < 0.53, `${c.name}: hip height`);
    assert.ok(
      c.shoulderHeight / h > 0.78 && c.shoulderHeight / h < 0.85,
      `${c.name}: shoulder height`,
    );
    // A figure is roughly seven and a half heads tall.
    const heads = h / headHeight(c);
    assert.ok(heads > 7.2 && heads < 7.9, `${c.name} is ${heads.toFixed(1)} heads tall`);

    // The landmarks have to stack in order, or the skeleton inverts.
    assert.ok(c.kneeHeight < c.hipHeight);
    assert.ok(c.hipHeight < c.waistHeight);
    assert.ok(c.waistHeight < c.shoulderHeight);
    assert.ok(c.shoulderHeight < c.neckHeight);
    assert.ok(c.neckHeight + headHeight(c) <= h + 0.02, `${c.name}: head pokes out of the hull`);
  }
});

test('the builds read differently in silhouette', () => {
  const heavy = CHARACTERS.filter((c) => c.build === 'heavy');
  const athletic = CHARACTERS.filter((c) => c.build === 'athletic');
  assert.ok(heavy.length > 0 && athletic.length > 0, 'both builds should exist');

  // Shoulder-to-hip ratio is the strongest cue: a heavy build is widest at the
  // shoulder, an athletic one is near even.
  for (const c of heavy) {
    assert.ok(shoulderHipRatio(c) > 1.25, `${c.name} is not shoulder-dominant`);
  }
  for (const c of athletic) {
    assert.ok(shoulderHipRatio(c) < 1.15, `${c.name} is too shoulder-dominant`);
  }
});

test('operators sharing a build are still told apart by their kit', () => {
  // Two athletic figures differ by millimetres, so the outline has to come from
  // somewhere else: hair and worn gear.
  const seen = new Map<string, string[]>();
  for (const c of CHARACTERS) {
    const key = `${c.hair}/${c.gear}`;
    seen.set(key, [...(seen.get(key) ?? []), c.name]);
  }
  for (const [key, names] of seen) {
    assert.equal(names.length, 1, `${names.join(' and ')} share the same look (${key})`);
  }
});

test('a character choice never reaches the simulation', () => {
  const world = new GameWorld({ targetPlayers: 2, botSkill: 'normal', seed: 99 });
  const a = world.addPlayer('A', false, 0, WeaponId.Rifle, 0);
  const b = world.addPlayer('B', false, 1, WeaponId.Rifle, 2);

  assert.equal(a.character, 0);
  assert.equal(b.character, 2);
  // Nothing the simulation reads may differ because of it.
  assert.equal(a.move.height, b.move.height);
  assert.equal(a.health, b.health);
  assert.equal(a.armor, b.armor);
  assert.equal(a.weaponDef.id, b.weaponDef.id);
});

test('an out-of-range choice falls back to a stable model', () => {
  const world = new GameWorld({ targetPlayers: 2, botSkill: 'normal', seed: 7 });
  const cheeky = world.addPlayer('Cheeky', false, 0, WeaponId.Rifle, 250);
  assert.ok(cheeky.character >= 0 && cheeky.character < CHARACTER_COUNT);
  assert.equal(cheeky.character, characterForId(cheeky.id));
});

test('the chosen model is published to everyone', () => {
  const world = new GameWorld({ targetPlayers: 2, botSkill: 'normal', seed: 3 });
  const player = world.addPlayer('Kite fan', false, 0, WeaponId.Rifle, 1);
  assert.equal(world.playerInfo(player).character, 1);
});

test('bots get a spread of models, not all the same one', () => {
  const world = new GameWorld({ targetPlayers: 10, botSkill: 'normal', seed: 4242 });
  world.setBotFactory(createBot);
  world.balanceBots();

  const used = new Set<number>();
  for (const bot of world.combatants.values()) {
    assert.ok(bot.character >= 0 && bot.character < CHARACTER_COUNT);
    used.add(bot.character);
  }
  assert.ok(used.size >= 2, `all ten bots picked model ${[...used]}`);
});

/** Run a fixed match with everyone on one model; return a position fingerprint. */
function fingerprint(character: number): number {
  const world = new GameWorld({ targetPlayers: 6, botSkill: 'normal', seed: 555 });
  world.setBotFactory(createBot);
  world.balanceBots();
  for (const c of world.combatants.values()) c.character = character;

  for (let i = 0; i < 1200; i++) {
    world.step();
    world.clearEvents();
  }

  const viewer = world.combatants.values().next().value;
  if (!viewer) throw new Error('no combatants');
  const snapshot = emptySnapshot();
  world.buildSnapshot(viewer.id, snapshot);
  return Math.round((snapshot.local.x + snapshot.local.z) * 1000);
}

test('a match runs identically whatever models are in it', () => {
  assert.equal(fingerprint(0), fingerprint(2), 'the model changed the simulation');
});

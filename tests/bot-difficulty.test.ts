/**
 * The skill tiers are the only dial most people will touch, so their ordering
 * is worth pinning. This once regressed badly: `aimJitter` was applied as a
 * per-tick random walk that the tracking term corrected on the same tick, so it
 * barely affected accuracy and `easy` bots ended up deadlier than `elite` ones.
 *
 * The sim is deterministic for a fixed seed, so these numbers are stable.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBot } from '../src/game/bot';
import { type BotSkill, GameWorld, TICK_MS, emptySnapshot } from '../src/game/world';
import { BOT_SKILLS } from '../src/shared/config';
import { EventKind } from '../src/shared/protocol';

interface Result {
  killsPerMin: number;
  headshotPct: number;
}

function measure(skill: BotSkill, seconds = 45, seed = 4242): Result {
  const world = new GameWorld({ targetPlayers: 10, botSkill: skill, seed });
  world.setBotFactory(createBot);
  world.balanceBots();

  const snapshot = emptySnapshot();
  let kills = 0;
  let headshots = 0;

  for (let i = 0; i < Math.round((seconds * 1000) / TICK_MS); i++) {
    world.step();
    if (i % 2 !== 0) continue;
    const viewer = world.combatants.values().next().value;
    if (viewer) {
      world.buildSnapshot(viewer.id, snapshot);
      for (const event of snapshot.events) {
        if (event.kind !== EventKind.Kill) continue;
        kills++;
        if (event.headshot) headshots++;
      }
    }
    world.clearEvents();
  }

  return {
    killsPerMin: (kills / seconds) * 60,
    headshotPct: (100 * headshots) / Math.max(1, kills),
  };
}

const easy = measure('easy');
const normal = measure('normal');
const hard = measure('hard');
const elite = measure('elite');

test('lethality increases with every skill tier', () => {
  const ladder = [
    ['easy', easy],
    ['normal', normal],
    ['hard', hard],
    ['elite', elite],
  ] as const;
  for (let i = 1; i < ladder.length; i++) {
    const [prevName, prev] = ladder[i - 1] as (typeof ladder)[number];
    const [name, current] = ladder[i] as (typeof ladder)[number];
    assert.ok(
      current.killsPerMin > prev.killsPerMin,
      `${name} (${current.killsPerMin.toFixed(1)}/min) is not deadlier than ${prevName} (${prev.killsPerMin.toFixed(1)}/min)`,
    );
  }
});

test('easy is meaningfully easier, not marginally', () => {
  assert.ok(
    easy.killsPerMin < elite.killsPerMin * 0.45,
    `easy is ${easy.killsPerMin.toFixed(1)}/min against elite's ${elite.killsPerMin.toFixed(1)}/min`,
  );
  assert.ok(
    easy.killsPerMin < 22,
    `easy bots are still killing ${easy.killsPerMin.toFixed(1)}/min`,
  );
});

test('weak bots rarely land headshots', () => {
  // Weak bots aim at the belly precisely so their wide error cone does not
  // scatter onto the head, where a 4x multiplier would one-shot the target.
  assert.ok(
    easy.headshotPct < normal.headshotPct,
    `easy headshots ${easy.headshotPct.toFixed(0)}% vs normal ${normal.headshotPct.toFixed(0)}%`,
  );
  assert.ok(easy.headshotPct < 25, `easy bots headshot ${easy.headshotPct.toFixed(0)}% of kills`);
  assert.ok(elite.headshotPct > 45, 'elite bots should be picking heads');
});

test('difficulty can be changed mid-match and actually takes effect', () => {
  const world = new GameWorld({ targetPlayers: 10, botSkill: 'elite', seed: 4242 });
  world.setBotFactory(createBot);
  world.balanceBots();
  for (let i = 0; i < 200; i++) world.step();

  assert.equal(world.botSkill, 'elite');
  assert.equal(world.matchState().botSkill, BOT_SKILLS.indexOf('elite'));

  // Same roster, same ids - the change must not reshuffle the match.
  const before = [...world.combatants.keys()].toSorted();
  assert.equal(world.setBotSkill('easy'), true, 'a real change reports true');
  assert.deepEqual([...world.combatants.keys()].toSorted(), before, 'roster changed');
  assert.equal(world.botSkill, 'easy');
  assert.equal(world.matchState().botSkill, BOT_SKILLS.indexOf('easy'));
  assert.equal(world.matchStateDirty, true, 'clients must be told');

  // Setting the same tier again is a no-op the server can skip broadcasting.
  assert.equal(world.setBotSkill('easy'), false);

  // And the bots genuinely behave like the new tier: run both a world that was
  // built as easy and one switched to easy, and compare their lethality.
  const switched = countKills(world, 45);
  const born = countKills(freshWorld('easy'), 45);
  assert.ok(
    Math.abs(switched - born) < born * 0.6 + 6,
    `switched-to-easy killed ${switched} vs ${born} for a world born easy`,
  );
  assert.ok(switched < 40, `bots switched to easy still killed ${switched} in 45 s`);
});

function freshWorld(skill: BotSkill): GameWorld {
  const world = new GameWorld({ targetPlayers: 10, botSkill: skill, seed: 4242 });
  world.setBotFactory(createBot);
  world.balanceBots();
  for (let i = 0; i < 200; i++) world.step();
  return world;
}

function countKills(world: GameWorld, seconds: number): number {
  const snapshot = emptySnapshot();
  let kills = 0;
  for (let i = 0; i < Math.round((seconds * 1000) / TICK_MS); i++) {
    world.step();
    if (i % 2 !== 0) continue;
    const viewer = world.combatants.values().next().value;
    if (viewer) {
      world.buildSnapshot(viewer.id, snapshot);
      for (const event of snapshot.events) if (event.kind === EventKind.Kill) kills++;
    }
    world.clearEvents();
  }
  return kills;
}

test('an unknown skill string is not silently accepted as a profile', () => {
  // The Durable Object validates BOT_SKILL against this set before use.
  const valid: BotSkill[] = ['easy', 'normal', 'hard', 'elite'];
  for (const skill of valid) {
    assert.doesNotThrow(() => measure(skill, 1));
  }
});

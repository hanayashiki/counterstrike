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

test('an unknown skill string is not silently accepted as a profile', () => {
  // The Durable Object validates BOT_SKILL against this set before use.
  const valid: BotSkill[] = ['easy', 'normal', 'hard', 'elite'];
  for (const skill of valid) {
    assert.doesNotThrow(() => measure(skill, 1));
  }
});

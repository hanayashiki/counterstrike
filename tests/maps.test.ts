/**
 * Every map has to satisfy the same contract before it is playable: spawns you
 * can stand in, a navigation graph that connects both sides, and no waypoint on
 * a surface a player could never climb to.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hullOverlapsWorld } from '../src/shared/collision';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../src/shared/config';
import {
  DEFAULT_MAP_ID,
  GAME_MAP,
  type GameMap,
  MAPS,
  MAP_IDS,
  TEAM_BLUE,
  TEAM_RED,
  getMap,
  mapFromIndex,
  mapIndex,
} from '../src/shared/map';
import { distance2D } from '../src/shared/math';
import { NavGraph } from '../src/shared/nav';

const graphs = new Map(MAPS.map((map) => [map.id, NavGraph.build(map)]));
const navFor = (id: string): NavGraph => graphs.get(id) as NavGraph;

test('the registry is coherent', () => {
  assert.ok(MAPS.length >= 2, 'there should be a choice of map');
  assert.equal(new Set(MAP_IDS).size, MAPS.length, 'duplicate map ids');
  assert.ok(MAP_IDS.includes(DEFAULT_MAP_ID));
  assert.equal(getMap(DEFAULT_MAP_ID).id, GAME_MAP.id);

  for (const [index, map] of MAPS.entries()) {
    assert.equal(mapIndex(map.id), index, `${map.id} index mismatch`);
    assert.equal(mapFromIndex(index).id, map.id);
    assert.ok(map.label.length > 0, `${map.id} needs a label for the picker`);
  }
});

test('unknown maps fall back rather than crashing', () => {
  assert.equal(getMap('no-such-map').id, GAME_MAP.id);
  assert.equal(mapFromIndex(99).id, GAME_MAP.id);
  assert.equal(mapFromIndex(-1).id, GAME_MAP.id);
  assert.equal(mapIndex('no-such-map'), 0);
});

for (const map of MAPS) {
  test(`${map.name}: both teams have spawns, and none are buried`, () => {
    const red = map.spawns.filter((s) => s.team === TEAM_RED);
    const blue = map.spawns.filter((s) => s.team === TEAM_BLUE);
    assert.ok(red.length >= 4, `${map.name}: only ${red.length} red spawns`);
    assert.equal(red.length, blue.length, `${map.name}: uneven spawns`);

    for (const spawn of map.spawns) {
      assert.equal(
        hullOverlapsWorld(
          spawn.pos.x,
          spawn.pos.y,
          spawn.pos.z,
          PLAYER_RADIUS,
          PLAYER_HEIGHT,
          map.brushes,
        ),
        false,
        `${map.name}: a spawn at ${spawn.pos.x},${spawn.pos.z} is inside geometry`,
      );
      assert.ok(
        spawn.pos.x > map.bounds.minX && spawn.pos.x < map.bounds.maxX,
        `${map.name}: spawn outside bounds`,
      );
      assert.ok(spawn.pos.z > map.bounds.minZ && spawn.pos.z < map.bounds.maxZ);
    }
  });

  test(`${map.name}: every red spawn can reach every blue spawn`, () => {
    const nav = navFor(map.id);
    const red = map.spawns.filter((s) => s.team === TEAM_RED);
    const blue = map.spawns.filter((s) => s.team === TEAM_BLUE);
    for (const from of red) {
      for (const to of blue) {
        const path = nav.findPath(nav.nearest(from.pos), nav.nearest(to.pos));
        assert.ok(path.length > 4, `${map.name}: no route between spawns`);
      }
    }
  });

  test(`${map.name}: every waypoint is reachable from a spawn`, () => {
    const nav = navFor(map.id);
    assert.ok(nav.nodes.length > 200, `${map.name}: only ${nav.nodes.length} waypoints`);

    const first = map.spawns[0];
    assert.ok(first, `${map.name}: no spawns at all`);
    const start = nav.nearest(first.pos);
    let unreachable = 0;
    for (const node of nav.nodes) {
      if (node.id === start) continue;
      if (nav.findPath(start, node.id).length === 0) unreachable++;
    }
    assert.equal(
      unreachable,
      0,
      `${map.name}: ${unreachable} waypoints cannot be reached from a spawn`,
    );
  });

  test(`${map.name}: no waypoint sits on unreachable scenery`, () => {
    // Wall tops are the classic offender: the grid lands on them, and they link
    // downward into the map even though nothing links back up.
    const nav = navFor(map.id);
    const ceiling = 5;
    const stranded = nav.nodes.filter((n) => n.pos.y > ceiling);
    assert.equal(
      stranded.length,
      0,
      `${map.name}: ${stranded.length} waypoints above ${ceiling} m`,
    );
  });

  test(`${map.name}: every waypoint is somewhere a player fits`, () => {
    for (const node of navFor(map.id).nodes) {
      assert.equal(
        hullOverlapsWorld(
          node.pos.x,
          node.pos.y,
          node.pos.z,
          PLAYER_RADIUS,
          PLAYER_HEIGHT,
          map.brushes,
        ),
        false,
        `${map.name}: waypoint ${node.id} is inside geometry`,
      );
    }
  });

  test(`${map.name}: the graph builds fast enough for server start-up`, () => {
    const started = performance.now();
    NavGraph.build(map);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `${map.name}: nav build took ${elapsed.toFixed(0)}ms`);
  });

  test(`${map.name}: geometry is sane`, () => {
    assert.ok(map.solids.length > 10, `${map.name}: suspiciously empty`);
    for (const solid of map.solids) {
      const b = solid.brush;
      assert.ok(b.maxX > b.minX && b.maxY > b.minY && b.maxZ > b.minZ, `${map.name}: inverted box`);
    }
    assert.ok(map.fogNear < map.fogFar, `${map.name}: fog range inverted`);
  });
}

test('the cargo map keeps its climbable container stacks', () => {
  const cargo = getMap('cargo');
  const nav = navFor('cargo');
  const elevated = nav.nodes.filter((n) => n.pos.y > 2);
  assert.ok(elevated.length > 0, 'no waypoints on top of the containers');

  // And a bot can actually get up there from a spawn.
  const first = cargo.spawns[0];
  const perch = elevated[0];
  assert.ok(first && perch);
  const path = nav.findPath(nav.nearest(first.pos), perch.id);
  assert.ok(path.length > 2, 'the container stack is not climbable');
  assert.ok(
    path.some((id, i) => i > 0 && nav.linkRequiresJump(path[i - 1] as number, id)),
    'reaching a container top should involve a jump',
  );
});

const span = (m: GameMap) => ({
  x: m.bounds.maxX - m.bounds.minX,
  z: m.bounds.maxZ - m.bounds.minZ,
});

test('the two maps are meaningfully different shapes', () => {
  const g = span(getMap('grid'));
  const c = span(getMap('cargo'));
  assert.ok(Math.abs(g.x - g.z) < 1, 'grid should be square');
  assert.ok(c.z > c.x * 1.6, 'the ship should be long and narrow');
});

test('spawns are far apart enough to not be a spawn trap', () => {
  for (const map of MAPS) {
    const red = map.spawns.filter((s) => s.team === TEAM_RED);
    const blue = map.spawns.filter((s) => s.team === TEAM_BLUE);
    let closest = Infinity;
    for (const a of red)
      for (const b of blue) closest = Math.min(closest, distance2D(a.pos, b.pos));
    assert.ok(closest > 25, `${map.name}: spawns only ${closest.toFixed(0)} m apart`);
  }
});

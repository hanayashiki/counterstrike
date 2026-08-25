import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hullOverlapsWorld } from '../src/shared/collision';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../src/shared/config';
import { GAME_MAP, TEAM_BLUE, TEAM_RED } from '../src/shared/map';
import { distance2D } from '../src/shared/math';
import { NavGraph } from '../src/shared/nav';

const nav = NavGraph.build(GAME_MAP);

test('the graph covers the map with connected waypoints', () => {
  assert.ok(nav.nodes.length > 200, `only ${nav.nodes.length} waypoints`);
  assert.ok(nav.linkCount > nav.nodes.length * 3, `graph is too sparse (${nav.linkCount} links)`);
  const isolated = nav.nodes.filter((node) => node.links.length === 0);
  assert.equal(isolated.length, 0, `${isolated.length} waypoints have no links`);
});

test('every waypoint is somewhere a player could actually stand', () => {
  for (const node of nav.nodes) {
    assert.equal(
      hullOverlapsWorld(
        node.pos.x,
        node.pos.y,
        node.pos.z,
        PLAYER_RADIUS,
        PLAYER_HEIGHT,
        GAME_MAP.brushes,
      ),
      false,
      `waypoint ${node.id} at (${node.pos.x}, ${node.pos.y}, ${node.pos.z}) is inside geometry`,
    );
  }
});

test('both spawn areas are on the graph', () => {
  for (const spawn of GAME_MAP.spawns) {
    const nearest = nav.nearest(spawn.pos);
    assert.ok(nearest >= 0, 'spawn has no nearby waypoint');
    const node = nav.nodes[nearest];
    assert.ok(
      node && distance2D(node.pos, spawn.pos) < 5,
      'nearest waypoint is too far from spawn',
    );
  }
});

test('a path exists from every red spawn to every blue spawn', () => {
  const red = GAME_MAP.spawns.filter((s) => s.team === TEAM_RED);
  const blue = GAME_MAP.spawns.filter((s) => s.team === TEAM_BLUE);
  for (const from of red) {
    for (const to of blue) {
      const path = nav.findPath(nav.nearest(from.pos), nav.nearest(to.pos));
      assert.ok(path.length > 4, `no route from ${from.pos.z} to ${to.pos.z}`);
      assert.equal(path[0], nav.nearest(from.pos));
      assert.equal(path.at(-1), nav.nearest(to.pos));
    }
  }
});

test('paths only use real links, and consecutive waypoints are close', () => {
  const [redSpawn, blueSpawn] = GAME_MAP.spawns;
  assert.ok(redSpawn && blueSpawn);
  const path = nav.findPath(nav.nearest(redSpawn.pos), nav.nearest(blueSpawn.pos));
  for (let i = 1; i < path.length; i++) {
    const previous = nav.nodes[path[i - 1] as number];
    const current = nav.nodes[path[i] as number];
    assert.ok(previous && current);
    assert.ok(
      previous.links.some((link) => link.to === current.id),
      `path step ${i} is not a real link`,
    );
    assert.ok(distance2D(previous.pos, current.pos) < 10, 'waypoints are too far apart');
  }
});

test('a path to itself is a single node, and unreachable ids give nothing', () => {
  assert.deepEqual(nav.findPath(5, 5), [5]);
  assert.deepEqual(nav.findPath(-1, 3), []);
  assert.deepEqual(nav.findPath(3, 99_999), []);
});

test('the central platform is reachable', () => {
  // The raised platform in the middle sits at y = 2; bots must be able to get up.
  const platformNode = nav.nodes.find(
    (node) => node.pos.y > 1.8 && Math.abs(node.pos.x) < 5 && Math.abs(node.pos.z) < 5,
  );
  const [redSpawn] = GAME_MAP.spawns;
  assert.ok(platformNode, 'no waypoints on the central platform');
  assert.ok(redSpawn);
  const path = nav.findPath(nav.nearest(redSpawn.pos), platformNode.id);
  assert.ok(path.length > 2, 'cannot route onto the platform');
});

test('building the graph is fast enough to do at server start-up', () => {
  const started = performance.now();
  NavGraph.build(GAME_MAP);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `nav build took ${elapsed.toFixed(1)}ms`);
});

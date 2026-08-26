/**
 * `cs_cargo` - a blockout in the spirit of CrossFire's 运输船 (Transport Ship).
 *
 * This is an original box-geometry interpretation of a well-known layout, not
 * extracted assets: the shape below is authored from the map's documented
 * structure - spawns in the bow and stern cabins, three main lanes running the
 * length of the deck, a narrow flanking catwalk down each side, and container
 * stacks you climb to see into the enemy spawn.
 *
 * One deliberate departure: the original has below-deck passages, and this
 * engine's navigation drops a grid onto the highest surface, so a tunnel under
 * the deck would never receive waypoints. The side catwalks carry the same
 * tactical role - a quiet route that bypasses the middle.
 */
import {
  type BoxSpec,
  type GameMap,
  TEAM_BLUE,
  TEAM_RED,
  box,
  defineMap,
  spawnLine,
} from '../map-types';

/**
 * The ship runs along Z. Every rise a player has to climb is 0.8 m, which is
 * over STEP_HEIGHT but inside a standing jump, so stacks are climbed rather
 * than walked - and the nav graph marks those links as jumps for the bots.
 */
const SPECS: BoxSpec[] = [
  // Deck, hull sides and the bow/stern bulkheads.
  box(0, -1, 0, 48, 2, 104, 'floor'),
  box(-23, 4, 0, 2, 8, 104, 'wall', { x: true }),
  box(0, 4, -51, 48, 8, 2, 'wall', { z: true }),

  // Lane dividers: two container rows running the length at x = +-8, broken by
  // three crossings a side so the lanes are connected without being open.
  box(-8, 1.3, -34, 2.6, 2.6, 14, 'crate', { z: true, x: true }),
  box(-8, 1.3, -12, 2.6, 2.6, 14, 'crate', { z: true, x: true }),

  // The flank catwalks: a wall at x = +-16 with two openings a side, leaving a
  // six-metre lane hugging the hull.
  box(-16, 1.6, -30, 1.2, 3.2, 22, 'wall', { z: true, x: true }),
  box(-16, 1.6, 0, 1.2, 3.2, 16, 'wall', { x: true }),

  // Climbable stacks near mid. Crate, container, high container: three 0.8 m
  // hops to a perch that looks straight down the outer lane.
  box(-12, 0.4, -4, 2.4, 0.8, 2.4, 'crate', { x: true }),
  box(-12, 0.8, -1.4, 2.6, 1.6, 2.6, 'crate', { x: true }),
  box(-12, 1.2, 2, 2.8, 2.4, 4, 'crate', { x: true }),

  // Middle lane: the central contest, and blockers so it is not one long lane.
  box(0, 0.8, 0, 6, 1.6, 3, 'crate'),
  box(0, 1.2, -16, 3.2, 2.4, 6, 'crate', { z: true }),
  box(-3.4, 0.6, -24, 2.4, 1.2, 2.4, 'crate', { z: true, x: true }),

  // Outer lanes: staggered cover between the divider and the flank wall.
  box(-12, 0.9, -22, 3, 1.8, 3, 'crate', { z: true, x: true }),
  box(-12, 1.3, -36, 2.6, 2.6, 5, 'crate', { z: true, x: true }),

  // The crate beside each spawn that both sides have to pass.
  box(-13, 0.75, -44, 3, 1.5, 3, 'crate', { z: true, x: true }),
  box(0, 1.4, -42, 7, 2.8, 1.2, 'wall', { z: true }),

  // Deck pipes running overhead: they break long sightlines from the stacks
  // without ever blocking a player, since they sit above head height.
  box(-20, 3.1, 0, 1, 1, 84, 'accent', { x: true }),
  box(0, 3.4, -30, 30, 0.8, 0.8, 'accent', { z: true }),
];

export const CARGO_MAP: GameMap = defineMap({
  id: 'cargo',
  name: 'cs_cargo',
  label: 'Transport Ship',
  specs: SPECS,
  spawns: [
    ...spawnLine(TEAM_RED, -46, Math.PI, [-19, -11, 0, 11, 19]),
    ...spawnLine(TEAM_BLUE, 46, 0, [-19, -11, 0, 11, 19]),
  ],
  bounds: { minX: -22, maxX: 22, minZ: -50, maxZ: 50 },
  // Steel and open water at dusk.
  skyColor: 0x101a26,
  fogColor: 0x16222f,
  fogNear: 44,
  fogFar: 132,
});

/**
 * `cs_grid` - a small, symmetric two-lane arena. The original test map: three
 * lanes, a raised central platform reached by walkable staircases, and mirrored
 * cover so neither side has an edge.
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

const SPECS: BoxSpec[] = [
  // Ground slab and the outer shell.
  box(0, -1, 0, 72, 2, 72, 'floor'),
  box(0, 3.5, -35.5, 72, 7, 1, 'wall', { z: true }),
  box(-35.5, 3.5, 0, 1, 7, 72, 'wall', { x: true }),

  // Lane dividers: two long walls with deliberate gaps at z = +-10.
  box(-12, 2, -22, 0.9, 4, 16, 'wall', { z: true, x: true }),
  box(-12, 2, 0, 0.9, 4, 12, 'wall', { x: true }),

  // Central raised platform plus its stepped approach from both spawn sides.
  box(0, 1, 0, 11, 2, 11, 'platform'),
  // A four-tread staircase up to the platform on each side. Every rise is
  // 0.4 m - under STEP_HEIGHT - so it is walked rather than jumped, and the
  // treads are two metres deep so a full-size player hull fits on each one
  // (which is also what lets the nav graph put a waypoint there).
  box(0, 0.2, -12.5, 6, 0.4, 2, 'crate', { z: true }),
  box(0, 0.4, -10.5, 6, 0.8, 2, 'crate', { z: true }),
  box(0, 0.6, -8.5, 6, 1.2, 2, 'crate', { z: true }),
  box(0, 0.8, -6.5, 6, 1.6, 2, 'crate', { z: true }),
  box(-6.4, 1.3, 0, 1.4, 2.6, 5, 'accent', { x: true }),

  // Mid-lane cover.
  box(-6, 0.6, -16, 2.6, 1.2, 2.6, 'crate', { z: true, x: true }),
  box(0, 1.4, -20, 4, 2.8, 1.2, 'wall', { z: true }),

  // Outer-lane cover.
  box(-20, 0.75, -12, 3.2, 1.5, 3.2, 'crate', { z: true, x: true }),
  box(-26, 1, -4, 4.4, 2, 3.2, 'crate', { z: true, x: true }),
  box(-18, 1.6, 3, 2, 3.2, 6, 'accent', { x: true }),
  box(-29, 1.2, -20, 2.4, 2.4, 2.4, 'crate', { z: true, x: true }),

  // Spawn-side sight blockers.
  box(-9, 1.5, -28, 9, 3, 0.9, 'wall', { z: true, x: true }),
  box(0, 0.5, -31, 6, 1, 1, 'crate', { z: true }),
];

export const GRID_MAP: GameMap = defineMap({
  id: 'grid',
  name: 'cs_grid',
  label: 'Grid',
  specs: SPECS,
  spawns: [
    ...spawnLine(TEAM_RED, -31.5, Math.PI, [-24, -17, -4, 4, 17, 24]),
    ...spawnLine(TEAM_BLUE, 31.5, 0, [-24, -17, -4, 4, 17, 24]),
  ],
  bounds: { minX: -35, maxX: 35, minZ: -35, maxZ: 35 },
  skyColor: 0x0e1622,
  fogColor: 0x121b28,
  fogNear: 34,
  fogFar: 96,
});

/**
 * `cs_grid` - a small, symmetric two-lane arena. The map is authored as boxes
 * so that the exact same geometry drives server collision and client rendering.
 */
import { type Brush, makeBrush } from './collision';
import { type Vec3, vec3 } from './math';

export type SurfaceKind = 'floor' | 'wall' | 'crate' | 'platform' | 'accent';

export interface MapSolid {
  readonly brush: Brush;
  readonly kind: SurfaceKind;
}

export type TeamId = 0 | 1;
export const TEAM_RED: TeamId = 0;
export const TEAM_BLUE: TeamId = 1;

export const TEAM_NAMES: Record<TeamId, string> = { 0: 'Raiders', 1: 'Sentinels' };
/** Rendering colors, also used by the HUD. */
export const TEAM_COLORS: Record<TeamId, number> = { 0: 0xff6b4a, 1: 0x4aa8ff };

export interface SpawnPoint {
  readonly pos: Vec3;
  readonly yaw: number;
  readonly team: TeamId;
}

export interface GameMap {
  readonly name: string;
  readonly solids: readonly MapSolid[];
  readonly brushes: readonly Brush[];
  readonly spawns: readonly SpawnPoint[];
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  readonly skyColor: number;
  readonly fogColor: number;
}

interface BoxSpec {
  cx: number;
  cy: number;
  cz: number;
  sx: number;
  sy: number;
  sz: number;
  kind: SurfaceKind;
  /** Also emit a copy mirrored across the Z axis (the map's line of symmetry). */
  mirrorZ?: boolean;
  /** Also emit a copy mirrored across the X axis. */
  mirrorX?: boolean;
}

function box(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  kind: SurfaceKind,
  mirror: { z?: boolean; x?: boolean } = {},
): BoxSpec {
  return { cx, cy, cz, sx, sy, sz, kind, mirrorZ: mirror.z, mirrorX: mirror.x };
}

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

function expand(specs: readonly BoxSpec[]): MapSolid[] {
  const out: MapSolid[] = [];
  const seen = new Set<string>();

  const emit = (cx: number, cy: number, cz: number, s: BoxSpec) => {
    const key = `${cx},${cy},${cz},${s.sx},${s.sy},${s.sz}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind: s.kind,
      brush: makeBrush(
        cx - s.sx / 2,
        cy - s.sy / 2,
        cz - s.sz / 2,
        cx + s.sx / 2,
        cy + s.sy / 2,
        cz + s.sz / 2,
      ),
    });
  };

  for (const s of specs) {
    emit(s.cx, s.cy, s.cz, s);
    if (s.mirrorZ) emit(s.cx, s.cy, -s.cz, s);
    if (s.mirrorX) emit(-s.cx, s.cy, s.cz, s);
    if (s.mirrorX && s.mirrorZ) emit(-s.cx, s.cy, -s.cz, s);
  }
  return out;
}

function buildSpawns(): SpawnPoint[] {
  const spawns: SpawnPoint[] = [];
  const lanes = [-24, -17, -4, 4, 17, 24];
  for (const x of lanes) {
    // Red starts on -Z looking toward +Z; blue mirrors it.
    spawns.push({ pos: vec3(x, 0.05, -31.5), yaw: Math.PI, team: TEAM_RED });
    spawns.push({ pos: vec3(x, 0.05, 31.5), yaw: 0, team: TEAM_BLUE });
  }
  return spawns;
}

const solids = expand(SPECS);

export const GAME_MAP: GameMap = {
  name: 'cs_grid',
  solids,
  brushes: solids.map((s) => s.brush),
  spawns: buildSpawns(),
  bounds: { minX: -35, maxX: 35, minZ: -35, maxZ: 35 },
  skyColor: 0x0e1622,
  fogColor: 0x121b28,
};

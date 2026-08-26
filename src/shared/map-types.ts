/**
 * Map authoring primitives.
 *
 * A map is nothing but a list of axis-aligned boxes plus spawn points: the same
 * brushes the server collides and hitscans against are what the client renders,
 * so what you see is exactly what you can walk into and shoot through.
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
  /** Stable identifier used on the wire and in the map picker. */
  readonly id: string;
  readonly name: string;
  /** Human-facing name for the UI. */
  readonly label: string;
  readonly solids: readonly MapSolid[];
  readonly brushes: readonly Brush[];
  readonly spawns: readonly SpawnPoint[];
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  readonly skyColor: number;
  readonly fogColor: number;
  /** Distance at which fog starts and becomes opaque, tuned per map. */
  readonly fogNear: number;
  readonly fogFar: number;
}

export interface BoxSpec {
  cx: number;
  cy: number;
  cz: number;
  sx: number;
  sy: number;
  sz: number;
  kind: SurfaceKind;
  /** Also emit a copy mirrored across the Z axis. */
  mirrorZ?: boolean;
  /** Also emit a copy mirrored across the X axis. */
  mirrorX?: boolean;
}

export function box(
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

/** Expand the authored specs, applying mirroring and dropping duplicates. */
export function expand(specs: readonly BoxSpec[]): MapSolid[] {
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

export interface MapDefinition {
  id: string;
  name: string;
  label: string;
  specs: readonly BoxSpec[];
  spawns: readonly SpawnPoint[];
  bounds: GameMap['bounds'];
  skyColor: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
}

export function defineMap(def: MapDefinition): GameMap {
  const solids = expand(def.specs);
  return {
    id: def.id,
    name: def.name,
    label: def.label,
    solids,
    brushes: solids.map((s) => s.brush),
    spawns: def.spawns,
    bounds: def.bounds,
    skyColor: def.skyColor,
    fogColor: def.fogColor,
    fogNear: def.fogNear,
    fogFar: def.fogFar,
  };
}

/** Spawn points strung along a line, all facing the same way. */
export function spawnLine(
  team: TeamId,
  z: number,
  yaw: number,
  xs: readonly number[],
  y = 0.05,
): SpawnPoint[] {
  return xs.map((x) => ({ pos: vec3(x, y, z), yaw, team }));
}

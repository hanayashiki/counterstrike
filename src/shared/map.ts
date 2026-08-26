import type { GameMap } from './map-types';
/**
 * The map registry. Everything that used to import a single `GAME_MAP` still
 * works - `GAME_MAP` is the default map - but the world now takes whichever map
 * the room is running.
 */
import { CARGO_MAP } from './maps/cargo';
import { GRID_MAP } from './maps/grid';

export * from './map-types';

export const MAPS: readonly GameMap[] = [GRID_MAP, CARGO_MAP];
export const MAP_IDS: readonly string[] = MAPS.map((m) => m.id);
export const DEFAULT_MAP_ID = GRID_MAP.id;

export function getMap(id: string): GameMap {
  return MAPS.find((m) => m.id === id) ?? GRID_MAP;
}

/** Index form, for the wire. */
export const mapIndex = (id: string): number => Math.max(0, MAP_IDS.indexOf(id));
export const mapFromIndex = (index: number): GameMap => MAPS[index] ?? GRID_MAP;

/** The default map, kept for callers that do not care which one is loaded. */
export const GAME_MAP: GameMap = GRID_MAP;

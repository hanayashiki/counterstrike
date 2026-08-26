import { type Brush, type RayHit, hullOverlapsWorld, raycastWorld } from './collision';
/**
 * Navigation graph for bots. Rather than hand-authoring waypoints, we sample a
 * grid over the map, drop each sample onto the floor, keep the spots where a
 * player hull actually fits, and link neighbours whose connecting path is
 * walkable. Rebuilding is cheap enough to do at server start-up.
 */
import { PLAYER_HEIGHT, PLAYER_RADIUS, STEP_HEIGHT } from './config';
import type { GameMap } from './map';
import { type Vec3, distance2D, vec3 } from './math';

export interface NavLink {
  to: number;
  cost: number;
  /** Bots must jump to traverse this link. */
  jump: boolean;
}

export interface NavNode {
  id: number;
  pos: Vec3;
  links: NavLink[];
  /** Grid coordinates, handy for debugging. */
  gx: number;
  gz: number;
}

/**
 * Waypoint spacing. Two metres is fine enough to resolve the map's stairs and
 * cover, while keeping the build under ~50 ms at server start-up.
 */
const GRID_SPACING = 2;
const MAX_LINK_CELLS = 2;
/**
 * A standing jump peaks at JUMP_SPEED^2 / (2 * GRAVITY) ~= 1.18 m, so keep the
 * limit comfortably under that - a bot jumping while moving clears less.
 */
const MAX_JUMP_RISE = 1.05;
const CLEARANCE_HEIGHT = 1.5;
const CLEARANCE_RADIUS = PLAYER_RADIUS * 1.05;

const downDir: Vec3 = { x: 0, y: -1, z: 0 };
const rayHit: RayHit = { t: 0, nx: 0, ny: 0, nz: 0, brush: null };

/** Height of the floor under `(x, z)`, or null if there is nothing to stand on. */
function floorHeight(brushes: readonly Brush[], x: number, z: number): number | null {
  const origin = vec3(x, 40, z);
  if (!raycastWorld(brushes, origin, downDir, 80, rayHit)) return null;
  return 40 - rayHit.t;
}

/** Sample along a straight line and make sure a player hull fits the whole way. */
function pathIsClear(brushes: readonly Brush[], from: Vec3, to: Vec3): boolean {
  const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.max(2, Math.ceil(dist / 0.45));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const z = from.z + (to.z - from.z) * t;
    if (hullOverlapsWorld(x, y + 0.06, z, CLEARANCE_RADIUS, CLEARANCE_HEIGHT, brushes))
      return false;
  }
  return true;
}

const traverseFrom: Vec3 = { x: 0, y: 0, z: 0 };
const traverseTo: Vec3 = { x: 0, y: 0, z: 0 };

const hasHeadroom = (brushes: readonly Brush[], at: Vec3): boolean =>
  !hullOverlapsWorld(at.x, at.y + 0.06, at.z, CLEARANCE_RADIUS, CLEARANCE_HEIGHT, brushes);

/**
 * Can a player actually get from `from` to `to`?
 *
 * Interpolating straight between two waypoints at different heights cuts
 * through the very step the player would climb, which would reject every
 * legitimate step-up. So model what a player really does: rise to the higher of
 * the two heights, cross, then drop - i.e. check the horizontal traverse at the
 * apex rather than along the diagonal.
 */
function linkIsTraversable(brushes: readonly Brush[], from: Vec3, to: Vec3): boolean {
  const apex = Math.max(from.y, to.y);
  traverseFrom.x = from.x;
  traverseFrom.y = apex;
  traverseFrom.z = from.z;
  traverseTo.x = to.x;
  traverseTo.y = apex;
  traverseTo.z = to.z;

  // There has to be headroom directly above both ends before crossing.
  if (!hasHeadroom(brushes, traverseFrom) || !hasHeadroom(brushes, traverseTo)) return false;
  return pathIsClear(brushes, traverseFrom, traverseTo);
}

export class NavGraph {
  readonly nodes: NavNode[] = [];

  private constructor(readonly map: GameMap) {}

  static build(map: GameMap): NavGraph {
    const graph = new NavGraph(map);
    const { brushes, bounds } = map;

    const cols = Math.floor((bounds.maxX - bounds.minX) / GRID_SPACING) + 1;
    const rows = Math.floor((bounds.maxZ - bounds.minZ) / GRID_SPACING) + 1;
    /** grid index -> node id, or -1 */
    const cells = new Int32Array(cols * rows).fill(-1);

    for (let gz = 0; gz < rows; gz++) {
      for (let gx = 0; gx < cols; gx++) {
        const x = bounds.minX + gx * GRID_SPACING;
        const z = bounds.minZ + gz * GRID_SPACING;
        const y = floorHeight(brushes, x, z);
        if (y === null || y < -0.5 || y > 12) continue;
        if (hullOverlapsWorld(x, y + 0.05, z, PLAYER_RADIUS, PLAYER_HEIGHT, brushes)) continue;

        const id = graph.nodes.length;
        cells[gz * cols + gx] = id;
        graph.nodes.push({ id, pos: vec3(x, y + 0.02, z), links: [], gx, gz });
      }
    }

    for (const node of graph.nodes) {
      for (let dz = -MAX_LINK_CELLS; dz <= MAX_LINK_CELLS; dz++) {
        for (let dx = -MAX_LINK_CELLS; dx <= MAX_LINK_CELLS; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = node.gx + dx;
          const nz = node.gz + dz;
          if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
          const otherId = cells[nz * cols + nx] ?? -1;
          if (otherId < 0) continue;
          const other = graph.nodes[otherId] as NavNode;

          const rise = other.pos.y - node.pos.y;
          const flat = distance2D(node.pos, other.pos);
          if (rise > MAX_JUMP_RISE) continue;
          if (rise < -6) continue; // too far to drop safely

          const jump = rise > STEP_HEIGHT;
          if (jump && flat > 3.2) continue;
          if (!linkIsTraversable(brushes, node.pos, other.pos)) continue;

          const cost = flat + Math.abs(rise) * 1.5 + (jump ? 2 : 0);
          node.links.push({ to: otherId, cost, jump });
        }
      }
    }

    graph.keepReachableFromSpawns();
    return graph;
  }

  /**
   * Keep only the waypoints a player can actually get to from a spawn.
   *
   * The grid also lands on surfaces nobody can reach - the tops of the
   * perimeter walls, for instance. Those are not merely isolated: a wall top
   * links *downward* into the map, because a drop is traversable even when the
   * matching climb is not. So "largest connected component" is the wrong test,
   * since reachability here is directional; flooding forward from the spawns is
   * the question actually being asked. One-way ledges you can drop off but not
   * climb back onto are legitimate, and survive.
   */
  private keepReachableFromSpawns(): void {
    if (this.nodes.length === 0) return;

    const reached = new Uint8Array(this.nodes.length);
    const stack: number[] = [];
    for (const spawn of this.map.spawns) {
      const start = this.nearest(spawn.pos);
      if (start >= 0 && !reached[start]) {
        reached[start] = 1;
        stack.push(start);
      }
    }
    if (stack.length === 0) return;

    while (stack.length > 0) {
      const current = stack.pop() as number;
      for (const link of (this.nodes[current] as NavNode).links) {
        if (reached[link.to]) continue;
        reached[link.to] = 1;
        stack.push(link.to);
      }
    }

    const keep = this.nodes.filter((node) => reached[node.id]);
    if (keep.length === this.nodes.length) return;

    const remap = new Map<number, number>();
    for (const [index, node] of keep.entries()) remap.set(node.id, index);

    for (const node of keep) {
      node.id = remap.get(node.id) as number;
      const remapped: NavLink[] = [];
      for (const link of node.links) {
        const to = remap.get(link.to);
        if (to !== undefined) remapped.push({ to, cost: link.cost, jump: link.jump });
      }
      node.links = remapped;
    }

    this.nodes.length = 0;
    this.nodes.push(...keep);
  }

  get linkCount(): number {
    let n = 0;
    for (const node of this.nodes) n += node.links.length;
    return n;
  }

  nearest(pos: Vec3, maxDist = 24): number {
    let best = -1;
    let bestDist = maxDist * maxDist;
    for (const node of this.nodes) {
      const dx = node.pos.x - pos.x;
      const dy = (node.pos.y - pos.y) * 2; // weight vertical error
      const dz = node.pos.z - pos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = node.id;
      }
    }
    return best;
  }

  /**
   * A* over the waypoint graph. Returns node ids from `start` to `goal`
   * inclusive, or an empty array when unreachable.
   */
  findPath(start: number, goal: number): number[] {
    const count = this.nodes.length;
    if (start < 0 || goal < 0 || start >= count || goal >= count) return [];
    if (start === goal) return [start];

    const gScore = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
    const fScore = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
    const cameFrom = new Int32Array(count).fill(-1);
    const closed = new Uint8Array(count);
    const goalNode = this.nodes[goal] as NavNode;

    const heuristic = (id: number): number => {
      const n = this.nodes[id] as NavNode;
      return Math.hypot(
        n.pos.x - goalNode.pos.x,
        n.pos.y - goalNode.pos.y,
        n.pos.z - goalNode.pos.z,
      );
    };

    gScore[start] = 0;
    fScore[start] = heuristic(start);
    const open: number[] = [start];

    while (open.length > 0) {
      // Small graph: a linear scan beats the constant factor of a real heap.
      let bestIndex = 0;
      for (let i = 1; i < open.length; i++) {
        if ((fScore[open[i] as number] as number) < (fScore[open[bestIndex] as number] as number)) {
          bestIndex = i;
        }
      }
      const current = open.splice(bestIndex, 1)[0] as number;
      if (current === goal) {
        const path: number[] = [];
        for (let at = goal; at !== -1; at = cameFrom[at] as number) path.push(at);
        return path.toReversed();
      }
      closed[current] = 1;

      for (const link of (this.nodes[current] as NavNode).links) {
        if (closed[link.to]) continue;
        const tentative = (gScore[current] as number) + link.cost;
        if (tentative >= (gScore[link.to] as number)) continue;
        cameFrom[link.to] = current;
        gScore[link.to] = tentative;
        fScore[link.to] = tentative + heuristic(link.to);
        if (!open.includes(link.to)) open.push(link.to);
      }
    }
    return [];
  }

  /** Was this link marked as requiring a jump? */
  linkRequiresJump(from: number, to: number): boolean {
    const node = this.nodes[from];
    if (!node) return false;
    for (const link of node.links) if (link.to === to) return link.jump;
    return false;
  }
}

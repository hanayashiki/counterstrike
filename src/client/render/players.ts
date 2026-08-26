/**
 * Remote player avatars and entity interpolation.
 *
 * Snapshots arrive 32 times a second; we buffer them and render every remote
 * player `INTERP_DELAY_MS` in the past, interpolating between the two
 * surrounding samples. That is what makes other players move smoothly instead
 * of teleporting once per snapshot.
 */
import * as THREE from 'three';

import { type CharacterDef, characterForId, getCharacter } from '../../shared/characters';
import {
  INTERP_DELAY_MS,
  LEAN_DISTANCE,
  LEAN_DROP,
  LEAN_ROLL,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
} from '../../shared/config';
import { TEAM_COLORS, type TeamId } from '../../shared/map';
import { wrapAngle } from '../../shared/math';
import { type EntitySnapshot, PF_ALIVE, PF_CROUCH, PF_TEAM_BLUE } from '../../shared/protocol';
import { getWeapon } from '../../shared/weapons';
import { cloneWeaponModel } from './weapon-model';

interface Sample {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  height: number;
  alive: boolean;
  crouching: boolean;
  lean: number;
}

const BUFFER_LIMIT = 24;
const SUIT = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.72, metalness: 0.15 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.85, metalness: 0.1 });
const HAIR = new THREE.MeshStandardMaterial({ color: 0x241c18, roughness: 0.88, metalness: 0.05 });

export class RemotePlayer {
  readonly root = new THREE.Group();
  private readonly hips = new THREE.Group();
  private readonly upper = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly hair = new THREE.Group();
  private readonly legL: THREE.Mesh;
  private readonly legR: THREE.Mesh;
  private readonly teamMaterial: THREE.MeshStandardMaterial;
  private weaponRoot: THREE.Group | null = null;
  private weaponId = -1;

  private readonly samples: Sample[] = [];
  private stride = 0;
  private lastX = 0;
  private lastZ = 0;
  private hairSway = 0;

  alive = false;
  team: TeamId = 0;
  readonly character: CharacterDef;

  constructor(
    readonly id: number,
    team: TeamId,
    characterId: number,
    private readonly scene: THREE.Scene,
  ) {
    this.team = team;
    this.character = getCharacter(characterId);
    const c = this.character;

    this.teamMaterial = new THREE.MeshStandardMaterial({
      color: TEAM_COLORS[team],
      roughness: 0.55,
      metalness: 0.2,
      emissive: new THREE.Color(TEAM_COLORS[team]).multiplyScalar(0.16),
    });

    // Legs hang from the hip origin so scaling them crouches the figure.
    const legGeometry = new THREE.BoxGeometry(c.legWidth, 0.86, c.legWidth * 1.18);
    legGeometry.translate(0, -0.43, 0);
    this.legL = new THREE.Mesh(legGeometry, DARK);
    this.legR = new THREE.Mesh(legGeometry, DARK);
    this.legL.position.set(-c.legSpacing, 0, 0);
    this.legR.position.set(c.legSpacing, 0, 0);
    this.legL.castShadow = true;
    this.legR.castShadow = true;
    this.hips.add(this.legL, this.legR);

    // Hips, waist and chest as three stacked slabs. On an athletic build the
    // waist is narrower than both, which is the whole silhouette.
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(c.hipWidth, 0.2, c.chestDepth), SUIT);
    pelvis.position.y = 0.1;
    pelvis.castShadow = true;
    this.upper.add(pelvis);

    const waist = new THREE.Mesh(
      new THREE.BoxGeometry(c.waistWidth, 0.2, c.chestDepth * 0.9),
      SUIT,
    );
    waist.position.y = 0.29;
    waist.castShadow = true;
    this.upper.add(waist);

    const chest = new THREE.Mesh(new THREE.BoxGeometry(c.chestWidth, 0.26, c.chestDepth), SUIT);
    chest.position.y = 0.5;
    chest.castShadow = true;
    this.upper.add(chest);

    // Team-coloured shoulder plates: the strongest read at distance.
    const shoulders = new THREE.Mesh(
      new THREE.BoxGeometry(c.shoulderWidth, 0.11, c.chestDepth * 1.08),
      this.teamMaterial,
    );
    shoulders.position.y = 0.66;
    shoulders.castShadow = true;
    this.upper.add(shoulders);

    const headMesh = new THREE.Mesh(
      new THREE.BoxGeometry(c.headWidth, c.headWidth, c.headWidth),
      SUIT,
    );
    headMesh.castShadow = true;
    this.head.add(headMesh);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(c.headWidth * 0.8, 0.075, 0.02),
      this.teamMaterial,
    );
    visor.position.set(0, 0.02, -c.headWidth / 2 - 0.005);
    this.head.add(visor);

    this.buildHair(c);
    this.head.add(this.hair);
    this.head.position.y = 0.86;
    this.upper.add(this.head);

    const armGeometry = new THREE.BoxGeometry(c.armWidth, 0.42, c.armWidth * 1.1);
    armGeometry.translate(0, -0.21, 0);
    const armL = new THREE.Mesh(armGeometry, SUIT);
    const armR = new THREE.Mesh(armGeometry, SUIT);
    armL.position.set(-(c.shoulderWidth / 2 + c.armWidth * 0.1), 0.63, 0);
    armR.position.set(c.shoulderWidth / 2 + c.armWidth * 0.1, 0.63, 0);
    armL.rotation.x = -0.9;
    armR.rotation.x = -1.1;
    armL.castShadow = true;
    armR.castShadow = true;
    this.upper.add(armL, armR);

    this.upper.position.y = 0.86;
    this.root.add(this.hips, this.upper);
    this.root.position.y = PLAYER_HEIGHT * 0.5;
    scene.add(this.root);
  }

  private buildHair(c: CharacterDef): void {
    if (c.hair === 'none') return;
    const half = c.headWidth / 2;

    if (c.hair === 'ponytail') {
      // A crown cap plus a tail that trails behind and swings when running.
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(c.headWidth * 1.04, c.headWidth * 0.42, c.headWidth * 1.04),
        HAIR,
      );
      cap.position.set(0, half * 0.62, 0.004);
      cap.castShadow = true;
      this.hair.add(cap);

      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.3, 0.062), HAIR);
      tail.geometry.translate(0, -0.15, 0);
      tail.position.set(0, half * 0.5, half * 0.92);
      tail.rotation.x = -0.42;
      tail.castShadow = true;
      tail.name = 'tail';
      this.hair.add(tail);
      return;
    }

    // Bun: a low cap and a rounded knot at the back of the head.
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(c.headWidth * 1.04, c.headWidth * 0.4, c.headWidth * 1.04),
      HAIR,
    );
    cap.position.set(0, half * 0.64, 0.004);
    cap.castShadow = true;
    this.hair.add(cap);

    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.052, 10, 8), HAIR);
    knot.position.set(0, half * 0.5, half * 0.98);
    knot.castShadow = true;
    this.hair.add(knot);
  }

  setTeam(team: TeamId): void {
    if (this.team === team) return;
    this.team = team;
    this.teamMaterial.color.setHex(TEAM_COLORS[team]);
    this.teamMaterial.emissive.setHex(TEAM_COLORS[team]).multiplyScalar(0.16);
  }

  private setWeapon(weaponId: number): void {
    if (this.weaponId === weaponId) return;
    this.weaponId = weaponId;
    if (this.weaponRoot) {
      this.upper.remove(this.weaponRoot);
      this.weaponRoot = null;
    }
    const model = cloneWeaponModel(getWeapon(weaponId));
    model.root.position.set(0.16, 0.46, -0.24);
    model.root.rotation.set(0, 0, 0);
    this.weaponRoot = model.root;
    this.upper.add(model.root);
  }

  push(entity: EntitySnapshot, time: number): void {
    const alive = (entity.flags & PF_ALIVE) !== 0;
    this.alive = alive;
    this.setTeam(((entity.flags & PF_TEAM_BLUE) !== 0 ? 1 : 0) as TeamId);
    this.setWeapon(entity.weapon);

    const sample: Sample = {
      time,
      x: entity.x,
      y: entity.y,
      z: entity.z,
      yaw: entity.yaw,
      pitch: entity.pitch,
      height: entity.heightCm / 100,
      alive,
      crouching: (entity.flags & PF_CROUCH) !== 0,
      lean: entity.lean,
    };

    const last = this.samples.at(-1);
    if (last) {
      // Keep yaw continuous so interpolation never spins the long way round.
      sample.yaw = last.yaw + wrapAngle(sample.yaw - last.yaw);
    }
    this.samples.push(sample);
    if (this.samples.length > BUFFER_LIMIT) this.samples.shift();
  }

  /** Render this player as they were at `renderTime` on the server clock. */
  update(renderTime: number, dt: number): void {
    const samples = this.samples;
    if (samples.length === 0) {
      this.root.visible = false;
      return;
    }

    let a = samples[0] as Sample;
    let b = samples[0] as Sample;
    for (let i = samples.length - 1; i >= 0; i--) {
      const sample = samples[i] as Sample;
      if (sample.time <= renderTime) {
        a = sample;
        b = (samples[i + 1] as Sample | undefined) ?? sample;
        break;
      }
      a = sample;
      b = sample;
    }

    const span = b.time - a.time;
    const t = span > 1e-3 ? Math.min(1, Math.max(0, (renderTime - a.time) / span)) : 0;

    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    const yaw = a.yaw + (b.yaw - a.yaw) * t;
    const pitch = a.pitch + (b.pitch - a.pitch) * t;
    const height = a.height + (b.height - a.height) * t;
    const lean = a.lean + (b.lean - a.lean) * t;

    this.root.visible = a.alive;
    if (!a.alive) return;

    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;

    // Squash the model toward the reported hull height when crouching.
    const scale = height / PLAYER_HEIGHT;
    this.hips.scale.y = scale;
    this.hips.position.y = 0.86 * scale;
    // The torso leans out while the feet stay put - so a peeking opponent
    // shows exactly the sliver of body that their own camera has bought them.
    this.upper.position.x = lean * LEAN_DISTANCE;
    this.upper.position.y = 0.86 * scale - Math.abs(lean) * LEAN_DROP;
    this.upper.rotation.z = -lean * LEAN_ROLL * 1.8;
    this.head.rotation.x = -pitch * 0.55;
    if (this.weaponRoot) this.weaponRoot.rotation.x = -pitch;

    // Walk cycle driven by measured ground speed.
    const speed = Math.hypot(x - this.lastX, z - this.lastZ) / Math.max(dt, 1e-3);
    this.lastX = x;
    this.lastZ = z;
    this.stride += speed * dt * 3.6;
    const swing = Math.sin(this.stride) * Math.min(0.7, speed * 0.11);
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;

    // The ponytail lags behind the run cycle rather than tracking it exactly.
    const tail = this.hair.getObjectByName('tail');
    if (tail) {
      const target = -0.42 - Math.sin(this.stride * 0.5) * Math.min(0.34, speed * 0.06);
      this.hairSway += (target - this.hairSway) * Math.min(1, dt * 9);
      tail.rotation.x = this.hairSway;
    }
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    this.teamMaterial.dispose();
  }
}

export class PlayerManager {
  private readonly players = new Map<number, RemotePlayer>();
  /**
   * Characters arrive on PlayerInfo, which the server always flushes before the
   * snapshot that first mentions a player — so by the time we build an avatar
   * we normally know which model to use. The fallback keeps a stable look if
   * that ordering ever changes.
   */
  private readonly characters = new Map<number, number>();

  constructor(private readonly scene: THREE.Scene) {}

  get all(): IterableIterator<RemotePlayer> {
    return this.players.values();
  }

  get(id: number): RemotePlayer | undefined {
    return this.players.get(id);
  }

  /** Note the model a player picked; rebuild the avatar if it changed. */
  setCharacter(id: number, characterId: number): void {
    if (this.characters.get(id) === characterId) return;
    this.characters.set(id, characterId);
    const existing = this.players.get(id);
    if (existing && existing.character.id !== characterId) {
      existing.dispose();
      this.players.delete(id);
    }
  }

  ingest(entities: readonly EntitySnapshot[], serverTimeMs: number): void {
    for (const entity of entities) {
      let player = this.players.get(entity.id);
      if (!player) {
        const team = ((entity.flags & PF_TEAM_BLUE) !== 0 ? 1 : 0) as TeamId;
        const characterId = this.characters.get(entity.id) ?? characterForId(entity.id);
        player = new RemotePlayer(entity.id, team, characterId, this.scene);
        this.players.set(entity.id, player);
      }
      player.push(entity, serverTimeMs);
    }
  }

  update(serverNowMs: number, dt: number): void {
    const renderTime = serverNowMs - INTERP_DELAY_MS;
    for (const player of this.players.values()) player.update(renderTime, dt);
  }

  remove(id: number): void {
    this.characters.delete(id);
    const player = this.players.get(id);
    if (!player) return;
    player.dispose();
    this.players.delete(id);
  }

  clear(): void {
    for (const player of this.players.values()) player.dispose();
    this.players.clear();
    this.characters.clear();
  }

  /**
   * Nearest visible enemy the crosshair is over, used to tint the reticle.
   * Purely cosmetic: it only ever considers players the server already told us
   * about and that are on screen.
   */
  crosshairTarget(origin: THREE.Vector3, direction: THREE.Vector3, myTeam: TeamId): boolean {
    const box = new THREE.Box3();
    const ray = new THREE.Ray(origin, direction);
    for (const player of this.players.values()) {
      if (!player.alive || player.team === myTeam) continue;
      const p = player.root.position;
      box.min.set(p.x - PLAYER_RADIUS, p.y, p.z - PLAYER_RADIUS);
      box.max.set(p.x + PLAYER_RADIUS, p.y + PLAYER_HEIGHT, p.z + PLAYER_RADIUS);
      if (ray.intersectsBox(box)) return true;
    }
    return false;
  }
}

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
  LEAN_ROLL,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
} from '../../shared/config';
import { TEAM_COLORS, type TeamId } from '../../shared/map';
import { wrapAngle } from '../../shared/math';
import { type EntitySnapshot, PF_ALIVE, PF_CROUCH, PF_TEAM_BLUE } from '../../shared/protocol';
import { getWeapon } from '../../shared/weapons';
import { type Figure, buildFigure } from './figure';
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

export class RemotePlayer {
  readonly root = new THREE.Group();
  private readonly figure: Figure;
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
    this.figure = buildFigure(this.character, TEAM_COLORS[team]);
    this.root.add(this.figure.root);
    scene.add(this.root);
  }

  setTeam(team: TeamId): void {
    if (this.team === team) return;
    this.team = team;
    for (const material of this.figure.teamMaterials) {
      material.color.setHex(TEAM_COLORS[team]);
      material.emissive.setHex(TEAM_COLORS[team]).multiplyScalar(0.15);
    }
  }

  private setWeapon(weaponId: number): void {
    if (this.weaponId === weaponId) return;
    this.weaponId = weaponId;
    if (this.weaponRoot) {
      this.figure.grip.remove(this.weaponRoot);
      this.weaponRoot = null;
    }
    const model = cloneWeaponModel(getWeapon(weaponId));
    // Sat in the hand, then rotated so the barrel points where the figure faces.
    model.root.position.set(0, -0.02, -0.12);
    model.root.rotation.set(1.62, 0, 0);
    this.weaponRoot = model.root;
    this.figure.grip.add(model.root);
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

    const figure = this.figure;

    // Crouching squashes the whole figure toward the reported hull height,
    // which keeps the model inside the hitbox the server is using.
    const scale = height / PLAYER_HEIGHT;
    figure.root.scale.y = scale;

    // Lean slides the torso out past the feet and rolls it, so a peeking
    // opponent shows exactly the sliver of body their own camera bought them.
    figure.torso.position.x = lean * LEAN_DISTANCE;
    figure.torso.position.z = 0;
    figure.torso.rotation.z = -lean * LEAN_ROLL * 1.7;

    // The upper body carries the aim; the head adds a little more.
    figure.torso.rotation.x = -pitch * 0.35;
    figure.head.rotation.x = -pitch * 0.5;

    const speed = Math.hypot(x - this.lastX, z - this.lastZ) / Math.max(dt, 1e-3);
    this.lastX = x;
    this.lastZ = z;

    // Walk cycle. Thighs swing out of phase and the knee only bends on the
    // backswing, which is what stops it looking like scissors.
    this.stride += speed * dt * 3.4;
    const gait = Math.min(1, speed / 6.5);
    const swing = Math.sin(this.stride) * 0.72 * gait;
    figure.thighL.rotation.x = swing;
    figure.thighR.rotation.x = -swing;
    figure.shinL.rotation.x = -Math.max(0, -swing) * 1.25 - 0.05;
    figure.shinR.rotation.x = -Math.max(0, swing) * 1.25 - 0.05;

    // Arms counter-rotate a little, but stay on the weapon.
    figure.upperArmL.rotation.z = 0.34 - swing * 0.1;
    figure.upperArmR.rotation.z = -0.16 + swing * 0.1;

    // A running figure bobs and rolls slightly.
    figure.root.position.y = -Math.abs(Math.sin(this.stride)) * 0.035 * gait;
    figure.torso.rotation.y = Math.sin(this.stride) * 0.07 * gait;

    const tail = figure.hair.getObjectByName('tail');
    if (tail) {
      const target = -0.38 - Math.sin(this.stride * 0.5) * 0.3 * gait;
      this.hairSway += (target - this.hairSway) * Math.min(1, dt * 9);
      tail.rotation.x = this.hairSway;
    }
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.figure.dispose();
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

import { hasLineOfSight } from '../shared/collision';
/**
 * Bot brains. A bot is not a special kind of entity: it produces the exact same
 * `InputCommand` stream a human client sends, and the world simulates it
 * through the identical code path. That keeps bot movement honest (they cannot
 * outrun the movement code) and means anything that fixes players fixes bots.
 */
import {
  BTN_ADS,
  BTN_ATTACK,
  BTN_CROUCH,
  BTN_JUMP,
  BTN_RELOAD,
  BTN_WALK,
  PLAYER_RADIUS,
} from '../shared/config';
import {
  Rng,
  type Vec3,
  angleDelta,
  anglesFromForward,
  approachAngle,
  clamp,
  distance,
  distance2D,
  vec3,
} from '../shared/math';
import type { InputCommand } from '../shared/protocol';
import { WeaponId } from '../shared/weapons';
import type { Combatant } from './combatant';
import { type BotBrain, type BotSkill, type GameWorld, TICK_MS } from './world';

interface SkillProfile {
  /** Delay between seeing a target and being allowed to shoot. */
  reactionMinMs: number;
  reactionMaxMs: number;
  /** Standard deviation of the aim error cone, in radians. */
  aimJitter: number;
  /** Maximum turn rate while tracking, in radians per second. */
  turnSpeed: number;
  /** Extra turn rate allowed for the initial snap onto a new target. */
  snapSpeed: number;
  burstMin: number;
  burstMax: number;
  burstPauseMinMs: number;
  burstPauseMaxMs: number;
  visionRange: number;
  fovCos: number;
  /** Probability per decision of aiming for the head instead of the chest. */
  headshotBias: number;
  /** Probability of strafing while engaged. */
  strafeChance: number;
  /** Chance to hold still (better accuracy) while shooting. */
  disciplineChance: number;
  /** Reload once the magazine drops below this fraction. */
  reloadAt: number;
  /** Chance to crouch when holding an angle. */
  crouchChance: number;
}

const PROFILES: Record<BotSkill, SkillProfile> = {
  easy: {
    reactionMinMs: 380,
    reactionMaxMs: 640,
    aimJitter: 0.055,
    turnSpeed: 3.2,
    snapSpeed: 5,
    burstMin: 2,
    burstMax: 4,
    burstPauseMinMs: 400,
    burstPauseMaxMs: 900,
    visionRange: 42,
    fovCos: Math.cos((100 * Math.PI) / 180 / 2),
    headshotBias: 0.05,
    strafeChance: 0.25,
    disciplineChance: 0.3,
    reloadAt: 0.15,
    crouchChance: 0.1,
  },
  normal: {
    reactionMinMs: 220,
    reactionMaxMs: 380,
    aimJitter: 0.03,
    turnSpeed: 5.2,
    snapSpeed: 8,
    burstMin: 3,
    burstMax: 6,
    burstPauseMinMs: 260,
    burstPauseMaxMs: 560,
    visionRange: 58,
    fovCos: Math.cos((120 * Math.PI) / 180 / 2),
    headshotBias: 0.14,
    strafeChance: 0.45,
    disciplineChance: 0.5,
    reloadAt: 0.2,
    crouchChance: 0.2,
  },
  hard: {
    reactionMinMs: 140,
    reactionMaxMs: 240,
    aimJitter: 0.017,
    turnSpeed: 7.5,
    snapSpeed: 12,
    burstMin: 4,
    burstMax: 8,
    burstPauseMinMs: 180,
    burstPauseMaxMs: 380,
    visionRange: 72,
    fovCos: Math.cos((140 * Math.PI) / 180 / 2),
    headshotBias: 0.28,
    strafeChance: 0.6,
    disciplineChance: 0.65,
    reloadAt: 0.28,
    crouchChance: 0.28,
  },
  elite: {
    reactionMinMs: 90,
    reactionMaxMs: 160,
    aimJitter: 0.009,
    turnSpeed: 10,
    snapSpeed: 16,
    burstMin: 5,
    burstMax: 10,
    burstPauseMinMs: 120,
    burstPauseMaxMs: 260,
    visionRange: 90,
    fovCos: Math.cos((160 * Math.PI) / 180 / 2),
    headshotBias: 0.42,
    strafeChance: 0.7,
    disciplineChance: 0.75,
    reloadAt: 0.35,
    crouchChance: 0.32,
  },
};

const enum BotState {
  Patrol = 0,
  Engage = 1,
  Hunt = 2,
}

const SENSE_INTERVAL_MS = 90;
const REPATH_INTERVAL_MS = 1400;
const STUCK_WINDOW_MS = 700;
const STUCK_DISTANCE = 0.55;

export class BotController implements BotBrain {
  private readonly rng: Rng;
  private readonly profile: SkillProfile;

  private state = BotState.Patrol;
  private seq = 0;
  private dtAccumulator = 0;

  private aimYaw = 0;
  private aimPitch = 0;

  private targetId = 0;
  private targetLastSeenMs = 0;
  private readonly lastKnownPos: Vec3 = vec3();

  private nextSenseMs = 0;
  private nextRepathMs = 0;
  private path: number[] = [];
  private pathIndex = 0;

  private burstRemaining = 0;
  private burstResumeMs = 0;

  private strafeDir = 1;
  private nextStrafeFlipMs = 0;
  private holdStill = false;
  private crouchUntilMs = 0;
  private jumpUntilMs = 0;

  private readonly stuckAnchor: Vec3 = vec3();
  private stuckCheckMs = 0;

  constructor(
    readonly combatant: Combatant,
    private readonly skill: BotSkill,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.profile = PROFILES[skill];
    this.aimYaw = combatant.move.yaw;
  }

  get skillName(): BotSkill {
    return this.skill;
  }

  think(world: GameWorld): InputCommand {
    // Emit exactly one tick's worth of time, alternating 15/16 ms so the
    // millisecond-quantized command stream averages out to the true tick rate.
    this.dtAccumulator += TICK_MS;
    const dtMs = Math.max(1, Math.floor(this.dtAccumulator));
    this.dtAccumulator -= dtMs;
    const dt = dtMs / 1000;
    const now = world.timeMs;
    const me = this.combatant;

    if (!me.alive) {
      this.state = BotState.Patrol;
      this.targetId = 0;
      this.path.length = 0;
      return this.command(dtMs, 0, 0, 0);
    }

    if (now >= this.nextSenseMs) {
      this.nextSenseMs = now + SENSE_INTERVAL_MS;
      this.sense(world, now);
    }

    let buttons = 0;
    let moveX = 0;
    let moveZ = 0;

    const target = this.targetId ? world.combatants.get(this.targetId) : undefined;
    const hasTarget = !!target && target.alive && now - this.targetLastSeenMs < 2500;

    if (hasTarget && target) {
      this.state = now - this.targetLastSeenMs < 250 ? BotState.Engage : BotState.Hunt;
    } else if (this.state !== BotState.Patrol && now - this.targetLastSeenMs > 4000) {
      this.state = BotState.Patrol;
      this.targetId = 0;
    }

    if (this.state === BotState.Engage && target) {
      const combat = this.fight(world, target, now, dt);
      buttons |= combat.buttons;
      moveX = combat.moveX;
      moveZ = combat.moveZ;
    } else {
      this.aimAlongMovement(world, dt);
      const goal = this.state === BotState.Hunt ? this.lastKnownPos : null;
      const nav = this.navigate(world, now, goal);
      moveX = nav.moveX;
      moveZ = nav.moveZ;
      buttons |= nav.buttons;
      if (this.state === BotState.Hunt && distance2D(me.move.pos, this.lastKnownPos) < 2.5) {
        this.state = BotState.Patrol;
        this.targetId = 0;
      }
    }

    buttons |= this.maintenance(hasTarget);
    if (now < this.jumpUntilMs) buttons |= BTN_JUMP;
    if (now < this.crouchUntilMs) buttons |= BTN_CROUCH;

    this.detectStuck(now, moveX !== 0 || moveZ !== 0);

    return this.command(dtMs, moveX, moveZ, buttons);
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  private sense(world: GameWorld, now: number): void {
    const me = this.combatant;
    const eye = vec3();
    me.eyePosition(eye);
    const profile = this.profile;

    let bestId = 0;
    let bestScore = -Infinity;
    const theirEye = vec3();

    for (const other of world.combatants.values()) {
      if (other.id === me.id || !other.alive || other.team === me.team) continue;
      const dist = distance(me.move.pos, other.move.pos);
      if (dist > profile.visionRange) continue;

      other.eyePosition(theirEye);
      const dx = theirEye.x - eye.x;
      const dy = theirEye.y - eye.y;
      const dz = theirEye.z - eye.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      // Field of view is measured against where the bot is actually looking.
      const facingX = -Math.sin(this.aimYaw);
      const facingZ = -Math.cos(this.aimYaw);
      const cosAngle = (dx / len) * facingX + (dz / len) * facingZ;
      const alreadyTracking = other.id === this.targetId && now - this.targetLastSeenMs < 900;
      if (cosAngle < profile.fovCos && !alreadyTracking) continue;

      if (!hasLineOfSight(world.map.brushes, eye, theirEye)) continue;

      // Prefer close, hurt, and already-tracked targets.
      const score =
        200 - dist * 2 + (100 - other.health) * 0.4 + (other.id === this.targetId ? 40 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestId = other.id;
      }
    }

    if (bestId !== 0) {
      if (bestId !== this.targetId) {
        this.targetId = bestId;
        this.burstRemaining = 0;
        this.burstResumeMs = now + this.reactionDelay();
      }
      this.targetLastSeenMs = now;
      const target = world.combatants.get(bestId);
      if (target) {
        this.lastKnownPos.x = target.move.pos.x;
        this.lastKnownPos.y = target.move.pos.y;
        this.lastKnownPos.z = target.move.pos.z;
      }
    }
  }

  private reactionDelay(): number {
    return this.rng.range(this.profile.reactionMinMs, this.profile.reactionMaxMs);
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  private fight(
    world: GameWorld,
    target: Combatant,
    now: number,
    dt: number,
  ): { buttons: number; moveX: number; moveZ: number } {
    const me = this.combatant;
    const profile = this.profile;
    const def = me.weaponDef;
    let buttons = 0;

    const eye = vec3();
    me.eyePosition(eye);

    // Lead the shot slightly based on the target's current velocity.
    const dist = distance(me.move.pos, target.move.pos);
    const lead = clamp(dist / 90, 0, 0.12);
    const aimHeight =
      this.rng.next() < profile.headshotBias
        ? target.move.height - 0.16
        : target.move.height * 0.68;
    const aimPoint = vec3(
      target.move.pos.x + target.move.vel.x * lead,
      target.move.pos.y + aimHeight,
      target.move.pos.z + target.move.vel.z * lead,
    );

    const desired = anglesFromForward(
      vec3(aimPoint.x - eye.x, aimPoint.y - eye.y, aimPoint.z - eye.z),
    );

    // Track with a bounded turn rate; snap faster when far off-target.
    const yawError = Math.abs(angleDelta(this.aimYaw, desired.yaw));
    const rate = (yawError > 0.6 ? profile.snapSpeed : profile.turnSpeed) * dt;
    this.aimYaw = approachAngle(this.aimYaw, desired.yaw, rate);
    this.aimPitch = approachAngle(this.aimPitch, desired.pitch, rate);

    // Persistent jitter so bots miss like people do rather than laser-locking.
    const jitter = profile.aimJitter * (me.move.onGround ? 1 : 1.8);
    this.aimYaw += this.rng.gaussian() * jitter * dt * 6;
    this.aimPitch = clamp(
      this.aimPitch + this.rng.gaussian() * jitter * dt * 6,
      -Math.PI / 2 + 0.01,
      Math.PI / 2 - 0.01,
    );

    const onTarget = yawError < 0.09 + profile.aimJitter * 4;
    const ready = now >= this.burstResumeMs;
    const visible = now - this.targetLastSeenMs < 200;

    if (ready && onTarget && visible && me.weapon.ammo > 0 && !me.reloading) {
      if (this.burstRemaining <= 0) {
        this.burstRemaining = Math.round(this.rng.range(profile.burstMin, profile.burstMax + 1));
        if (this.rng.next() < profile.disciplineChance) this.holdStill = true;
      }
      buttons |= BTN_ATTACK;
      // Approximate one round per fire interval so bursts are the right length.
      if (now >= me.nextFireAtMs) this.burstRemaining--;
      if (this.burstRemaining <= 0) {
        this.burstResumeMs = now + this.rng.range(profile.burstPauseMinMs, profile.burstPauseMaxMs);
        this.holdStill = false;
      }
      if (def.id === WeaponId.Sniper || def.id === WeaponId.Rifle) buttons |= BTN_ADS;
    } else {
      this.holdStill = false;
    }

    // Positioning: hold a comfortable range for the equipped weapon.
    const preferred =
      def.id === WeaponId.Sniper
        ? 30
        : def.id === WeaponId.Shotgun
          ? 5
          : def.id === WeaponId.Smg
            ? 8
            : 16;
    let moveZ = 0;
    let moveX = 0;

    if (!this.holdStill) {
      if (dist > preferred * 1.35) moveZ = 1;
      else if (dist < preferred * 0.55) moveZ = -1;

      if (now >= this.nextStrafeFlipMs) {
        this.nextStrafeFlipMs = now + this.rng.range(420, 1100);
        this.strafeDir = this.rng.next() < 0.5 ? -1 : 1;
        if (this.rng.next() > profile.strafeChance) this.strafeDir = 0;
        if (this.rng.next() < profile.crouchChance && dist > 14) {
          this.crouchUntilMs = now + this.rng.range(500, 1400);
        }
      }
      moveX = this.strafeDir;

      // Do not strafe straight into a wall; flip when blocked.
      if (moveX !== 0 && this.wouldCollide(world, moveX, moveZ)) {
        this.strafeDir = -this.strafeDir;
        moveX = this.strafeDir;
      }
    }

    if (!visible) {
      // Lost sight mid-fight: push toward where they were last seen.
      const nav = this.navigate(world, now, this.lastKnownPos);
      moveX = nav.moveX;
      moveZ = nav.moveZ;
      buttons |= nav.buttons;
    }

    return { buttons, moveX, moveZ };
  }

  /** Cheap look-ahead so bots stop grinding along walls. */
  private wouldCollide(world: GameWorld, moveX: number, moveZ: number): boolean {
    const me = this.combatant;
    const sinYaw = Math.sin(this.aimYaw);
    const cosYaw = Math.cos(this.aimYaw);
    const dirX = moveZ * -sinYaw + moveX * cosYaw;
    const dirZ = moveZ * -cosYaw - moveX * sinYaw;
    const len = Math.hypot(dirX, dirZ) || 1;
    const probe = vec3(
      me.move.pos.x + (dirX / len) * (PLAYER_RADIUS + 0.9),
      me.move.pos.y + 0.9,
      me.move.pos.z + (dirZ / len) * (PLAYER_RADIUS + 0.9),
    );
    const eye = vec3(me.move.pos.x, me.move.pos.y + 0.9, me.move.pos.z);
    return !hasLineOfSight(world.map.brushes, eye, probe);
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private navigate(
    world: GameWorld,
    now: number,
    goal: Vec3 | null,
  ): { moveX: number; moveZ: number; buttons: number } {
    const me = this.combatant;
    const buttons = 0;

    const needsPath =
      this.path.length === 0 || this.pathIndex >= this.path.length || now >= this.nextRepathMs;

    if (needsPath) {
      this.nextRepathMs = now + REPATH_INTERVAL_MS;
      const start = world.nav.nearest(me.move.pos);
      const destination = goal ? world.nav.nearest(goal) : this.pickRoamGoal(world);
      if (start >= 0 && destination >= 0) {
        this.path = world.nav.findPath(start, destination);
        this.pathIndex = this.path.length > 1 ? 1 : 0;
      }
    }

    if (this.path.length === 0) return { moveX: 0, moveZ: 0, buttons };

    let node = world.nav.nodes[this.path[this.pathIndex] as number];
    if (!node) return { moveX: 0, moveZ: 0, buttons };

    // Advance through waypoints we have effectively reached.
    let guard = 4;
    while (guard-- > 0 && distance2D(me.move.pos, node.pos) < 1.35) {
      if (this.pathIndex + 1 >= this.path.length) {
        this.path.length = 0;
        this.nextRepathMs = 0;
        return { moveX: 0, moveZ: 0, buttons };
      }
      const previous = this.path[this.pathIndex] as number;
      this.pathIndex++;
      const nextId = this.path[this.pathIndex] as number;
      if (world.nav.linkRequiresJump(previous, nextId)) {
        this.jumpUntilMs = now + 120;
      }
      node = world.nav.nodes[nextId] as (typeof world.nav.nodes)[number];
    }

    const dirX = node.pos.x - me.move.pos.x;
    const dirZ = node.pos.z - me.move.pos.z;
    const len = Math.hypot(dirX, dirZ) || 1;
    return { ...this.worldDirToInput(dirX / len, dirZ / len), buttons };
  }

  private pickRoamGoal(world: GameWorld): number {
    const nodes = world.nav.nodes;
    if (nodes.length === 0) return -1;
    const me = this.combatant;

    // Bias roaming toward the enemy half of the map so fights actually happen.
    const enemySign = me.team === 0 ? 1 : -1;
    let best = -1;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = nodes[this.rng.int(nodes.length)];
      if (!candidate) continue;
      const towardEnemy = candidate.pos.z * enemySign;
      const away = distance2D(candidate.pos, me.move.pos);
      const score = towardEnemy * 1.2 + Math.min(away, 30) * 0.6 + this.rng.range(0, 14);
      if (score > bestScore) {
        bestScore = score;
        best = candidate.id;
      }
    }
    return best;
  }

  /** Convert a world-space direction into yaw-relative move axes. */
  private worldDirToInput(dirX: number, dirZ: number): { moveX: number; moveZ: number } {
    const sinYaw = Math.sin(this.aimYaw);
    const cosYaw = Math.cos(this.aimYaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    const moveZ = dirX * -sinYaw + dirZ * -cosYaw;
    const moveX = dirX * cosYaw + dirZ * -sinYaw;
    const len = Math.hypot(moveX, moveZ) || 1;
    return { moveX: moveX / len, moveZ: moveZ / len };
  }

  /** While roaming, look where we are going. */
  private aimAlongMovement(world: GameWorld, dt: number): void {
    const me = this.combatant;
    if (this.path.length === 0 || this.pathIndex >= this.path.length) return;
    const node = world.nav.nodes[this.path[this.pathIndex] as number];
    if (!node) return;
    const desired = anglesFromForward(
      vec3(node.pos.x - me.move.pos.x, 0, node.pos.z - me.move.pos.z),
    );
    this.aimYaw = approachAngle(this.aimYaw, desired.yaw, this.profile.turnSpeed * 0.8 * dt);
    this.aimPitch = approachAngle(this.aimPitch, 0, 2 * dt);
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  private maintenance(hasTarget: boolean): number {
    const me = this.combatant;
    const def = me.weaponDef;
    let buttons = 0;

    const magFraction = me.weapon.ammo / Math.max(1, def.magSize);
    const wantsReload =
      !me.reloading &&
      me.weapon.reserve > 0 &&
      (me.weapon.ammo === 0 || (!hasTarget && magFraction < this.profile.reloadAt));
    if (wantsReload) buttons |= BTN_RELOAD;

    // Move quietly when hunting so footsteps do not give the position away.
    if (this.state === BotState.Hunt && this.rng.next() < 0.02) {
      buttons |= BTN_WALK;
    }

    return buttons;
  }

  private detectStuck(now: number, wantsToMove: boolean): void {
    const me = this.combatant;
    if (!wantsToMove) {
      this.stuckCheckMs = now + STUCK_WINDOW_MS;
      return;
    }
    if (this.stuckCheckMs === 0) {
      this.stuckCheckMs = now + STUCK_WINDOW_MS;
      this.stuckAnchor.x = me.move.pos.x;
      this.stuckAnchor.z = me.move.pos.z;
      return;
    }
    if (now < this.stuckCheckMs) return;

    const moved = distance2D(me.move.pos, this.stuckAnchor);
    this.stuckCheckMs = now + STUCK_WINDOW_MS;
    this.stuckAnchor.x = me.move.pos.x;
    this.stuckAnchor.y = me.move.pos.y;
    this.stuckAnchor.z = me.move.pos.z;
    if (moved >= STUCK_DISTANCE) return;

    // Wedged: jump, forget the current path, and pick somewhere new to go.
    this.jumpUntilMs = now + 140;
    this.path.length = 0;
    this.nextRepathMs = 0;
    this.aimYaw += this.rng.range(-1.2, 1.2);
  }

  private command(dtMs: number, moveX: number, moveZ: number, buttons: number): InputCommand {
    this.seq++;
    return {
      seq: this.seq,
      dtMs,
      buttons,
      yaw: this.aimYaw,
      pitch: clamp(this.aimPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01),
      moveX: clamp(moveX, -1, 1),
      moveZ: clamp(moveZ, -1, 1),
    };
  }
}

export const createBot = (combatant: Combatant, skill: BotSkill, seed: number): BotBrain =>
  new BotController(combatant, skill, seed);

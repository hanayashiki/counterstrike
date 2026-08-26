/**
 * A combatant is anything that can move and shoot: a connected human or a bot.
 * The server owns the authoritative copy; clients get a quantized view of it.
 */
import {
  LAG_COMP_HISTORY_MS,
  MAX_HEALTH,
  PLAYER_HEIGHT,
  START_ARMOR,
  TICK_RATE,
} from '../shared/config';
import type { TeamId } from '../shared/map';
import { type Vec3, vec3 } from '../shared/math';
import { type MoveState, eyePosition } from '../shared/movement';
import {
  type InputCommand,
  PF_ADS,
  PF_ALIVE,
  PF_BOT,
  PF_CROUCH,
  PF_FIRING,
  PF_ON_GROUND,
  PF_RELOADING,
  PF_TEAM_BLUE,
} from '../shared/protocol';
import { WeaponId, getWeapon } from '../shared/weapons';

export interface SlotState {
  weapon: WeaponId;
  ammo: number;
  reserve: number;
}

export interface HistoryFrame {
  timeMs: number;
  x: number;
  y: number;
  z: number;
  height: number;
  alive: boolean;
}

const HISTORY_SIZE = Math.ceil((LAG_COMP_HISTORY_MS / 1000) * TICK_RATE) + 4;

export class Combatant {
  readonly move: MoveState = {
    pos: vec3(),
    vel: vec3(),
    yaw: 0,
    pitch: 0,
    onGround: false,
    crouching: false,
    height: PLAYER_HEIGHT,
    lean: 0,
  };

  health = MAX_HEALTH;
  armor = START_ARMOR;
  alive = false;
  respawnAtMs = 0;
  spawnProtectedUntilMs = 0;

  /** Slot 0 is the primary, slot 1 is the sidearm. */
  readonly slots: SlotState[] = [
    { weapon: WeaponId.Rifle, ammo: 0, reserve: 0 },
    { weapon: WeaponId.Pistol, ammo: 0, reserve: 0 },
  ];
  activeSlot = 0;

  nextFireAtMs = 0;
  reloadEndsAtMs = 0;
  /** Shells fired since the action last cycled (the DBS racks every two). */
  shotsSinceCycle = 0;
  /** Extra cone half-angle accumulated from firing, in radians. */
  spread = 0;
  triggerWasDown = false;
  firingUntilMs = 0;
  wantsAds = false;

  /** Cosmetic model. Never consulted by the simulation. */
  character = 0;

  kills = 0;
  deaths = 0;
  assists = 0;
  score = 0;
  streak = 0;

  /** Damage dealt to this combatant since its last death, keyed by attacker id. */
  readonly damageTaken = new Map<number, number>();

  lastProcessedSeq = 0;
  readonly pendingInputs: InputCommand[] = [];
  /** Most recent command actually applied, re-used when input starves. */
  lastCommand: InputCommand | null = null;
  /** Consecutive ticks with no input to process. */
  starvedTicks = 0;
  /** Round-trip time in ms, measured via ping/pong (0 for bots). */
  pingMs = 0;

  private readonly history: HistoryFrame[] = [];
  private historyHead = 0;

  constructor(
    readonly id: number,
    public name: string,
    public team: TeamId,
    readonly isBot: boolean,
  ) {
    for (let i = 0; i < HISTORY_SIZE; i++) {
      this.history.push({ timeMs: -1, x: 0, y: 0, z: 0, height: PLAYER_HEIGHT, alive: false });
    }
  }

  get weapon(): SlotState {
    return this.slots[this.activeSlot] as SlotState;
  }

  get weaponDef() {
    return getWeapon(this.weapon.weapon);
  }

  get reloading(): boolean {
    return this.reloadEndsAtMs > 0;
  }

  /**
   * Eye position, which is where shots originate from. Includes lean, so a
   * player peeking round a corner really does shoot from the peek.
   */
  eyePosition(out: Vec3): Vec3 {
    return eyePosition(out, this.move);
  }

  setLoadout(primary: WeaponId): void {
    const primaryDef = getWeapon(primary);
    const pistolDef = getWeapon(WeaponId.Pistol);
    this.slots[0] = {
      weapon: primary,
      ammo: primaryDef.magSize,
      reserve: primaryDef.reserveAmmo,
    };
    this.slots[1] = {
      weapon: WeaponId.Pistol,
      ammo: pistolDef.magSize,
      reserve: pistolDef.reserveAmmo,
    };
    this.activeSlot = 0;
  }

  refillAmmo(): void {
    for (const slot of this.slots) {
      const def = getWeapon(slot.weapon);
      slot.ammo = def.magSize;
      slot.reserve = def.reserveAmmo;
    }
    this.reloadEndsAtMs = 0;
    this.spread = 0;
    this.shotsSinceCycle = 0;
    this.activeSlot = 0;
  }

  recordHistory(timeMs: number): void {
    const frame = this.history[this.historyHead] as HistoryFrame;
    frame.timeMs = timeMs;
    frame.x = this.move.pos.x;
    frame.y = this.move.pos.y;
    frame.z = this.move.pos.z;
    frame.height = this.move.height;
    frame.alive = this.alive;
    this.historyHead = (this.historyHead + 1) % this.history.length;
  }

  /**
   * Position this combatant occupied at `timeMs`, interpolated between the two
   * bracketing history frames. Falls back to the current position.
   */
  historyAt(timeMs: number, out: HistoryFrame): HistoryFrame {
    let before: HistoryFrame | null = null;
    let after: HistoryFrame | null = null;

    for (const frame of this.history) {
      if (frame.timeMs < 0) continue;
      if (frame.timeMs <= timeMs && (!before || frame.timeMs > before.timeMs)) before = frame;
      if (frame.timeMs >= timeMs && (!after || frame.timeMs < after.timeMs)) after = frame;
    }

    if (!before && !after) {
      out.timeMs = timeMs;
      out.x = this.move.pos.x;
      out.y = this.move.pos.y;
      out.z = this.move.pos.z;
      out.height = this.move.height;
      out.alive = this.alive;
      return out;
    }
    if (!before) return Object.assign(out, after as HistoryFrame);
    if (!after || after.timeMs === before.timeMs) return Object.assign(out, before);

    const t = (timeMs - before.timeMs) / (after.timeMs - before.timeMs);
    out.timeMs = timeMs;
    out.x = before.x + (after.x - before.x) * t;
    out.y = before.y + (after.y - before.y) * t;
    out.z = before.z + (after.z - before.z) * t;
    out.height = before.height + (after.height - before.height) * t;
    out.alive = before.alive;
    return out;
  }

  snapshotFlags(nowMs: number): number {
    let flags = 0;
    if (this.alive) flags |= PF_ALIVE;
    if (this.move.crouching) flags |= PF_CROUCH;
    if (this.firingUntilMs > nowMs) flags |= PF_FIRING;
    if (this.reloading) flags |= PF_RELOADING;
    if (this.team === 1) flags |= PF_TEAM_BLUE;
    if (this.isBot) flags |= PF_BOT;
    if (this.move.onGround) flags |= PF_ON_GROUND;
    if (this.wantsAds) flags |= PF_ADS;
    return flags;
  }
}

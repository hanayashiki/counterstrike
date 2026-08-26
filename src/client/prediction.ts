/**
 * Client-side prediction and reconciliation for the local player.
 *
 * Every fixed step we build an `InputCommand`, simulate it locally with the
 * exact same movement code the server runs, and keep it in an unacked queue.
 * When a snapshot arrives we snap to the authoritative state and replay the
 * still-unacked commands on top, so the local view stays responsive without
 * ever drifting away from the server.
 */
import type { Brush, MoveResult } from '../shared/collision';
import { ACCURATE_MOVE_SPEED, PLAYER_HEIGHT } from '../shared/config';
import { type Vec3, clamp, vec3 } from '../shared/math';
import { type MoveInput, type MoveState, horizontalSpeed, stepMovement } from '../shared/movement';
import { type InputCommand, type LocalSnapshot, PF_ALIVE } from '../shared/protocol';
import {
  type WeaponDef,
  WeaponId,
  cyclesAfterShot,
  getWeapon,
  shotDelayMs,
} from '../shared/weapons';

/** Errors larger than this are snapped rather than smoothed away. */
const MAX_SMOOTHED_ERROR = 1.5;
const ERROR_DECAY_PER_SEC = 12;
/** Recoil starts recovering this long after the last shot. */
const RECOIL_SETTLE_MS = 150;

export interface PredictionEvents {
  /** A shot we believe happened: play the flash, the sound, and the kick now. */
  onLocalShot(weapon: WeaponDef, seq: number): void;
  onLocalReloadStart(weapon: WeaponDef): void;
  onLocalReloadEnd(weapon: WeaponDef): void;
  onDryFire(): void;
  /** Recoil that must be folded into the player's actual view angles. */
  onRecoil(deltaYaw: number, deltaPitch: number): void;
}

export class LocalPlayer {
  readonly state: MoveState = {
    pos: vec3(0, 0, 0),
    vel: vec3(),
    yaw: 0,
    pitch: 0,
    onGround: false,
    crouching: false,
    height: PLAYER_HEIGHT,
    lean: 0,
  };

  readonly pending: InputCommand[] = [];
  seq = 0;
  alive = false;

  // Predicted weapon state; corrected by every snapshot.
  weaponId: WeaponId = WeaponId.Rifle;
  ammo = 30;
  reserve = 90;
  spread = 0;
  reloadEndsAtMs = 0;
  private nextFireAtMs = 0;
  private shotsSinceCycle = 0;
  private triggerWasDown = false;
  private lastFireMs = 0;
  private localTimeMs = 0;

  /** Recoil already folded into the view, waiting to be recovered. */
  private recoilYaw = 0;
  private recoilPitch = 0;

  /** Visual-only offset that hides reconciliation corrections. */
  private readonly errorOffset: Vec3 = vec3();
  /** Sequence of the newest locally predicted shot, for ammo reconciliation. */
  private lastPredictedShotSeq = 0;

  private readonly moveResult: MoveResult = {
    onGround: false,
    hitWall: false,
    hitCeiling: false,
    landingSpeed: 0,
  };

  constructor(
    private brushes: readonly Brush[],
    private readonly events: PredictionEvents,
    private readonly rng: () => number = Math.random,
  ) {}

  get weapon(): WeaponDef {
    return getWeapon(this.weaponId);
  }

  get reloading(): boolean {
    return this.reloadEndsAtMs > this.localTimeMs;
  }

  /** Cone half-angle used to size the crosshair. Mirrors the server formula. */
  currentSpread(ads: boolean): number {
    const def = this.weapon;
    let spread = def.spreadBase + this.spread;
    const speed = horizontalSpeed(this.state);
    if (speed > ACCURATE_MOVE_SPEED) {
      spread += def.moveInaccuracy * ((speed - ACCURATE_MOVE_SPEED) / 4);
    }
    if (!this.state.onGround) spread += def.airInaccuracy;
    if (this.state.crouching) spread *= 0.72;
    if (ads) spread *= def.adsSpreadMultiplier;
    return spread;
  }

  /**
   * Advance one fixed step. Returns the command to ship to the server.
   */
  step(input: MoveInput, dtMs: number): InputCommand {
    this.localTimeMs += dtMs;
    const dt = dtMs / 1000;

    this.seq++;
    const command: InputCommand = {
      seq: this.seq,
      dtMs,
      buttons: input.buttons,
      yaw: input.yaw,
      pitch: input.pitch,
      moveX: clamp(input.moveX, -1, 1),
      moveZ: clamp(input.moveZ, -1, 1),
    };

    if (this.alive) {
      stepMovement(
        this.state,
        command,
        this.brushes,
        dt,
        this.weapon.moveSpeedMultiplier,
        this.moveResult,
      );
    } else {
      this.state.yaw = command.yaw;
      this.state.pitch = command.pitch;
    }

    this.pending.push(command);
    if (this.pending.length > 128) this.pending.shift();

    this.predictWeapon(command, dt);
    this.decayError(dt);
    return command;
  }

  private predictWeapon(command: InputCommand, dt: number): void {
    const def = this.weapon;
    const now = this.localTimeMs;

    this.spread = Math.max(0, this.spread - def.spreadRecoveryPerSec * dt);

    if (this.reloadEndsAtMs > 0 && now >= this.reloadEndsAtMs) {
      const taken = Math.min(def.magSize - this.ammo, this.reserve);
      this.ammo += taken;
      this.reserve -= taken;
      this.reloadEndsAtMs = 0;
      this.shotsSinceCycle = 0;
      this.events.onLocalReloadEnd(def);
    }

    if (!this.alive) {
      this.triggerWasDown = false;
      return;
    }

    const wantsReload = (command.buttons & (1 << 7)) !== 0;
    if (wantsReload && this.reloadEndsAtMs === 0 && this.ammo < def.magSize && this.reserve > 0) {
      this.reloadEndsAtMs = now + def.reloadMs;
      this.events.onLocalReloadStart(def);
    }

    const triggerDown = (command.buttons & (1 << 6)) !== 0;
    const canFire =
      triggerDown &&
      this.reloadEndsAtMs === 0 &&
      now >= this.nextFireAtMs &&
      (def.automatic || !this.triggerWasDown);
    this.triggerWasDown = triggerDown;

    if (canFire) {
      if (this.ammo <= 0) {
        this.nextFireAtMs = now + 250;
        this.events.onDryFire();
        if (this.reserve > 0 && this.reloadEndsAtMs === 0) {
          this.reloadEndsAtMs = now + def.reloadMs;
          this.events.onLocalReloadStart(def);
        }
      } else {
        this.ammo--;
        this.shotsSinceCycle++;
        this.nextFireAtMs = now + shotDelayMs(def, this.shotsSinceCycle);
        if (cyclesAfterShot(def, this.shotsSinceCycle)) this.shotsSinceCycle = 0;
        this.lastFireMs = now;
        this.lastPredictedShotSeq = this.seq;
        this.spread = Math.min(def.spreadMax, this.spread + def.spreadPerShot);
        this.applyRecoilKick(def);
        this.events.onLocalShot(def, this.seq);
      }
    }

    this.recoverRecoil(def, dt, now);
  }

  private applyRecoilKick(def: WeaponDef): void {
    const vertical = def.recoilVertical * (0.82 + this.rng() * 0.36);
    const horizontal = def.recoilHorizontal * (this.rng() * 2 - 1);
    this.recoilPitch += vertical;
    this.recoilYaw += horizontal;
    this.events.onRecoil(horizontal, vertical);
  }

  private recoverRecoil(def: WeaponDef, dt: number, now: number): void {
    if (now - this.lastFireMs < RECOIL_SETTLE_MS) return;
    if (this.recoilPitch === 0 && this.recoilYaw === 0) return;

    const rate = def.recoilRecoveryPerSec * 9 * dt;
    const stepPitch = clamp(this.recoilPitch, -rate, rate);
    const stepYaw = clamp(this.recoilYaw, -rate, rate);
    this.recoilPitch -= stepPitch;
    this.recoilYaw -= stepYaw;
    this.events.onRecoil(-stepYaw, -stepPitch);
  }

  /** Fold the authoritative state in and replay everything not yet acked. */
  reconcile(local: LocalSnapshot, ackSeq: number): void {
    const beforeX = this.state.pos.x;
    const beforeY = this.state.pos.y;
    const beforeZ = this.state.pos.z;

    while (this.pending.length > 0 && (this.pending[0] as InputCommand).seq <= ackSeq) {
      this.pending.shift();
    }

    this.alive = (local.flags & PF_ALIVE) !== 0;
    this.weaponId = local.weapon as WeaponId;

    this.state.pos.x = local.x;
    this.state.pos.y = local.y;
    this.state.pos.z = local.z;
    this.state.vel.x = local.vx;
    this.state.vel.y = local.vy;
    this.state.vel.z = local.vz;
    this.state.height = local.height;
    this.state.lean = local.lean;
    this.state.crouching = (local.flags & (1 << 1)) !== 0;
    this.state.onGround = (local.flags & (1 << 6)) !== 0;

    if (this.alive) {
      for (const command of this.pending) {
        stepMovement(
          this.state,
          command,
          this.brushes,
          command.dtMs / 1000,
          this.weapon.moveSpeedMultiplier,
          this.moveResult,
        );
      }
    }

    // Only trust server ammo once it has seen every shot we predicted, so the
    // counter never flickers backwards mid-burst.
    if (ackSeq >= this.lastPredictedShotSeq) {
      this.ammo = local.ammo;
      this.reserve = local.reserve;
      if (local.reloadMs > 0) {
        this.reloadEndsAtMs = this.localTimeMs + local.reloadMs;
      } else if (this.reloadEndsAtMs > 0 && local.reloadMs === 0) {
        this.reloadEndsAtMs = 0;
      }
    }

    const errX = beforeX - this.state.pos.x;
    const errY = beforeY - this.state.pos.y;
    const errZ = beforeZ - this.state.pos.z;
    const magnitude = Math.hypot(errX, errY, errZ);
    if (magnitude > 0.0005 && magnitude < MAX_SMOOTHED_ERROR) {
      this.errorOffset.x = errX;
      this.errorOffset.y = errY;
      this.errorOffset.z = errZ;
    } else {
      this.errorOffset.x = 0;
      this.errorOffset.y = 0;
      this.errorOffset.z = 0;
    }
  }

  private decayError(dt: number): void {
    const k = Math.exp(-ERROR_DECAY_PER_SEC * dt);
    this.errorOffset.x *= k;
    this.errorOffset.y *= k;
    this.errorOffset.z *= k;
  }

  /** Feet position to render at, including reconciliation smoothing. */
  renderPosition(out: Vec3): Vec3 {
    out.x = this.state.pos.x + this.errorOffset.x;
    out.y = this.state.pos.y + this.errorOffset.y;
    out.z = this.state.pos.z + this.errorOffset.z;
    return out;
  }

  /** Commands the server has not acknowledged yet, newest last. */
  unacked(limit: number): InputCommand[] {
    return this.pending.length <= limit ? this.pending : this.pending.slice(-limit);
  }

  /** Swap the collision set when the room changes map. */
  setBrushes(brushes: readonly Brush[]): void {
    this.brushes = brushes;
  }

  reset(): void {
    this.pending.length = 0;
    this.spread = 0;
    this.reloadEndsAtMs = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.shotsSinceCycle = 0;
    this.state.lean = 0;
    this.errorOffset.x = 0;
    this.errorOffset.y = 0;
    this.errorOffset.z = 0;
  }
}

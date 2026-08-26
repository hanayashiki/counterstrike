/**
 * Keyboard/mouse capture. Produces the raw button mask and look angles; the
 * prediction layer turns those into the `InputCommand`s that go on the wire.
 */
import {
  BTN_ADS,
  BTN_ATTACK,
  BTN_BACK,
  BTN_CROUCH,
  BTN_FORWARD,
  BTN_JUMP,
  BTN_LEAN_LEFT,
  BTN_LEAN_RIGHT,
  BTN_LEFT,
  BTN_RELOAD,
  BTN_RIGHT,
  BTN_WALK,
} from '../shared/config';
import { clamp, wrapAngle } from '../shared/math';
import type { MoveInput } from '../shared/movement';

const PITCH_LIMIT = Math.PI / 2 - 0.02;

/**
 * Exactly the shape the shared movement code consumes, so a sampled input can
 * be fed straight into prediction (and into tests) without translation.
 */
export type InputSnapshot = MoveInput;

export interface InputCallbacks {
  onWeaponSlot(slot: number): void;
  onToggleScoreboard(open: boolean): void;
  onOpenChat(): void;
  onOpenOptions(): void;
  onRespawnRequest(): void;
  onPointerLockChange(locked: boolean): void;
}

export class InputController {
  /** Mouse-driven view angles, before weapon recoil is added. */
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  invertY = false;

  private readonly held = new Set<string>();
  private mouseButtons = 0;
  private locked = false;
  private textCaptureActive = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: InputCallbacks,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  /** Suspend gameplay keys while the chat box has focus. */
  setTextCapture(active: boolean): void {
    this.textCaptureActive = active;
    if (active) this.releaseAll();
  }

  requestLock(): void {
    void this.canvas.requestPointerLock();
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  sample(): InputSnapshot {
    let buttons = 0;
    let moveX = 0;
    let moveZ = 0;

    if (!this.textCaptureActive && this.locked) {
      if (this.held.has('KeyW')) {
        buttons |= BTN_FORWARD;
        moveZ += 1;
      }
      if (this.held.has('KeyS')) {
        buttons |= BTN_BACK;
        moveZ -= 1;
      }
      if (this.held.has('KeyD')) {
        buttons |= BTN_RIGHT;
        moveX += 1;
      }
      if (this.held.has('KeyA')) {
        buttons |= BTN_LEFT;
        moveX -= 1;
      }
      if (this.held.has('Space')) buttons |= BTN_JUMP;
      if (this.held.has('ControlLeft') || this.held.has('KeyC')) buttons |= BTN_CROUCH;
      if (this.held.has('ShiftLeft')) buttons |= BTN_WALK;
      if (this.held.has('KeyR')) buttons |= BTN_RELOAD;
      // Holding both cancels out, which is what the server computes too.
      if (this.held.has('KeyQ')) buttons |= BTN_LEAN_LEFT;
      if (this.held.has('KeyE')) buttons |= BTN_LEAN_RIGHT;
      if ((this.mouseButtons & 1) !== 0) buttons |= BTN_ATTACK;
      if ((this.mouseButtons & 2) !== 0) buttons |= BTN_ADS;
    }

    return { buttons, moveX, moveZ, yaw: this.yaw, pitch: this.pitch };
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') {
      this.releaseLock();
      return;
    }
    if (this.textCaptureActive) return;

    if (event.code === 'Tab') {
      event.preventDefault();
      this.callbacks.onToggleScoreboard(true);
      return;
    }
    if (!this.locked) return;

    if (event.repeat) return;
    this.held.add(event.code);

    switch (event.code) {
      case 'Digit1':
        this.callbacks.onWeaponSlot(0);
        break;
      case 'Digit2':
        this.callbacks.onWeaponSlot(1);
        break;
      case 'KeyY':
      case 'KeyT':
        event.preventDefault();
        this.callbacks.onOpenChat();
        break;
      case 'KeyO':
        event.preventDefault();
        this.callbacks.onOpenOptions();
        break;
      default:
        break;
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
    if (event.code === 'Tab') {
      event.preventDefault();
      this.callbacks.onToggleScoreboard(false);
    }
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (this.textCaptureActive) return;
    if (!this.locked) return;
    this.mouseButtons |= event.button === 0 ? 1 : event.button === 2 ? 2 : 0;
    if (event.button === 0) this.callbacks.onRespawnRequest();
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    this.mouseButtons &= ~(event.button === 0 ? 1 : event.button === 2 ? 2 : 0);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.locked || this.textCaptureActive) return;
    this.yaw = wrapAngle(this.yaw - event.movementX * this.sensitivity);
    const dy = this.invertY ? event.movementY : -event.movementY;
    this.pitch = clamp(this.pitch + dy * this.sensitivity, -PITCH_LIMIT, PITCH_LIMIT);
  };

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this.releaseAll();
    this.callbacks.onPointerLockChange(this.locked);
  };

  private readonly releaseAll = (): void => {
    this.held.clear();
    this.mouseButtons = 0;
  };

  /** Weapon recoil nudges the real view angles, exactly like it would locally. */
  applyRecoil(deltaYaw: number, deltaPitch: number): void {
    this.yaw = wrapAngle(this.yaw + deltaYaw);
    this.pitch = clamp(this.pitch + deltaPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }
}

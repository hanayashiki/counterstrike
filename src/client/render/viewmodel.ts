/**
 * First-person weapon. Lives in its own scene so it can never clip through
 * geometry, and is driven by a few springs: idle bob, look sway, recoil kick,
 * an aim-down-sights blend and a reload animation.
 */
import * as THREE from 'three';

import { clamp } from '../../shared/math';
import type { WeaponDef } from '../../shared/weapons';
import { type WeaponModel, buildWeaponModel } from './weapon-model';

const HIP_POSITION = new THREE.Vector3(0.17, -0.16, -0.34);
const ADS_POSITION = new THREE.Vector3(0, -0.082, -0.24);
const HIP_ROTATION = new THREE.Euler(0.03, 0.12, 0.02);
const ADS_ROTATION = new THREE.Euler(0, 0, 0);

export interface ViewmodelInput {
  /** Horizontal speed in m/s, for the walk bob. */
  speed: number;
  onGround: boolean;
  ads: boolean;
  /** 0..1, where 1 means the reload just started. */
  reloadProgress: number;
  /** Per-frame view angle deltas, for sway. */
  deltaYaw: number;
  deltaPitch: number;
}

export class Viewmodel {
  private readonly holder = new THREE.Group();
  private model: WeaponModel | null = null;
  private def: WeaponDef | null = null;

  private bobPhase = 0;
  private adsBlend = 0;
  private kick = 0;
  private kickVelocity = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private landDip = 0;
  private wasOnGround = true;

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.holder);
  }

  setWeapon(def: WeaponDef): void {
    if (this.def?.id === def.id) return;
    this.def = def;
    if (this.model) this.holder.remove(this.model.root);
    this.model = buildWeaponModel(def);
    this.holder.add(this.model.root);
  }

  /** Recoil impulse, in the same units as the weapon's vertical kick. */
  punch(amount: number): void {
    this.kickVelocity += amount * 42;
  }

  update(dt: number, input: ViewmodelInput): void {
    if (!this.model || !this.def) return;

    this.adsBlend += (Number(input.ads) - this.adsBlend) * Math.min(1, dt * 16);

    // Spring the recoil kick back to rest.
    this.kickVelocity -= this.kick * 320 * dt;
    this.kickVelocity *= Math.exp(-14 * dt);
    this.kick += this.kickVelocity * dt;
    this.kick = clamp(this.kick, -0.02, 0.09);

    // Sway trails the mouse a little, then catches up.
    this.swayYaw +=
      (clamp(-input.deltaYaw * 2.4, -0.09, 0.09) - this.swayYaw) * Math.min(1, dt * 9);
    this.swayPitch +=
      (clamp(-input.deltaPitch * 2.4, -0.07, 0.07) - this.swayPitch) * Math.min(1, dt * 9);

    if (!this.wasOnGround && input.onGround) this.landDip = 0.05;
    this.wasOnGround = input.onGround;
    this.landDip *= Math.exp(-9 * dt);

    const bobScale = (1 - this.adsBlend * 0.85) * clamp(input.speed / 7, 0, 1.15);
    this.bobPhase += dt * (6 + input.speed * 1.15);
    const bobX = Math.cos(this.bobPhase) * 0.018 * bobScale;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.014 * bobScale;

    const root = this.model.root;
    root.position.lerpVectors(HIP_POSITION, ADS_POSITION, this.adsBlend);
    root.position.x += bobX + this.swayYaw * 0.35;
    root.position.y += bobY - this.landDip - this.kick * 0.32 + this.swayPitch * 0.3;
    root.position.z += this.kick * 0.55;

    root.rotation.set(
      THREE.MathUtils.lerp(HIP_ROTATION.x, ADS_ROTATION.x, this.adsBlend) -
        this.kick * 3.4 +
        this.swayPitch,
      THREE.MathUtils.lerp(HIP_ROTATION.y, ADS_ROTATION.y, this.adsBlend) + this.swayYaw * 1.6,
      THREE.MathUtils.lerp(HIP_ROTATION.z, ADS_ROTATION.z, this.adsBlend) - bobX * 1.6,
    );

    if (input.reloadProgress > 0) {
      // Dip the weapon out of frame and roll it while the mag is swapped.
      const arc = Math.sin(Math.PI * (1 - input.reloadProgress));
      root.position.y -= arc * 0.16;
      root.position.z += arc * 0.05;
      root.rotation.x -= arc * 0.85;
      root.rotation.z += arc * 0.5;
    }
  }

  /** Where the muzzle currently is, in viewmodel space. */
  muzzleLocal(out: THREE.Vector3): THREE.Vector3 {
    if (!this.model) return out.set(0, 0, -0.5);
    this.model.muzzle.getWorldPosition(out);
    return out;
  }

  get adsAmount(): number {
    return this.adsBlend;
  }

  dispose(): void {
    if (this.model) this.holder.remove(this.model.root);
    this.scene.remove(this.holder);
  }
}

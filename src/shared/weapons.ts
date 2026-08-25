/** Weapon table. Both sides need identical numbers for prediction to line up. */

export const enum WeaponId {
  Pistol = 0,
  Smg = 1,
  Rifle = 2,
  Sniper = 3,
}

export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  readonly shortName: string;
  /** Damage to the torso at point-blank range. */
  readonly damage: number;
  readonly headshotMultiplier: number;
  readonly legMultiplier: number;
  readonly rpm: number;
  readonly automatic: boolean;
  readonly pellets: number;
  readonly magSize: number;
  readonly reserveAmmo: number;
  readonly reloadMs: number;
  /** Cone half-angles, in radians. */
  readonly spreadBase: number;
  readonly spreadPerShot: number;
  readonly spreadMax: number;
  readonly spreadRecoveryPerSec: number;
  readonly moveInaccuracy: number;
  readonly airInaccuracy: number;
  /** Per-shot view kick, in radians. */
  readonly recoilVertical: number;
  readonly recoilHorizontal: number;
  readonly recoilRecoveryPerSec: number;
  readonly range: number;
  /** Damage stays flat up to this distance, then decays toward `falloffMin`. */
  readonly falloffStart: number;
  readonly falloffMin: number;
  readonly moveSpeedMultiplier: number;
  readonly adsSpreadMultiplier: number;
  readonly adsFov: number;
  readonly tracerColor: number;
  /** Rough model dimensions for the first-person viewmodel, in meters. */
  readonly modelLength: number;
}

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: WeaponId.Pistol,
    name: 'P22 Sidearm',
    shortName: 'P22',
    damage: 27,
    headshotMultiplier: 3.4,
    legMultiplier: 0.75,
    rpm: 420,
    automatic: false,
    pellets: 1,
    magSize: 12,
    reserveAmmo: 72,
    reloadMs: 1750,
    spreadBase: 0.004,
    spreadPerShot: 0.012,
    spreadMax: 0.07,
    spreadRecoveryPerSec: 0.16,
    moveInaccuracy: 0.012,
    airInaccuracy: 0.05,
    recoilVertical: 0.014,
    recoilHorizontal: 0.005,
    recoilRecoveryPerSec: 0.12,
    range: 55,
    falloffStart: 18,
    falloffMin: 0.55,
    moveSpeedMultiplier: 1.05,
    adsSpreadMultiplier: 0.6,
    adsFov: 62,
    tracerColor: 0xffd27a,
    modelLength: 0.26,
  },
  {
    id: WeaponId.Smg,
    name: 'VX-9 SMG',
    shortName: 'VX-9',
    damage: 21,
    headshotMultiplier: 3.1,
    legMultiplier: 0.8,
    rpm: 880,
    automatic: true,
    pellets: 1,
    magSize: 32,
    reserveAmmo: 128,
    reloadMs: 2050,
    spreadBase: 0.006,
    spreadPerShot: 0.0085,
    spreadMax: 0.085,
    spreadRecoveryPerSec: 0.22,
    moveInaccuracy: 0.009,
    airInaccuracy: 0.06,
    recoilVertical: 0.0095,
    recoilHorizontal: 0.0055,
    recoilRecoveryPerSec: 0.2,
    range: 60,
    falloffStart: 14,
    falloffMin: 0.45,
    moveSpeedMultiplier: 1.0,
    adsSpreadMultiplier: 0.65,
    adsFov: 58,
    tracerColor: 0xbfe7ff,
    modelLength: 0.42,
  },
  {
    id: WeaponId.Rifle,
    name: 'KR-7 Rifle',
    shortName: 'KR-7',
    damage: 34,
    headshotMultiplier: 4,
    legMultiplier: 0.78,
    rpm: 600,
    automatic: true,
    pellets: 1,
    magSize: 30,
    reserveAmmo: 90,
    reloadMs: 2400,
    spreadBase: 0.0035,
    spreadPerShot: 0.011,
    spreadMax: 0.095,
    spreadRecoveryPerSec: 0.19,
    moveInaccuracy: 0.016,
    airInaccuracy: 0.075,
    recoilVertical: 0.0165,
    recoilHorizontal: 0.0075,
    recoilRecoveryPerSec: 0.17,
    range: 90,
    falloffStart: 30,
    falloffMin: 0.62,
    moveSpeedMultiplier: 0.93,
    adsSpreadMultiplier: 0.45,
    adsFov: 48,
    tracerColor: 0xffe2a8,
    modelLength: 0.62,
  },
  {
    id: WeaponId.Sniper,
    name: 'LR-50 Bolt',
    shortName: 'LR-50',
    damage: 118,
    headshotMultiplier: 2.2,
    legMultiplier: 0.85,
    rpm: 45,
    automatic: false,
    pellets: 1,
    magSize: 5,
    reserveAmmo: 25,
    reloadMs: 3400,
    spreadBase: 0.0012,
    spreadPerShot: 0.05,
    spreadMax: 0.12,
    spreadRecoveryPerSec: 0.09,
    moveInaccuracy: 0.055,
    airInaccuracy: 0.15,
    recoilVertical: 0.055,
    recoilHorizontal: 0.006,
    recoilRecoveryPerSec: 0.09,
    range: 140,
    falloffStart: 90,
    falloffMin: 0.85,
    moveSpeedMultiplier: 0.82,
    adsSpreadMultiplier: 0.06,
    adsFov: 22,
    tracerColor: 0xffffff,
    modelLength: 0.86,
  },
];

export const WEAPON_COUNT = WEAPONS.length;

export function getWeapon(id: number): WeaponDef {
  return WEAPONS[id] ?? (WEAPONS[WeaponId.Rifle] as WeaponDef);
}

export const fireIntervalMs = (w: WeaponDef): number => 60000 / w.rpm;

/** Linear damage falloff between `falloffStart` and `range`. */
export function damageAtDistance(w: WeaponDef, distance: number): number {
  if (distance <= w.falloffStart) return w.damage;
  if (distance >= w.range) return w.damage * w.falloffMin;
  const t = (distance - w.falloffStart) / (w.range - w.falloffStart);
  return w.damage * (1 - t * (1 - w.falloffMin));
}

export const enum HitZone {
  Body = 0,
  Head = 1,
  Legs = 2,
}

export function zoneMultiplier(w: WeaponDef, zone: HitZone): number {
  if (zone === HitZone.Head) return w.headshotMultiplier;
  if (zone === HitZone.Legs) return w.legMultiplier;
  return 1;
}

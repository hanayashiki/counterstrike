/** Weapon table. Both sides need identical numbers for prediction to line up. */

export const enum WeaponId {
  Pistol = 0,
  Smg = 1,
  Rifle = 2,
  Sniper = 3,
  Shotgun = 4,
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
  /**
   * Rounds that can be fired before the action has to cycle. 0 means the weapon
   * never stalls, which is every weapon except the DBS - it racks its pump
   * after each pair of shells.
   */
  readonly burstSize: number;
  /** Delay imposed once `burstSize` rounds have been fired, in ms. */
  readonly burstCycleMs: number;
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
  /**
   * True for magnified optics. Aiming one swaps the viewmodel out for a scope
   * overlay instead of holding the weapon in front of the camera - otherwise
   * the scope body sits in the middle of the screen and blocks the shot.
   */
  readonly scoped: boolean;
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
    burstSize: 0,
    burstCycleMs: 0,
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
    scoped: false,
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
    burstSize: 0,
    burstCycleMs: 0,
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
    scoped: false,
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
    burstSize: 0,
    burstCycleMs: 0,
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
    scoped: false,
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
    burstSize: 0,
    burstCycleMs: 0,
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
    scoped: true,
    tracerColor: 0xffffff,
    modelLength: 0.86,
  },
  {
    // Modelled on PUBG's DBS (a DP-12): a double-barrel bullpup that racks its
    // pump after every two shells, so it fires a fast pair and then stalls.
    // Nine pellets of 12 gauge - the largest burst in the game - paid for with
    // a punishing reload once all fourteen shells are gone.
    id: WeaponId.Shotgun,
    name: 'DBS Bullpup',
    shortName: 'DBS',
    damage: 20,
    // Nine pellets at 4x would be absurd, so the head bonus is modest; the
    // gun's lethality is already in the pellet count.
    headshotMultiplier: 1.6,
    legMultiplier: 0.85,
    rpm: 340,
    automatic: false,
    pellets: 9,
    burstSize: 2,
    burstCycleMs: 720,
    magSize: 14,
    reserveAmmo: 42,
    reloadMs: 4600,
    spreadBase: 0.046,
    spreadPerShot: 0.014,
    spreadMax: 0.1,
    spreadRecoveryPerSec: 0.24,
    moveInaccuracy: 0.01,
    airInaccuracy: 0.05,
    recoilVertical: 0.042,
    recoilHorizontal: 0.012,
    recoilRecoveryPerSec: 0.24,
    // Short and brutal. The source data has a pellet drop from 26 at the
    // muzzle to 18.1 at 10 m - a ~30% loss - and nothing much past 25 m, so
    // the curve is tuned to land on that ratio rather than to a round number.
    range: 24,
    falloffStart: 2,
    falloffMin: 0.2,
    moveSpeedMultiplier: 0.9,
    adsSpreadMultiplier: 0.74,
    adsFov: 66,
    scoped: false,
    tracerColor: 0xffc98a,
    modelLength: 0.58,
  },
];

export const WEAPON_COUNT = WEAPONS.length;

export function getWeapon(id: number): WeaponDef {
  return WEAPONS[id] ?? (WEAPONS[WeaponId.Rifle] as WeaponDef);
}

export const fireIntervalMs = (w: WeaponDef): number => 60000 / w.rpm;

/**
 * Delay owed after firing `shotsSinceCycle` rounds. For most weapons this is
 * just the fire interval; for the DBS, every second shell also racks the pump.
 * Shared so the server and the client's prediction stall at the same moment.
 */
export function shotDelayMs(w: WeaponDef, shotsSinceCycle: number): number {
  if (w.burstSize > 0 && shotsSinceCycle >= w.burstSize) return w.burstCycleMs;
  return fireIntervalMs(w);
}

/** Does this shot leave the action needing a cycle? */
export const cyclesAfterShot = (w: WeaponDef, shotsSinceCycle: number): boolean =>
  w.burstSize > 0 && shotsSinceCycle >= w.burstSize;

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

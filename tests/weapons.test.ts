import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WEAPONS,
  WEAPON_COUNT,
  WeaponId,
  cyclesAfterShot,
  damageAtDistance,
  fireIntervalMs,
  getWeapon,
  shotDelayMs,
} from '../src/shared/weapons';

test('the table is indexed by weapon id', () => {
  for (const [index, weapon] of WEAPONS.entries()) {
    assert.equal(weapon.id, index, `${weapon.shortName} is out of order`);
  }
  assert.equal(WEAPON_COUNT, WEAPONS.length);
});

test('getWeapon falls back rather than returning undefined', () => {
  assert.equal(getWeapon(WeaponId.Shotgun).shortName, 'DBS');
  assert.equal(getWeapon(99).id, WeaponId.Rifle);
  assert.equal(getWeapon(-1).id, WeaponId.Rifle);
});

test('every weapon is internally consistent', () => {
  for (const w of WEAPONS) {
    assert.ok(w.damage > 0 && w.pellets >= 1, w.shortName);
    assert.ok(w.magSize > 0 && w.reserveAmmo >= 0, w.shortName);
    assert.ok(w.falloffStart < w.range, `${w.shortName} falls off past its range`);
    assert.ok(w.falloffMin > 0 && w.falloffMin <= 1, w.shortName);
    assert.ok(w.spreadBase <= w.spreadMax, w.shortName);
    assert.ok(w.rpm > 0 && Number.isFinite(fireIntervalMs(w)), w.shortName);
    // A cycling weapon needs both halves configured or neither.
    assert.equal(w.burstSize > 0, w.burstCycleMs > 0, `${w.shortName} half-configured cycle`);
  }
});

test('the DBS matches its source stats', () => {
  const dbs = getWeapon(WeaponId.Shotgun);
  assert.equal(dbs.pellets, 9, 'nine pellets per shell');
  assert.equal(dbs.magSize, 14, 'fourteen shells');
  assert.equal(dbs.burstSize, 2, 'the pump racks after every two shells');
  assert.equal(dbs.automatic, false, 'single-shot method');
  assert.ok(dbs.reloadMs > 4000, 'reloading fourteen shells should hurt');
  assert.ok(dbs.spreadBase > 0.04, 'a shotgun needs a real cone');
});

test('the DBS stalls after every second shell, and not before', () => {
  const dbs = getWeapon(WeaponId.Shotgun);
  const interval = fireIntervalMs(dbs);

  // First shell of the pair: normal fire interval, no cycle.
  assert.equal(shotDelayMs(dbs, 1), interval);
  assert.equal(cyclesAfterShot(dbs, 1), false);

  // Second shell: the pump has to be racked.
  assert.equal(shotDelayMs(dbs, 2), dbs.burstCycleMs);
  assert.equal(cyclesAfterShot(dbs, 2), true);
  assert.ok(dbs.burstCycleMs > interval * 2, 'the rack should be clearly slower than the pair');
});

test('non-cycling weapons never stall', () => {
  for (const w of WEAPONS) {
    if (w.burstSize > 0) continue;
    for (const shots of [1, 2, 5, 30]) {
      assert.equal(shotDelayMs(w, shots), fireIntervalMs(w), w.shortName);
      assert.equal(cyclesAfterShot(w, shots), false, w.shortName);
    }
  }
});

test('the DBS falloff curve reproduces the source data', () => {
  const dbs = getWeapon(WeaponId.Shotgun);
  // Source: 26 damage per pellet at the muzzle, 18.1 at 10 m.
  const ratioAtTen = damageAtDistance(dbs, 10) / dbs.damage;
  assert.ok(
    Math.abs(ratioAtTen - 18.1 / 26) < 0.03,
    `10 m falloff is ${ratioAtTen.toFixed(3)}, source says ${(18.1 / 26).toFixed(3)}`,
  );
});

test('a full DBS pellet spread is lethal up close and weak at range', () => {
  const dbs = getWeapon(WeaponId.Shotgun);
  const pointBlank = damageAtDistance(dbs, 1) * dbs.pellets;
  const atTen = damageAtDistance(dbs, 10) * dbs.pellets;
  const atRange = damageAtDistance(dbs, dbs.range) * dbs.pellets;

  assert.ok(pointBlank > 150, `point blank only did ${pointBlank}`);
  assert.ok(atTen < pointBlank * 0.8, 'damage should fall off sharply by 10 m');
  assert.ok(atRange < 60, `still doing ${atRange} at maximum range`);
  // It must not out-range the rifle it is trading close-quarters power for.
  assert.ok(dbs.range < getWeapon(WeaponId.Rifle).range * 0.5, 'the DBS should be short-ranged');
});

test('damage falloff is monotonic and bounded for every weapon', () => {
  for (const w of WEAPONS) {
    let previous = Infinity;
    for (let d = 0; d <= w.range + 20; d += 2) {
      const damage = damageAtDistance(w, d);
      assert.ok(damage <= previous + 1e-9, `${w.shortName} damage rose at ${d} m`);
      assert.ok(damage >= w.damage * w.falloffMin - 1e-9, `${w.shortName} fell below its floor`);
      previous = damage;
    }
  }
});

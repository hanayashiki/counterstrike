/**
 * Procedural weapon meshes. Each gun is a handful of boxes, built once per
 * weapon id and cloned for the viewmodel and for third-person avatars.
 * Local space: the barrel points down -Z, the grip hangs at -Y.
 */
import * as THREE from 'three';

import { type WeaponDef, WeaponId } from '../../shared/weapons';

const GUNMETAL = new THREE.MeshStandardMaterial({
  color: 0x2b3038,
  roughness: 0.42,
  metalness: 0.86,
});
const POLYMER = new THREE.MeshStandardMaterial({
  color: 0x17191d,
  roughness: 0.78,
  metalness: 0.12,
});
const ACCENT = new THREE.MeshStandardMaterial({
  color: 0xc9713a,
  roughness: 0.5,
  metalness: 0.35,
});
const GLASS = new THREE.MeshStandardMaterial({
  color: 0x7fd4ff,
  roughness: 0.15,
  metalness: 0.1,
  emissive: 0x1b4a63,
  emissiveIntensity: 1.4,
  transparent: true,
  opacity: 0.45,
  depthWrite: false,
});

function block(
  parent: THREE.Object3D,
  material: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  rotX = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  mesh.position.set(x, y, z);
  mesh.rotation.x = rotX;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

export interface WeaponModel {
  root: THREE.Group;
  /** Local-space position where the muzzle flash belongs. */
  muzzle: THREE.Object3D;
}

export function buildWeaponModel(def: WeaponDef): WeaponModel {
  const root = new THREE.Group();
  root.name = `weapon-${def.shortName}`;
  const length = def.modelLength;

  // Receiver / body.
  block(root, GUNMETAL, 0.062, 0.088, length * 0.52, 0, 0, -length * 0.1);
  // Barrel.
  block(root, GUNMETAL, 0.03, 0.03, length * 0.5, 0, 0.012, -length * 0.55);
  // Handguard.
  block(root, POLYMER, 0.05, 0.05, length * 0.3, 0, -0.008, -length * 0.45);
  // Grip.
  block(root, POLYMER, 0.05, 0.11, 0.05, 0, -0.085, length * 0.05, 0.28);
  // Magazine.
  if (def.id !== WeaponId.Pistol) {
    block(root, POLYMER, 0.04, 0.13, 0.05, 0, -0.095, -length * 0.12, -0.14);
  }
  // Stock.
  if (def.id === WeaponId.Rifle || def.id === WeaponId.Sniper) {
    block(root, POLYMER, 0.045, 0.075, length * 0.28, 0, -0.012, length * 0.24);
  }
  // Iron sight / rail.
  block(root, GUNMETAL, 0.02, 0.018, length * 0.34, 0, 0.056, -length * 0.16);

  if (def.id === WeaponId.Sniper) {
    const scope = block(root, GUNMETAL, 0.05, 0.05, 0.22, 0, 0.088, -length * 0.1);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.021, 16), GLASS);
    lens.position.set(0, 0, 0.111);
    scope.add(lens);
  }

  if (def.id === WeaponId.Smg) {
    block(root, ACCENT, 0.066, 0.014, 0.07, 0, 0.048, -length * 0.02);
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.014, -length * 0.82);
  root.add(muzzle);

  return { root, muzzle };
}

const cache = new Map<WeaponId, WeaponModel>();

/** Clone a cached prototype so every avatar does not rebuild the geometry. */
export function cloneWeaponModel(def: WeaponDef): WeaponModel {
  let prototypeModel = cache.get(def.id);
  if (!prototypeModel) {
    prototypeModel = buildWeaponModel(def);
    cache.set(def.id, prototypeModel);
  }
  const root = prototypeModel.root.clone(true);
  const muzzle = root.children.find((child) => child.type === 'Object3D') ?? new THREE.Object3D();
  if (!root.children.includes(muzzle)) root.add(muzzle);
  return { root, muzzle };
}

/**
 * Loading and instancing rigged character models.
 *
 * Models are optional. A character that declares no `modelUrl`, or whose asset
 * fails to load, falls back to the procedural figure — the game has always
 * shipped without art assets and must keep working without them.
 *
 * Loaded scenes are normalised on arrival: scaled so the figure is exactly
 * `PLAYER_HEIGHT` tall and shifted so its feet sit at y = 0, because the rest
 * of the renderer positions players by their feet and the server's hull assumes
 * that height. An artist's model arriving at 1.51 m or 100 cm is not something
 * the rest of the code should have to know about.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { PLAYER_HEIGHT } from '../../shared/config';

export interface LoadedModel {
  /** Normalised: upright, feet at the origin, PLAYER_HEIGHT tall. */
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export interface ModelInstance {
  root: THREE.Group;
  /** Right hand bone, for parenting a weapon. Null on an unrecognised rig. */
  weaponHand: THREE.Bone | null;
  setTeamColor(hex: number): void;
  /**
   * Advance the pose. `speed` is horizontal metres per second; `pitch` and
   * `lean` bend the spine so the model aims and peeks like the player does.
   */
  update(dt: number, speed: number, pitch?: number, lean?: number): void;
  dispose(): void;
}

const cache = new Map<string, Promise<LoadedModel | null>>();
const loader = new GLTFLoader();

/**
 * Fetch and normalise a model. Resolves to null rather than rejecting: a
 * missing asset should downgrade the look, not take the client down.
 */
export function loadModel(url: string): Promise<LoadedModel | null> {
  const existing = cache.get(url);
  if (existing) return existing;

  const pending = loader
    .loadAsync(url)
    .then((gltf) => normalise(url, gltf))
    .catch((error: unknown) => {
      console.warn(`character model ${url} unavailable, using the procedural figure`, error);
      return null;
    });

  cache.set(url, pending);
  return pending;
}

/**
 * Parse a model already held in memory.
 *
 * `loadModel` goes through GLTFLoader's FileLoader, which calls `fetch` — and a
 * sandbox with a strict `connect-src` will refuse that even for a `data:` URI.
 * Parsing an ArrayBuffer we already have touches the network not at all, which
 * is what makes the single-file build work when opened straight off disk.
 */
export function parseModel(key: string, data: ArrayBuffer): Promise<LoadedModel | null> {
  const existing = cache.get(key);
  if (existing) return existing;

  const pending = new Promise<LoadedModel | null>((resolve) => {
    loader.parse(
      data,
      '',
      (gltf) => resolve(normalise(key, gltf)),
      (error: unknown) => {
        console.warn(`character model ${key} failed to parse`, error);
        resolve(null);
      },
    );
  });

  cache.set(key, pending);
  return pending;
}

/** Decode a base64 payload embedded in the page into a model. */
export function parseModelBase64(key: string, base64: string): Promise<LoadedModel | null> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return parseModel(key, bytes.buffer);
}

/**
 * Stand the model up, scale it to the hull, and put its feet at the origin, so
 * the rest of the renderer never has to know what units it was authored in.
 */
function normalise(
  key: string,
  gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] },
): LoadedModel {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!(size.y > 0.01)) throw new Error(`${key} has no height`);

  // Some exports are Z-up; if the figure is lying down, stand it up first.
  if (size.z > size.y * 1.4) {
    scene.rotateX(-Math.PI / 2);
    scene.updateMatrixWorld(true);
    box.setFromObject(scene);
    box.getSize(size);
  }

  const scale = PLAYER_HEIGHT / size.y;
  scene.scale.multiplyScalar(scale);
  scene.position.set(
    -((box.min.x + box.max.x) / 2) * scale,
    -box.min.y * scale,
    -((box.min.z + box.max.z) / 2) * scale,
  );

  const wrapper = new THREE.Group();
  wrapper.add(scene);
  wrapper.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    const material = object.material;
    if (material instanceof THREE.MeshStandardMaterial) material.roughness = 0.82;
  });

  const loaded: LoadedModel = { scene: wrapper, animations: gltf.animations };
  resolved.set(key, loaded);
  return loaded;
}

/** Load every distinct model up front so nobody pops in mid-match. */
export async function preloadModels(urls: readonly string[]): Promise<void> {
  await Promise.all([...new Set(urls)].map((url) => loadModel(url)));
}

const resolved = new Map<string, LoadedModel>();

/**
 * Already-loaded model for a url, or null. Synchronous, because avatars are
 * built inside the render loop and cannot await.
 */
export function peekModel(url: string): LoadedModel | null {
  return resolved.get(url) ?? null;
}

/**
 * Bone names on the pack's rig (a standard UE-style humanoid). Calibrated by
 * probing each joint and watching where the tip moved, not guessed:
 *
 *   upperarm.z  lowers the arm from the T-pose
 *   upperarm.y  swings it forward (negative) or back
 *   lowerarm.x  is the elbow; negative flexes the hand forward
 *   thigh.x     swings the leg forward
 *   calf.x      is the knee; negative flexes the heel back
 *
 * A model whose bones are named differently simply will not be posed — the
 * lookups return undefined and the figure stands in its bind pose.
 */
interface Rig {
  spine?: THREE.Bone;
  head?: THREE.Bone;
  upperArm: (THREE.Bone | undefined)[];
  foreArm: (THREE.Bone | undefined)[];
  hand: (THREE.Bone | undefined)[];
  thigh: (THREE.Bone | undefined)[];
  calf: (THREE.Bone | undefined)[];
}

/**
 * Weapon carry, expressed as the world direction each bone should point.
 *
 * Setting Euler angles per joint means knowing each bone's local axes AND
 * whether the rig mirrors them across the body — this one does not, so the
 * naive `-1` on the left arm swung it outward instead of down. Aiming a bone
 * along a direction avoids the question entirely and works on any rig.
 */
const CARRY = {
  /** Down and a little forward. */
  upperArm: new THREE.Vector3(0, -0.94, -0.34),
  /**
   * Forward and down, angled in toward the weapon. `x` is scaled by side.
   * This is the most weapon-forward carry that keeps the hands — fingers
   * included, which are what actually reach furthest — inside the hull; found
   * by sweeping the pose over the real rig, not by eye.
   */
  foreArm: new THREE.Vector3(0.24, -0.85, -0.5),
};

const scratchAxis = new THREE.Vector3();
const scratchDir = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

/**
 * Point a bone along a world direction.
 *
 * A bone's own axis is the direction of its child in local space, so mapping
 * that onto the target direction (expressed in the parent's frame) gives the
 * rotation, whatever convention the rig was authored with.
 */
function aimBone(bone: THREE.Bone, child: THREE.Object3D, worldDir: THREE.Vector3): void {
  scratchAxis.copy(child.position);
  if (scratchAxis.lengthSq() < 1e-9) return;
  scratchAxis.normalize();

  const parent = bone.parent;
  if (!parent) return;
  parent.getWorldQuaternion(scratchQuat).invert();
  scratchDir.copy(worldDir).normalize().applyQuaternion(scratchQuat);

  bone.quaternion.setFromUnitVectors(scratchAxis, scratchDir);
  bone.updateMatrixWorld(true);
}

const WALK_CYCLE_SPEED = 3.2;
/**
 * Peak thigh swing, in radians. This rig's legs are ~0.9 m, so the generous
 * amplitude the procedural figure used opens a full metre of stride here.
 */
const SWING_AMPLITUDE = 0.34;

function findRig(root: THREE.Object3D): Rig {
  const bones = new Map<string, THREE.Bone>();
  root.traverse((object) => {
    if ((object as THREE.Bone).isBone) bones.set(object.name.toLowerCase(), object as THREE.Bone);
  });
  const get = (name: string) => bones.get(name);
  return {
    spine: get('spine_02') ?? get('spine_01'),
    head: get('head'),
    upperArm: [get('upperarm_l'), get('upperarm_r')],
    foreArm: [get('lowerarm_l'), get('lowerarm_r')],
    hand: [get('hand_l'), get('hand_r')],
    thigh: [get('thigh_l'), get('thigh_r')],
    calf: [get('calf_l'), get('calf_r')],
  };
}

export function instantiate(model: LoadedModel, teamColor: number): ModelInstance {
  // SkeletonUtils.clone is required rather than Object3D.clone: a plain clone
  // shares the skeleton, so every player would animate as one.
  const root = cloneSkinned(model.scene) as THREE.Group;

  // Materials are shared by the clone; each instance needs its own to be tinted.
  const tintable: THREE.MeshStandardMaterial[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const source = object.material;
    const materials = Array.isArray(source) ? source : [source];
    const copies = materials.map((m) => {
      const copy = m.clone() as THREE.MeshStandardMaterial;
      if (copy instanceof THREE.MeshStandardMaterial) tintable.push(copy);
      return copy;
    });
    object.material = Array.isArray(source) ? copies : (copies[0] as THREE.Material);
  });

  const rig = findRig(root);

  /**
   * Bind-pose rotations. A joint's rest rotation is rarely identity, so
   * assigning `bone.rotation.x = 0` does not mean "neutral" - it destroys the
   * rig's rest pose. Every joint angle below is applied as a delta from this.
   */
  const rest = new Map<THREE.Bone, THREE.Quaternion>();
  const remember = (bone: THREE.Bone | undefined) => {
    if (bone && !rest.has(bone)) rest.set(bone, bone.quaternion.clone());
  };
  for (const bone of [...rig.thigh, ...rig.calf, rig.spine, rig.head]) remember(bone);

  const deltaAxis = new THREE.Vector3(1, 0, 0);
  const deltaQuat = new THREE.Quaternion();
  /** Rotate a joint by `angle` about its local X, from its bind pose. */
  const bend = (bone: THREE.Bone | undefined, angle: number): void => {
    const base = bone && rest.get(bone);
    if (!bone || !base) return;
    bone.quaternion.copy(base).multiply(deltaQuat.setFromAxisAngle(deltaAxis, angle));
  };
  const mixer = model.animations.length > 0 ? new THREE.AnimationMixer(root) : null;
  const walkClip = model.animations[0];
  const walkAction = mixer && walkClip ? mixer.clipAction(walkClip) : null;
  walkAction?.play();

  /** Take the arms out of the T-pose. Re-applied whenever the walk sways them. */
  const poseArms = (sway = 0): void => {
    root.updateMatrixWorld(true);
    for (const side of [0, 1]) {
      // index 0 is the left bone, whose hand sits toward +X on this rig.
      const inward = side === 0 ? -1 : 1;
      const upper = rig.upperArm[side];
      const fore = rig.foreArm[side];
      if (!upper || !fore) continue;

      scratchDir.copy(CARRY.upperArm);
      scratchDir.z -= sway * inward * 0.22;
      aimBone(upper, fore, scratchDir);

      const hand = fore.children[0];
      if (!hand) continue;
      aimBone(
        fore,
        hand,
        scratchDir.set(CARRY.foreArm.x * inward, CARRY.foreArm.y, CARRY.foreArm.z),
      );
    }
  };
  poseArms();

  // A team-coloured band across the chest, parented to the spine so it follows
  // the body. Without it the only team cue would be a full-body dye.
  const bandMaterial = new THREE.MeshStandardMaterial({
    color: teamColor,
    roughness: 0.5,
    metalness: 0.2,
  });
  const bandGeometry = new THREE.CylinderGeometry(0.185, 0.195, 0.075, 16, 1, true);
  const band = new THREE.Mesh(bandGeometry, bandMaterial);
  band.castShadow = true;
  if (rig.spine) {
    // The band lives in bone space, so it inherits the rig's own scale.
    const spineScale = new THREE.Vector3();
    rig.spine.getWorldScale(spineScale);
    band.scale.setScalar(1 / Math.max(0.001, spineScale.x));
    band.position.set(0, 0.13, 0);
    rig.spine.add(band);
  } else {
    band.position.set(0, 1.35, 0);
    root.add(band);
  }

  let stride = 0;
  const base = new THREE.Color();
  const WHITE = new THREE.Color(0xffffff);

  const instance: ModelInstance = {
    root,
    weaponHand: rig.hand[1] ?? null,
    setTeamColor(hex: number) {
      // Only a wash over the model's own texture — these are skin and cloth,
      // and dyeing the whole body team-colour makes a person look plastic. The
      // team read comes from the band instead.
      base.setHex(hex);
      for (const material of tintable) {
        material.color.copy(base).lerp(WHITE, 0.86);
      }
      bandMaterial.color.setHex(hex);
      bandMaterial.emissive.setHex(hex).multiplyScalar(0.25);
    },
    update(dt: number, speed: number, pitch = 0, lean = 0) {
      if (walkAction) {
        walkAction.timeScale = Math.min(2.4, speed / WALK_CYCLE_SPEED);
        walkAction.paused = speed < 0.35;
        mixer?.update(dt);
        return;
      }

      // No clips in the pack, so the walk is driven directly on the bones.
      stride += speed * dt * 3.2;
      const gait = Math.min(1, speed / 6);
      const swing = Math.sin(stride) * SWING_AMPLITUDE * gait;

      for (const side of [0, 1]) {
        const phase = side === 0 ? swing : -swing;
        bend(rig.thigh[side], phase);
        // The knee only bends on the backswing, or the legs read as scissors.
        bend(rig.calf[side], -Math.max(0, -phase) * 1.15);
      }
      poseArms(swing);

      bend(rig.spine, -pitch * 0.3);
      bend(rig.head, -pitch * 0.4);
      void lean;
    },
    dispose() {
      mixer?.stopAllAction();
      for (const material of tintable) material.dispose();
      bandGeometry.dispose();
      bandMaterial.dispose();
    },
  };

  instance.setTeamColor(teamColor);
  return instance;
}

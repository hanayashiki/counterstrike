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
  setTeamColor(hex: number): void;
  /** Advance the walk cycle; `speed` is horizontal metres per second. */
  update(dt: number, speed: number): void;
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

const WALK_CYCLE_SPEED = 3.4;

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

  const mixer = new THREE.AnimationMixer(root);
  const clip = model.animations[0] ?? null;
  const walk = clip ? mixer.clipAction(clip) : null;
  walk?.play();

  const base = new THREE.Color();
  const instance: ModelInstance = {
    root,
    setTeamColor(hex: number) {
      // Tint toward the team colour without washing out the model's own texture.
      base.setHex(hex);
      for (const material of tintable) {
        material.color.copy(base).lerp(new THREE.Color(0xffffff), 0.45);
        material.emissive.copy(base).multiplyScalar(0.1);
      }
    },
    update(dt: number, speed: number) {
      if (walk) {
        // One clip, so the walk is driven by ground speed and paused at rest.
        walk.timeScale = Math.min(2.4, speed / WALK_CYCLE_SPEED);
        walk.paused = speed < 0.35;
      }
      mixer.update(dt);
    },
    dispose() {
      mixer.stopAllAction();
      for (const material of tintable) material.dispose();
    },
  };

  instance.setTeamColor(teamColor);
  return instance;
}

/**
 * Turns the shared map definition into renderable geometry. The visual mesh is
 * generated from the very same brushes the server collides against, so what
 * you see is exactly what you can walk into.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { GAME_MAP, type MapSolid, type SurfaceKind } from '../../shared/map';
import { createSurfaceTexture } from './textures';

interface SurfaceStyle {
  color: number;
  roughness: number;
  metalness: number;
  /** World-units per texture tile. */
  tile: number;
  base: string;
  line: string;
  cells: number;
  emissive?: number;
}

const STYLES: Record<SurfaceKind, SurfaceStyle> = {
  floor: {
    color: 0x8d97a6,
    roughness: 0.94,
    metalness: 0.02,
    tile: 2,
    base: '#5d6673',
    line: 'rgba(0,0,0,0.35)',
    cells: 4,
  },
  wall: {
    color: 0x99a2ae,
    roughness: 0.88,
    metalness: 0.05,
    tile: 2.5,
    base: '#6d7686',
    line: 'rgba(0,0,0,0.28)',
    cells: 2,
  },
  crate: {
    color: 0xc08a4e,
    roughness: 0.8,
    metalness: 0.04,
    tile: 1.2,
    base: '#8a6134',
    line: 'rgba(0,0,0,0.4)',
    cells: 2,
  },
  platform: {
    color: 0x7f8c9e,
    roughness: 0.7,
    metalness: 0.25,
    tile: 2,
    base: '#59636f',
    line: 'rgba(140,190,255,0.18)',
    cells: 4,
  },
  accent: {
    color: 0x4f6379,
    roughness: 0.5,
    metalness: 0.45,
    tile: 2,
    base: '#3b4a5c',
    line: 'rgba(120,190,255,0.35)',
    cells: 3,
    emissive: 0x0a2136,
  },
};

/**
 * Box geometry whose UVs are scaled by each face's real dimensions, so the
 * texture tiles at a constant world scale no matter how big the brush is.
 */
function tiledBox(sx: number, sy: number, sz: number, tile: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry emits faces in order: +X, -X, +Y, -Y, +Z, -Z (4 verts each).
  const spans: [number, number][] = [
    [sz, sy],
    [sz, sy],
    [sx, sz],
    [sx, sz],
    [sx, sy],
    [sx, sy],
  ];
  for (let face = 0; face < 6; face++) {
    const [u, v] = spans[face] as [number, number];
    for (let i = 0; i < 4; i++) {
      const index = face * 4 + i;
      uv.setXY(index, uv.getX(index) * (u / tile), uv.getY(index) * (v / tile));
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

export interface WorldMesh {
  group: THREE.Group;
  dispose(): void;
}

export function buildWorld(scene: THREE.Scene): WorldMesh {
  const group = new THREE.Group();
  group.name = 'world';

  const byKind = new Map<SurfaceKind, MapSolid[]>();
  for (const solid of GAME_MAP.solids) {
    const list = byKind.get(solid.kind);
    if (list) list.push(solid);
    else byKind.set(solid.kind, [solid]);
  }

  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  for (const [kind, solids] of byKind) {
    const style = STYLES[kind];
    const texture = createSurfaceTexture(style.base, style.line, style.cells);
    disposables.push(texture);

    const geometries: THREE.BufferGeometry[] = [];
    for (const solid of solids) {
      const b = solid.brush;
      const geometry = tiledBox(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, style.tile);
      geometry.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
      geometries.push(geometry);
    }

    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    disposables.push(merged);

    const material = new THREE.MeshStandardMaterial({
      color: style.color,
      map: texture,
      roughness: style.roughness,
      metalness: style.metalness,
      emissive: new THREE.Color(style.emissive ?? 0x000000),
      emissiveIntensity: style.emissive ? 1 : 0,
    });
    disposables.push(material);

    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `world-${kind}`;
    mesh.castShadow = kind !== 'floor';
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // A faint horizon glow so the skybox is not a flat void.
  const skyGeometry = new THREE.SphereGeometry(180, 24, 16);
  const skyMaterial = new THREE.MeshBasicMaterial({
    color: GAME_MAP.skyColor,
    side: THREE.BackSide,
    fog: false,
  });
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  disposables.push(skyGeometry, skyMaterial);
  group.add(sky);

  scene.add(group);

  return {
    group,
    dispose() {
      scene.remove(group);
      for (const item of disposables) item.dispose();
    },
  };
}

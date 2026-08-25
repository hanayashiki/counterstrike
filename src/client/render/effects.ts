/**
 * Pooled combat visuals: tracers, impact decals, sparks, blood and muzzle
 * flashes. Everything is preallocated - a firefight must not trigger GC.
 */
import * as THREE from 'three';

import type { Vec3 } from '../../shared/math';
import { createGlowTexture, createImpactTexture } from './textures';

const TRACER_COUNT = 64;
const DECAL_COUNT = 96;
const PARTICLE_COUNT = 220;
const FLASH_COUNT = 12;

const TRACER_LIFE = 0.075;
const DECAL_LIFE = 9;
const FLASH_LIFE = 0.045;

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
}

interface Decal {
  mesh: THREE.Mesh;
  life: number;
}

interface Particle {
  sprite: THREE.Sprite;
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  gravity: number;
}

interface Flash {
  sprite: THREE.Sprite;
  light: THREE.PointLight;
  life: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

export class EffectsSystem {
  private readonly tracers: Tracer[] = [];
  private readonly decals: Decal[] = [];
  private readonly particles: Particle[] = [];
  private readonly flashes: Flash[] = [];

  private tracerCursor = 0;
  private decalCursor = 0;
  private particleCursor = 0;
  private flashCursor = 0;

  private readonly glow = createGlowTexture();
  private readonly impactTexture = createImpactTexture();

  private readonly tracerMaterial = new THREE.MeshBasicMaterial({
    color: 0xffe6b0,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });

  private readonly decalMaterial: THREE.MeshBasicMaterial;

  constructor(private readonly scene: THREE.Scene) {
    const tracerGeometry = new THREE.CylinderGeometry(0.013, 0.013, 1, 5, 1, true);
    tracerGeometry.translate(0, 0.5, 0);
    for (let i = 0; i < TRACER_COUNT; i++) {
      const mesh = new THREE.Mesh(tracerGeometry, this.tracerMaterial.clone());
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    this.decalMaterial = new THREE.MeshBasicMaterial({
      map: this.impactTexture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      opacity: 1,
    });
    const decalGeometry = new THREE.PlaneGeometry(0.16, 0.16);
    for (let i = 0; i < DECAL_COUNT; i++) {
      const mesh = new THREE.Mesh(decalGeometry, this.decalMaterial.clone());
      mesh.visible = false;
      scene.add(mesh);
      this.decals.push({ mesh, life: 0 });
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const material = new THREE.SpriteMaterial({
        map: this.glow,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      scene.add(sprite);
      this.particles.push({
        sprite,
        life: 0,
        maxLife: 1,
        vx: 0,
        vy: 0,
        vz: 0,
        size: 0.05,
        gravity: 9,
      });
    }

    for (let i = 0; i < FLASH_COUNT; i++) {
      const material = new THREE.SpriteMaterial({
        map: this.glow,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        color: 0xffdc9a,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.scale.setScalar(0.55);
      scene.add(sprite);
      const light = new THREE.PointLight(0xffc978, 0, 7, 2);
      light.visible = false;
      scene.add(light);
      this.flashes.push({ sprite, light, life: 0 });
    }
  }

  spawnTracer(from: Vec3, to: Vec3, color: number): void {
    const tracer = this.tracers[this.tracerCursor] as Tracer;
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;

    scratchA.set(from.x, from.y, from.z);
    scratchB.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const length = scratchB.length();
    if (length < 0.05) return;
    scratchB.normalize();

    tracer.mesh.position.copy(scratchA);
    scratchQuat.setFromUnitVectors(UP, scratchB);
    tracer.mesh.quaternion.copy(scratchQuat);
    tracer.mesh.scale.set(1, length, 1);
    tracer.mesh.visible = true;
    (tracer.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    (tracer.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
    tracer.life = TRACER_LIFE;
  }

  spawnImpact(point: Vec3, normal: Vec3): void {
    const decal = this.decals[this.decalCursor] as Decal;
    this.decalCursor = (this.decalCursor + 1) % this.decals.length;

    decal.mesh.position.set(
      point.x + normal.x * 0.012,
      point.y + normal.y * 0.012,
      point.z + normal.z * 0.012,
    );
    scratchB.set(normal.x, normal.y, normal.z);
    if (scratchB.lengthSq() < 1e-6) scratchB.set(0, 1, 0);
    decal.mesh.lookAt(
      decal.mesh.position.x + scratchB.x,
      decal.mesh.position.y + scratchB.y,
      decal.mesh.position.z + scratchB.z,
    );
    decal.mesh.rotateZ(Math.random() * Math.PI);
    decal.mesh.visible = true;
    (decal.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    decal.life = DECAL_LIFE;

    this.burst(point, normal, 7, 0xffc47a, 2.4, 0.045, 0.28);
  }

  spawnBlood(point: Vec3, direction: Vec3): void {
    this.burst(point, direction, 12, 0xd2312a, 2.8, 0.07, 0.42);
  }

  spawnMuzzleFlash(point: Vec3, direction: Vec3, intensity = 1): void {
    const flash = this.flashes[this.flashCursor] as Flash;
    this.flashCursor = (this.flashCursor + 1) % this.flashes.length;

    flash.sprite.position.set(point.x, point.y, point.z);
    flash.sprite.scale.setScalar(0.42 + Math.random() * 0.18 * intensity);
    flash.sprite.visible = true;
    (flash.sprite.material as THREE.SpriteMaterial).opacity = 1;

    flash.light.position.set(
      point.x + direction.x * 0.2,
      point.y + direction.y * 0.2,
      point.z + direction.z * 0.2,
    );
    flash.light.intensity = 9 * intensity;
    flash.light.visible = true;
    flash.life = FLASH_LIFE;
  }

  private burst(
    point: Vec3,
    normal: Vec3,
    count: number,
    color: number,
    speed: number,
    size: number,
    life: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const particle = this.particles[this.particleCursor] as Particle;
      this.particleCursor = (this.particleCursor + 1) % this.particles.length;

      particle.sprite.position.set(point.x, point.y, point.z);
      const spread = 0.85;
      particle.vx = normal.x * speed + (Math.random() - 0.5) * speed * spread;
      particle.vy = normal.y * speed + (Math.random() - 0.5) * speed * spread + speed * 0.25;
      particle.vz = normal.z * speed + (Math.random() - 0.5) * speed * spread;
      particle.maxLife = life * (0.6 + Math.random() * 0.7);
      particle.life = particle.maxLife;
      particle.size = size * (0.7 + Math.random() * 0.7);
      particle.gravity = 11;
      particle.sprite.scale.setScalar(particle.size);
      particle.sprite.visible = true;
      const material = particle.sprite.material as THREE.SpriteMaterial;
      material.color.setHex(color);
      material.opacity = 1;
    }
  }

  update(dt: number): void {
    for (const tracer of this.tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= dt;
      const material = tracer.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = Math.max(0, tracer.life / TRACER_LIFE) * 0.85;
      if (tracer.life <= 0) tracer.mesh.visible = false;
    }

    for (const decal of this.decals) {
      if (decal.life <= 0) continue;
      decal.life -= dt;
      const material = decal.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = Math.min(1, decal.life / 2);
      if (decal.life <= 0) decal.mesh.visible = false;
    }

    for (const particle of this.particles) {
      if (particle.life <= 0) continue;
      particle.life -= dt;
      if (particle.life <= 0) {
        particle.sprite.visible = false;
        continue;
      }
      particle.vy -= particle.gravity * dt;
      particle.sprite.position.x += particle.vx * dt;
      particle.sprite.position.y += particle.vy * dt;
      particle.sprite.position.z += particle.vz * dt;
      const k = particle.life / particle.maxLife;
      (particle.sprite.material as THREE.SpriteMaterial).opacity = k;
      particle.sprite.scale.setScalar(particle.size * (0.4 + k * 0.6));
    }

    for (const flash of this.flashes) {
      if (flash.life <= 0) continue;
      flash.life -= dt;
      const k = Math.max(0, flash.life / FLASH_LIFE);
      (flash.sprite.material as THREE.SpriteMaterial).opacity = k;
      flash.light.intensity = 9 * k;
      if (flash.life <= 0) {
        flash.sprite.visible = false;
        flash.light.visible = false;
      }
    }
  }

  dispose(): void {
    for (const tracer of this.tracers) this.scene.remove(tracer.mesh);
    for (const decal of this.decals) this.scene.remove(decal.mesh);
    for (const particle of this.particles) this.scene.remove(particle.sprite);
    for (const flash of this.flashes) {
      this.scene.remove(flash.sprite);
      this.scene.remove(flash.light);
    }
    this.glow.dispose();
    this.impactTexture.dispose();
    this.tracerMaterial.dispose();
    this.decalMaterial.dispose();
  }
}

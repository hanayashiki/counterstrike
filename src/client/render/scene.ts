/**
 * Renderer, cameras and lighting.
 *
 * The first-person weapon lives in its own scene with its own narrow-FOV
 * camera, drawn after a depth clear. That is the standard trick to stop the
 * viewmodel from poking through walls without hacking the depth range.
 */
import * as THREE from 'three';

import { GAME_MAP } from '../../shared/map';

export const DEFAULT_FOV = 82;

export class RenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly viewmodelScene = new THREE.Scene();
  readonly viewmodelCamera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;

  private targetFov = DEFAULT_FOV;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;

    this.scene.background = new THREE.Color(GAME_MAP.skyColor);
    this.scene.fog = new THREE.Fog(GAME_MAP.fogColor, 34, 96);

    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.06, 400);
    this.camera.rotation.order = 'YXZ';

    this.viewmodelCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 8);

    const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x1b2130, 1.05);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.5);
    this.sun.position.set(26, 44, 18);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 5;
    this.sun.shadow.camera.far = 130;
    this.sun.shadow.camera.left = -46;
    this.sun.shadow.camera.right = 46;
    this.sun.shadow.camera.top = 46;
    this.sun.shadow.camera.bottom = -46;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const rim = new THREE.DirectionalLight(0x6ea8ff, 0.35);
    rim.position.set(-30, 20, -26);
    this.scene.add(rim);

    // Matches the world lighting so the weapon does not look pasted on.
    const vmKey = new THREE.DirectionalLight(0xffffff, 2.1);
    vmKey.position.set(1.4, 2.4, 2.2);
    this.viewmodelScene.add(vmKey);
    this.viewmodelScene.add(new THREE.AmbientLight(0x8fa8c8, 1.1));

    this.resize();
    globalThis.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const width = globalThis.innerWidth;
    const height = globalThis.innerHeight;
    this.renderer.setSize(width, height, false);
    const aspect = width / Math.max(1, height);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = aspect;
    this.viewmodelCamera.updateProjectionMatrix();
  }

  /** Smoothly move toward the requested field of view (used when aiming). */
  setFov(fov: number, dt: number): void {
    this.targetFov = fov;
    const next = this.camera.fov + (this.targetFov - this.camera.fov) * Math.min(1, dt * 14);
    if (Math.abs(next - this.camera.fov) > 0.01) {
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
    }
  }

  render(): void {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.viewmodelScene, this.viewmodelCamera);
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }
}

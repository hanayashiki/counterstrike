/**
 * A turntable for the operator models.
 *
 * The whole point is to look at the same geometry the game builds, lit the same
 * way, so this imports `buildFigure` directly rather than reproducing it. The
 * hitbox toggle draws the collision hull every model has to fit inside.
 */
import * as THREE from 'three';

import { buildFigure } from '../client/render/figure';
import {
  type ModelInstance,
  instantiate,
  loadModel,
  parseModelBase64,
} from '../client/render/model';
import { cloneWeaponModel } from '../client/render/weapon-model';
import { CHARACTERS, headHeight, shoulderHipRatio } from '../shared/characters';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../shared/config';
import { TEAM_COLORS } from '../shared/map';
import { WeaponId, getWeapon } from '../shared/weapons';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d151f);
scene.fog = new THREE.Fog(0x0d151f, 7, 22);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

// Lighting lifted from the game so the models read the way they do in play.
scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1b2130, 1.1));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
sun.position.set(4, 7, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 30;
sun.shadow.camera.left = -6;
sun.shadow.camera.right = 6;
sun.shadow.camera.top = 6;
sun.shadow.camera.bottom = -2;
sun.shadow.bias = -0.0008;
scene.add(sun);
const rim = new THREE.DirectionalLight(0x6ea8ff, 0.8);
rim.position.set(-5, 3, -4);
scene.add(rim);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(9, 48),
  new THREE.MeshStandardMaterial({ color: 0x1b2531, roughness: 0.95, metalness: 0.05 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(18, 36, 0x2c3a4c, 0x1f2a38);
grid.position.y = 0.002;
scene.add(grid);

// --------------------------------------------------------------- figures ---

const SPACING = 1.35;
const figures = CHARACTERS.map((character, index) => {
  const pivot = new THREE.Group();
  pivot.position.x = (index - (CHARACTERS.length - 1) / 2) * SPACING;
  scene.add(pivot);

  const figure = buildFigure(character, TEAM_COLORS[0]);
  pivot.add(figure.root);

  // The collision hull: identical for every operator, which is the point.
  const hull = new THREE.Mesh(
    new THREE.BoxGeometry(PLAYER_RADIUS * 2, PLAYER_HEIGHT, PLAYER_RADIUS * 2),
    new THREE.MeshBasicMaterial({
      color: 0x4aa8ff,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
    }),
  );
  hull.position.y = PLAYER_HEIGHT / 2;
  hull.visible = false;
  pivot.add(hull);

  return { character, pivot, figure, hull };
});

// The rigged models, stood beside the procedural fallbacks so the two can be
// compared directly.
const EMBEDDED = (globalThis as { __MODELS__?: Record<string, string> }).__MODELS__;

const modelSlots = CHARACTERS.map((character, index) => {
  const pivot = new THREE.Group();
  pivot.position.x = ((CHARACTERS.length - 1) / 2 + 1 + index) * SPACING;
  scene.add(pivot);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.5, 32),
    new THREE.MeshBasicMaterial({
      color: 0x4aa8ff,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.004;
  pivot.add(ring);

  const label = document.createElement('div');
  label.className = 'label';
  label.innerHTML = `<b>${character.name}</b><span>rigged · ${character.build}</span>`;

  return { character, pivot, label, instance: null as ModelInstance | null };
});

// Loaded in parallel: sequential awaits meant the second character was still
// arriving when the first had already been on screen for a second.
void Promise.all(
  modelSlots.map(async (slot) => {
    const url = slot.character.modelUrl;
    if (!url) return;
    const key = url.split('/').pop() ?? url;
    const payload = EMBEDDED?.[key];
    const loaded = payload ? await parseModelBase64(key, payload) : await loadModel(url);
    if (!loaded) {
      slot.label.innerHTML = `<b>${slot.character.name}</b><span>model failed — see console</span>`;
      return;
    }
    slot.instance = instantiate(loaded, TEAM_COLORS[0]);
    slot.pivot.add(slot.instance.root);

    // Put a rifle in their hand, since the carry pose only makes sense with one.
    const hand = slot.instance.weaponHand;
    if (hand) {
      const weapon = cloneWeaponModel(getWeapon(WeaponId.Rifle));
      const scale = new THREE.Vector3();
      hand.getWorldScale(scale);
      weapon.root.scale.setScalar(1 / Math.max(0.001, scale.x));
      weapon.root.position.set(0, -0.04, -0.02);
      weapon.root.rotation.set(Math.PI / 2, 0, 0);
      hand.add(weapon.root);
    }
  }),
);

// ------------------------------------------------------------------- ui ----

const state = { spin: true, walk: true, hull: false, team: false };
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-toggle]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.toggle as keyof typeof state;
    state[key] = !state[key];
    button.classList.toggle('on', state[key]);
    if (key === 'hull') for (const f of figures) f.hull.visible = state.hull;
    if (key === 'team') {
      const color = TEAM_COLORS[state.team ? 1 : 0];
      for (const f of figures) {
        for (const material of f.figure.teamMaterials) {
          material.color.setHex(color);
          material.emissive.setHex(color).multiplyScalar(0.15);
        }
      }
      button.textContent = state.team ? 'Red team' : 'Blue team';
    }
  });
}

const specs = document.getElementById('specs') as HTMLTableElement;
specs.innerHTML =
  '<tr><th></th><th>build</th><th>sh:hip</th><th>heads</th></tr>' +
  CHARACTERS.map(
    (c) =>
      `<tr><td class="nm">${c.name}</td><td>${c.build}</td><td>${shoulderHipRatio(c).toFixed(2)}</td><td>${(PLAYER_HEIGHT / headHeight(c)).toFixed(2)}</td></tr>`,
  ).join('');

const labels = document.getElementById('labels') as HTMLElement;
const labelNodes = figures.map(({ character }) => {
  const node = document.createElement('div');
  node.className = 'label';
  node.innerHTML = `<b>${character.name}</b><span>${character.hair} · ${character.gear}</span>`;
  labels.append(node);
  return node;
});
for (const slot of modelSlots) labels.append(slot.label);

// -------------------------------------------------------------- controls ---

let yaw = 0.35;
let pitch = 0.12;
let distance = 7.2;
let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - lastX) * 0.006;
  pitch = Math.max(-0.25, Math.min(0.9, pitch + (e.clientY - lastY) * 0.004));
  lastX = e.clientX;
  lastY = e.clientY;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    distance = Math.max(2.2, Math.min(11, distance + e.deltaY * 0.003));
  },
  { passive: false },
);

/**
 * Capture mode (`?shot`): render a fixed number of frames then stop.
 *
 * A headless screenshot waits for the page to go idle, and an endless
 * requestAnimationFrame loop never does — so without this the capture simply
 * hangs. Stopping also makes the frame deterministic, which is what you want
 * when comparing one build against another.
 */
const CAPTURE = new URLSearchParams(globalThis.location.search).has('shot');
const CAPTURE_FRAMES = 90;
let framesDrawn = 0;

// ------------------------------------------------------------------ loop ---

// Centred on all four figures, not just the procedural three, or the
// downloaded model sits exactly on the right edge of frame.
const target = new THREE.Vector3(
  ((CHARACTERS.length - 1) / 2 + CHARACTERS.length) * SPACING * 0.5,
  0.95,
  0,
);
const projected = new THREE.Vector3();
let stride = 0;
let last = performance.now();

function resize(): void {
  const w = globalThis.innerWidth;
  const h = globalThis.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
resize();
globalThis.addEventListener('resize', resize);

function frame(now: number): void {
  framesDrawn++;
  if (!CAPTURE || framesDrawn < CAPTURE_FRAMES) requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (state.walk) {
    // The same gait the game plays at a jog.
    stride += dt * 3.4 * 5.2;
    const swing = Math.sin(stride) * 0.72;
    for (const { figure } of figures) {
      figure.thighL.rotation.x = swing;
      figure.thighR.rotation.x = -swing;
      figure.shinL.rotation.x = -Math.max(0, -swing) * 1.25 - 0.05;
      figure.shinR.rotation.x = -Math.max(0, swing) * 1.25 - 0.05;
      figure.root.position.y = -Math.abs(Math.sin(stride)) * 0.035;
      figure.torso.rotation.y = Math.sin(stride) * 0.07;
      const tail = figure.hair.getObjectByName('tail');
      if (tail) tail.rotation.x = -0.38 - Math.sin(stride * 0.5) * 0.3;
    }
  }

  if (state.spin && !CAPTURE) {
    for (const { pivot } of figures) pivot.rotation.y += dt * 0.55;
    for (const slot of modelSlots) slot.pivot.rotation.y += dt * 0.55;
  }
  for (const slot of modelSlots) slot.instance?.update(dt, state.walk ? 5.2 : 0);

  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
    target.y + Math.sin(pitch) * distance + 0.35,
    target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
  );
  camera.lookAt(target);

  // Keep the name plates pinned under each figure.
  for (const slot of modelSlots) {
    projected.set(slot.pivot.position.x, 0, 0).project(camera);
    slot.label.style.left = `${((projected.x + 1) / 2) * globalThis.innerWidth}px`;
    slot.label.style.top = `${((-projected.y + 1) / 2) * globalThis.innerHeight}px`;
    slot.label.style.opacity = projected.z < 1 ? '1' : '0';
  }

  for (const [index, { pivot }] of figures.entries()) {
    projected.set(pivot.position.x, 0, 0).project(camera);
    const node = labelNodes[index] as HTMLElement;
    node.style.left = `${((projected.x + 1) / 2) * globalThis.innerWidth}px`;
    node.style.top = `${((-projected.y + 1) / 2) * globalThis.innerHeight}px`;
    node.style.opacity = projected.z < 1 ? '1' : '0';
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

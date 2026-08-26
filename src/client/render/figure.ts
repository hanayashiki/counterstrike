/**
 * Builds a human figure from a character definition.
 *
 * Everything is procedural — the game ships no art assets — so the goal here is
 * to read as a person at gameplay distance using primitives: tapered cylinders
 * with spheres at the joints rather than boxes, an articulated skeleton so
 * knees and elbows actually bend, and an oval cross-section on the torso and
 * limbs (a scaled cylinder) because nothing on a body is circular.
 *
 * Geometry is built once per character and shared by every player wearing it;
 * only the team-coloured materials are per-instance.
 */
import * as THREE from 'three';

import { type CharacterDef, SKULL_Y_SCALE } from '../../shared/characters';

/** The joints the animation drives. */
export interface Figure {
  root: THREE.Group;
  /** Everything above the waist, so the torso can lean and turn. */
  torso: THREE.Group;
  head: THREE.Group;
  hair: THREE.Group;
  thighL: THREE.Group;
  thighR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  upperArmL: THREE.Group;
  upperArmR: THREE.Group;
  forearmL: THREE.Group;
  forearmR: THREE.Group;
  /** Where a weapon is parented. */
  grip: THREE.Group;
  teamMaterials: THREE.MeshStandardMaterial[];
  dispose(): void;
}

const SKIN = new THREE.MeshStandardMaterial({ color: 0xb08468, roughness: 0.82, metalness: 0.02 });
const FATIGUES = new THREE.MeshStandardMaterial({
  color: 0x39414a,
  roughness: 0.88,
  metalness: 0.04,
});
const WEBBING = new THREE.MeshStandardMaterial({
  color: 0x394452,
  roughness: 0.78,
  metalness: 0.14,
});
/** Hard armour: darker and glossier than webbing. */
const PLATE = new THREE.MeshStandardMaterial({
  color: 0x262c36,
  roughness: 0.55,
  metalness: 0.3,
});
/** Softer, warmer shell, so a jacket does not read as more armour. */
const JACKET = new THREE.MeshStandardMaterial({
  color: 0x4a4436,
  roughness: 0.88,
  metalness: 0.05,
});
const BOOT = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.9, metalness: 0.06 });
const HAIR_MAT = new THREE.MeshStandardMaterial({
  color: 0x241b16,
  roughness: 0.9,
  metalness: 0.03,
});
const VISOR = new THREE.MeshStandardMaterial({
  color: 0x0d1218,
  roughness: 0.25,
  metalness: 0.5,
});

/**
 * A limb segment: a cylinder that tapers along its length with a sphere at the
 * top joint, hanging from y = 0 so the parent group is the pivot.
 */
function segment(
  parent: THREE.Object3D,
  material: THREE.Material,
  topRadius: number,
  bottomRadius: number,
  length: number,
  flatten = 0.86,
  owned: THREE.BufferGeometry[] = [],
): void {
  const shaft = new THREE.CylinderGeometry(topRadius, bottomRadius, length, 10, 1);
  shaft.translate(0, -length / 2, 0);
  shaft.scale(1, 1, flatten);
  owned.push(shaft);
  const mesh = new THREE.Mesh(shaft, material);
  mesh.castShadow = true;
  parent.add(mesh);

  const joint = new THREE.SphereGeometry(topRadius * 0.98, 10, 7);
  joint.scale(1, 0.9, flatten);
  owned.push(joint);
  const knob = new THREE.Mesh(joint, material);
  knob.castShadow = true;
  parent.add(knob);
}

/** An oval slab of body: a cylinder scaled to the given width and depth. */
function trunk(
  parent: THREE.Object3D,
  material: THREE.Material,
  topWidth: number,
  topDepth: number,
  bottomWidth: number,
  bottomDepth: number,
  height: number,
  yBase: number,
  owned: THREE.BufferGeometry[],
): THREE.Mesh {
  // Build on a unit radius, then scale each end via a taper ratio.
  const geometry = new THREE.CylinderGeometry(topWidth / 2, bottomWidth / 2, height, 14, 1);
  geometry.translate(0, yBase + height / 2, 0);
  // Depth differs from width, so squash Z. Using the mean keeps the taper.
  geometry.scale(1, 1, (topDepth + bottomDepth) / (topWidth + bottomWidth));
  owned.push(geometry);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

const LIMB_AXIS = new THREE.Vector3(0, -1, 0);
const aimScratch = new THREE.Vector3();
const aimParent = new THREE.Quaternion();

/**
 * Point a limb group along a world direction.
 *
 * Every limb here hangs along -Y from its own origin, so the axis is known and
 * aiming is exact. Guessing Euler angles for a two-bone chain is not — three
 * attempts at it put the hands inside the chest.
 */
function aimLimb(group: THREE.Object3D, worldDir: THREE.Vector3): void {
  group.parent?.getWorldQuaternion(aimParent).invert();
  aimScratch.copy(worldDir).normalize();
  if (group.parent) aimScratch.applyQuaternion(aimParent);
  group.quaternion.setFromUnitVectors(LIMB_AXIS, aimScratch);
  group.updateMatrixWorld(true);
}

/** Weapon carry, as the world direction each segment points. */
const CARRY_UPPER = new THREE.Vector3(0.05, -0.95, -0.3);
const CARRY_FORE = new THREE.Vector3(-0.25, -0.52, -0.78);

export function buildFigure(c: CharacterDef, teamColor: number): Figure {
  const owned: THREE.BufferGeometry[] = [];
  const teamMaterials: THREE.MeshStandardMaterial[] = [];
  const team = () => {
    const material = new THREE.MeshStandardMaterial({
      color: teamColor,
      roughness: 0.6,
      metalness: 0.18,
      emissive: new THREE.Color(teamColor).multiplyScalar(0.15),
    });
    teamMaterials.push(material);
    return material;
  };

  const root = new THREE.Group();

  // ---------------------------------------------------------------- legs ---
  const thighLength = c.hipHeight - c.kneeHeight;
  const shinLength = c.kneeHeight - 0.07;
  const stance = c.hipWidth * 0.28;

  const makeLeg = (side: number): { thigh: THREE.Group; shin: THREE.Group } => {
    const thigh = new THREE.Group();
    thigh.position.set(side * stance, c.hipHeight, 0);
    segment(thigh, FATIGUES, c.thighRadius, c.thighRadius * 0.72, thighLength, 0.92, owned);
    root.add(thigh);

    const shin = new THREE.Group();
    shin.position.y = -thighLength;
    segment(shin, FATIGUES, c.calfRadius * 1.05, c.calfRadius * 0.66, shinLength, 0.9, owned);
    thigh.add(shin);

    // Boot: a wedge that gives the figure a footprint instead of a stump.
    const boot = new THREE.BoxGeometry(c.calfRadius * 2.1, 0.07, c.calfRadius * 3.4);
    boot.translate(0, -shinLength - 0.035, -c.calfRadius * 0.5);
    owned.push(boot);
    const bootMesh = new THREE.Mesh(boot, BOOT);
    bootMesh.castShadow = true;
    shin.add(bootMesh);

    return { thigh, shin };
  };

  const left = makeLeg(-1);
  const right = makeLeg(1);

  // --------------------------------------------------------------- torso ---
  // The torso group pivots at the waist so the upper body can lean and aim.
  const torso = new THREE.Group();
  torso.position.y = c.waistHeight;
  root.add(torso);

  const pelvisHeight = c.waistHeight - c.hipHeight;
  trunk(
    root,
    FATIGUES,
    c.waistWidth,
    c.waistDepth,
    c.hipWidth,
    c.hipDepth,
    pelvisHeight + 0.02,
    c.hipHeight - 0.01,
    owned,
  );

  // Ribcage: widest at the chest, tapering down to the waist.
  const chestHeight = c.shoulderHeight - c.waistHeight;
  trunk(
    torso,
    FATIGUES,
    c.chestWidth,
    c.chestDepth,
    c.waistWidth,
    c.waistDepth,
    chestHeight,
    0,
    owned,
  );

  // Shoulders. A real shoulder is two round deltoid masses at the ends of the
  // clavicle line, not a continuous flared ring - a cone here reads as a collar
  // or a cape, and makes the arms look like they emerge from inside it.
  // A bar across the top of the chest, capped by the deltoids. The cylinder is
  // laid along X by rotating about Z, which moves the RADIUS into Y and Z - so
  // the radius sets the bar's thickness, and the height sets its span.
  const barRadius = 0.052;
  const clavicle = new THREE.CylinderGeometry(
    barRadius,
    barRadius,
    c.shoulderSpan - c.deltoidRadius * 1.7,
    12,
    1,
  );
  clavicle.rotateZ(Math.PI / 2);
  clavicle.scale(1, 1.02, (c.chestDepth * 0.78) / (barRadius * 2));
  clavicle.translate(0, chestHeight - 0.035, 0);
  owned.push(clavicle);
  const clavicleMesh = new THREE.Mesh(clavicle, team());
  clavicleMesh.castShadow = true;
  torso.add(clavicleMesh);

  for (const side of [-1, 1]) {
    const deltoid = new THREE.SphereGeometry(c.deltoidRadius, 12, 9);
    deltoid.scale(0.92, 1.05, 0.95);
    deltoid.translate(side * (c.shoulderSpan / 2 - c.deltoidRadius * 0.9), chestHeight - 0.05, 0);
    owned.push(deltoid);
    const deltoidMesh = new THREE.Mesh(deltoid, team());
    deltoidMesh.castShadow = true;
    torso.add(deltoidMesh);
  }

  // Bust, on the builds that have one. Placed just proud of the vest line so it
  // is part of the silhouette rather than buried under the kit.
  if (c.bust > 0) {
    for (const side of [-1, 1]) {
      const breast = new THREE.SphereGeometry(c.bust, 12, 9);
      breast.scale(1, 0.86, 0.78);
      breast.translate(
        side * c.chestWidth * 0.2,
        chestHeight * 0.66,
        -(c.chestDepth * 0.34 + c.bust * 0.34),
      );
      owned.push(breast);
      const breastMesh = new THREE.Mesh(breast, FATIGUES);
      breastMesh.castShadow = true;
      torso.add(breastMesh);
    }
  }

  // Worn kit. This changes the outline as much as the body does, and is what
  // separates two operators who share a build.
  //
  // Everything here is a fitted shell rather than a slab: a box across the
  // chest reads as a black rectangle at any distance and hides the body
  // underneath, which is what the torso shaping is for.
  const shell = (
    topWidth: number,
    bottomWidth: number,
    height: number,
    yBase: number,
    material: THREE.Material,
    depthBias = 0.014,
  ): void => {
    const geometry = new THREE.CylinderGeometry(topWidth / 2, bottomWidth / 2, height, 16, 1);
    geometry.scale(1, 1, (c.chestDepth + depthBias * 2) / c.chestWidth);
    geometry.translate(0, yBase + height / 2, 0);
    owned.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    torso.add(mesh);
  };

  if (c.gear === 'plate') {
    // Front and back plates over a carrier: a chunkier outline at the ribs.
    shell(c.chestWidth + 0.05, c.waistWidth + 0.05, chestHeight * 0.56, chestHeight * 0.16, PLATE);
    shell(c.chestWidth + 0.02, c.chestWidth + 0.02, 0.05, chestHeight * 0.72, WEBBING, 0.02);
  } else if (c.gear === 'vest') {
    // A short, close vest that stops above the waist, so the waist still reads.
    shell(
      c.chestWidth + 0.015,
      c.waistWidth - 0.01,
      chestHeight * 0.44,
      chestHeight * 0.3,
      WEBBING,
    );
    shell(c.chestWidth - 0.01, c.chestWidth - 0.01, 0.045, chestHeight * 0.74, PLATE, 0.008);
  } else {
    // A jacket falls past the hip and flares, hiding the waist rather than
    // following it - a different outline from the same body.
    shell(
      c.chestWidth + 0.03,
      c.hipWidth + 0.02,
      chestHeight * 0.92,
      chestHeight * 0.04,
      JACKET,
      0.022,
    );
    shell(c.chestWidth * 0.66, c.chestWidth * 0.86, 0.07, chestHeight * 0.88, JACKET, 0.03);
  }

  // ---------------------------------------------------------------- head ---
  const neckLength = c.neckHeight - c.shoulderHeight + 0.06;
  const neck = new THREE.CylinderGeometry(c.neckRadius, c.neckRadius * 1.12, neckLength, 10, 1);
  neck.translate(0, chestHeight + neckLength / 2 - 0.03, 0);
  owned.push(neck);
  torso.add(new THREE.Mesh(neck, SKIN));

  const head = new THREE.Group();
  head.position.y = chestHeight + neckLength - 0.02;
  torso.add(head);

  // A skull is taller than it is wide and deeper than it is broad.
  const skull = new THREE.SphereGeometry(c.headRadius, 16, 12);
  skull.scale(0.86, SKULL_Y_SCALE, 0.94);
  skull.translate(0, c.headRadius * 0.86, 0);
  owned.push(skull);
  const skullMesh = new THREE.Mesh(skull, SKIN);
  skullMesh.castShadow = true;
  head.add(skullMesh);

  // Jaw, to stop the head reading as a ball.
  const jaw = new THREE.BoxGeometry(c.headRadius * 1.24, c.headRadius * 0.62, c.headRadius * 1.3);
  jaw.translate(0, c.headRadius * 0.52, -c.headRadius * 0.12);
  owned.push(jaw);
  head.add(new THREE.Mesh(jaw, SKIN));

  const visor = new THREE.BoxGeometry(c.headRadius * 1.5, c.headRadius * 0.42, 0.03);
  visor.translate(0, c.headRadius * 0.95, -c.headRadius * 0.82);
  owned.push(visor);
  head.add(new THREE.Mesh(visor, VISOR));

  const hair = new THREE.Group();
  head.add(hair);
  buildHair(c, hair, owned);

  // ---------------------------------------------------------------- arms ---
  const upperArmLength = (c.shoulderHeight - c.waistHeight) * 0.72;
  const forearmLength = upperArmLength * 0.92;

  const makeArm = (side: number): { upper: THREE.Group; fore: THREE.Group } => {
    const upper = new THREE.Group();
    upper.position.set(side * (c.shoulderSpan / 2 - c.upperArmRadius * 0.5), chestHeight - 0.05, 0);
    segment(upper, FATIGUES, c.upperArmRadius, c.upperArmRadius * 0.84, upperArmLength, 0.9, owned);
    torso.add(upper);

    const fore = new THREE.Group();
    fore.position.y = -upperArmLength;
    segment(fore, SKIN, c.forearmRadius * 1.06, c.forearmRadius * 0.78, forearmLength, 0.9, owned);
    upper.add(fore);

    const hand = new THREE.SphereGeometry(c.forearmRadius * 1.15, 8, 6);
    hand.translate(0, -forearmLength - c.forearmRadius * 0.4, 0);
    owned.push(hand);
    fore.add(new THREE.Mesh(hand, SKIN));

    return { upper, fore };
  };

  const armL = makeArm(-1);
  const armR = makeArm(1);

  // Rifle carry.
  //
  // The figure faces -Z, so a limb rotates POSITIVELY about X to swing forward.
  // Both segments therefore take positive angles: the upper arm hangs down and
  // slightly forward with the elbow tucked at the ribs, and the forearm swings
  // FORWARD AND UP from there to bring the hands to the weapon. A negative
  // forearm angle is the mistake to avoid - that carries the hand backwards
  // past a straight arm, which an elbow cannot do.
  //
  // Z rotations bring the elbows in against the body and angle the hands toward
  // the centreline, where a weapon would be.
  // Aim rather than set angles: the hands have to finish in front of the chest,
  // and a two-bone chain is far easier to point than to solve by eye.
  root.updateMatrixWorld(true);
  for (const [arm, side] of [
    [armR, 1],
    [armL, -1],
  ] as const) {
    aimLimb(arm.upper, aimScratch.set(CARRY_UPPER.x * side, CARRY_UPPER.y, CARRY_UPPER.z).clone());
    aimLimb(arm.fore, aimScratch.set(CARRY_FORE.x * side, CARRY_FORE.y, CARRY_FORE.z).clone());
  }

  // The weapon hangs off the leading hand.
  const grip = new THREE.Group();
  grip.position.set(0, -forearmLength * 0.92, 0);
  armR.fore.add(grip);

  root.position.y = 0;

  return {
    root,
    torso,
    head,
    hair,
    thighL: left.thigh,
    thighR: right.thigh,
    shinL: left.shin,
    shinR: right.shin,
    upperArmL: armL.upper,
    upperArmR: armR.upper,
    forearmL: armL.fore,
    forearmR: armR.fore,
    grip,
    teamMaterials,
    dispose() {
      for (const geometry of owned) geometry.dispose();
      for (const material of teamMaterials) material.dispose();
    },
  };
}

function buildHair(c: CharacterDef, parent: THREE.Group, owned: THREE.BufferGeometry[]): void {
  const r = c.headRadius;

  // Every head gets a cap; only the back of it differs.
  // Only the crown: a deeper cap hides the face and turns the head into a
  // featureless helmet.
  const cap = new THREE.SphereGeometry(r * 1.04, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.44);
  cap.scale(0.9, 1.05, 0.98);
  cap.translate(0, r * 0.9, 0);
  owned.push(cap);
  const capMesh = new THREE.Mesh(cap, HAIR_MAT);
  capMesh.castShadow = true;
  parent.add(capMesh);

  if (c.hair === 'crop') return;

  if (c.hair === 'ponytail') {
    const tail = new THREE.CylinderGeometry(r * 0.32, r * 0.16, r * 2.6, 8, 1);
    tail.translate(0, -r * 1.3, 0);
    owned.push(tail);
    const tailMesh = new THREE.Mesh(tail, HAIR_MAT);
    tailMesh.position.set(0, r * 1.1, r * 0.72);
    tailMesh.rotation.x = -0.38;
    tailMesh.castShadow = true;
    tailMesh.name = 'tail';
    parent.add(tailMesh);
    return;
  }

  const knot = new THREE.SphereGeometry(r * 0.46, 10, 8);
  knot.translate(0, r * 1.12, r * 0.82);
  owned.push(knot);
  const knotMesh = new THREE.Mesh(knot, HAIR_MAT);
  knotMesh.castShadow = true;
  parent.add(knotMesh);
}

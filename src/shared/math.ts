/** Minimal allocation-conscious 3D math. Y is up. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const copy = (out: Vec3, a: Vec3): Vec3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

export const set = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export const add = (out: Vec3, a: Vec3, b: Vec3): Vec3 => set(out, a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (out: Vec3, a: Vec3, b: Vec3): Vec3 => set(out, a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (out: Vec3, a: Vec3, s: number): Vec3 => set(out, a.x * s, a.y * s, a.z * s);
export const addScaled = (out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 =>
  set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));

export const distanceSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const distance = (a: Vec3, b: Vec3): number => Math.sqrt(distanceSq(a, b));

/** Horizontal (XZ) distance, which is what most gameplay checks actually want. */
export const distance2D = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

export const normalize = (out: Vec3, a: Vec3): Vec3 => {
  const len = length(a);
  return len > 1e-8 ? scale(out, a, 1 / len) : set(out, 0, 0, 0);
};

export const cross = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpVec3 = (out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 =>
  set(out, lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const TAU = Math.PI * 2;

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/** Shortest signed delta from `from` to `to`, in radians. */
export const angleDelta = (from: number, to: number): number => wrapAngle(to - from);

/** Move `from` toward `to` by at most `maxStep` radians, the short way around. */
export function approachAngle(from: number, to: number, maxStep: number): number {
  const delta = angleDelta(from, to);
  if (Math.abs(delta) <= maxStep) return wrapAngle(to);
  return wrapAngle(from + Math.sign(delta) * maxStep);
}

/** Unit forward vector for a yaw/pitch pair. yaw=0 looks down -Z. */
export function forwardFromAngles(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** Yaw/pitch that point along `dir` (need not be normalized). */
export function anglesFromForward(dir: Vec3): { yaw: number; pitch: number } {
  const horizontal = Math.hypot(dir.x, dir.z);
  return {
    yaw: Math.atan2(-dir.x, -dir.z),
    pitch: Math.atan2(dir.y, horizontal),
  };
}

/**
 * Deterministic 32-bit PRNG (mulberry32). The server uses seeded randomness for
 * spread and bot decisions so a match can be replayed from its input log.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n) % Math.max(1, n);
  }

  /** Approximately standard-normal via the Box-Muller transform. */
  gaussian(): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

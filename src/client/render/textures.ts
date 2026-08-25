/** Procedural textures, so the build ships without any binary art assets. */
import * as THREE from 'three';

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  return { canvas, ctx };
}

function noise(ctx: CanvasRenderingContext2D, size: number, amount: number, alpha: number): void {
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    data[i] = Math.max(0, Math.min(255, (data[i] as number) + n));
    data[i + 1] = Math.max(0, Math.min(255, (data[i + 1] as number) + n));
    data[i + 2] = Math.max(0, Math.min(255, (data[i + 2] as number) + n));
    data[i + 3] = Math.round((data[i + 3] as number) * alpha);
  }
  ctx.putImageData(image, 0, 0);
}

/** Panelled concrete/metal with a subtle grid, tiling at 1 unit = 1 metre. */
export function createSurfaceTexture(
  base: string,
  line: string,
  cells: number,
  size = 256,
): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const step = size / cells;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(i * step) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }

  // A few darker panels break up the regularity.
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let i = 0; i < cells * 2; i++) {
    const x = Math.floor(Math.random() * cells) * step;
    const y = Math.floor(Math.random() * cells) * step;
    ctx.fillRect(x + 1, y + 1, step - 2, step - 2);
  }

  noise(ctx, size, 18, 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Soft radial sprite used for muzzle flashes, sparks and impact glow. */
export function createGlowTexture(size = 64): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,235,190,0.75)');
  gradient.addColorStop(1, 'rgba(255,180,80,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Bullet hole decal. */
export function createImpactTexture(size = 64): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(8,8,10,0.95)');
  gradient.addColorStop(0.45, 'rgba(20,20,24,0.6)');
  gradient.addColorStop(1, 'rgba(30,30,34,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

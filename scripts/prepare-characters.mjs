/**
 * Turns the Quaternius "Universal Base Characters" pack into the .glb files the
 * client loads.
 *
 * The pack ships .gltf + .bin + a folder of 2048px PNGs — 33 MB of textures for
 * two characters, which is not something to send over a game connection. This
 * downscales them, drops the roughness maps in favour of a constant, and packs
 * each character into a single self-contained .glb.
 *
 * The pack itself is not committed; run this once against the download:
 *
 *   node scripts/prepare-characters.mjs ~/Downloads/'Universal Base Characters[Standard].zip'
 *
 * Source: https://quaternius.com — CC0 1.0, public domain, no attribution
 * required (a credit is still in the README because it is deserved).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const zip = process.argv[2];
if (!zip || !existsSync(zip)) {
  console.error('usage: node scripts/prepare-characters.mjs <path to the pack .zip>');
  process.exit(1);
}

const OUT_DIR = 'src/client/public/models';
/** Characters to extract, and how big each texture role may be. */
const BODIES = ['Superhero_Female_FullBody', 'Superhero_Male_FullBody'];
const BASE_COLOR_PX = 1024;
const NORMAL_PX = 512;
/** Roughness maps are dropped; this stands in for them. */
const CONSTANT_ROUGHNESS = 0.72;

const align = (n) => (n + 3) & ~3;

const work = mkdtempSync(join(tmpdir(), 'chars-'));
try {
  console.log('extracting…');
  execFileSync('unzip', [
    '-q',
    '-j',
    '-o',
    zip,
    '*/Base Characters/Godot - UE/*',
    '*/License_Standard.txt',
    '-d',
    work,
  ]);

  const scaled = new Map();

  /** Downscale once per source image, converting base colour to JPEG. */
  function prepareTexture(uri) {
    if (scaled.has(uri)) return scaled.get(uri);
    // The pack references a few textures as "Foo_png.png" while shipping them
    // as "Foo.png", so fall back to the stripped name before giving up.
    const candidates = [uri, uri.replace(/_png\.png$/i, '.png')];
    const source = candidates.map((c) => join(work, c)).find((c) => existsSync(c));
    if (!source) {
      console.warn(`  missing texture ${uri}, skipping`);
      scaled.set(uri, null);
      return null;
    }

    const isNormal = /normal/i.test(uri);
    const isEye = /eye/i.test(uri);
    const size = isEye ? 256 : isNormal ? NORMAL_PX : BASE_COLOR_PX;

    // Normals must stay lossless; colour maps compress happily.
    const asJpeg = !isNormal && !isEye;
    const outName = uri.replace(/\.png$/i, asJpeg ? '.jpg' : '.png');
    const outPath = join(work, `scaled_${outName}`);

    const args = ['-Z', String(size)];
    if (asJpeg) args.push('-s', 'format', 'jpeg', '-s', 'formatOptions', '78');
    execFileSync('sips', [...args, source, '--out', outPath], { stdio: 'ignore' });

    const entry = { path: outPath, mimeType: asJpeg ? 'image/jpeg' : 'image/png' };
    scaled.set(uri, entry);
    return entry;
  }

  for (const body of BODIES) {
    const gltfPath = join(work, `${body}.gltf`);
    if (!existsSync(gltfPath)) {
      console.warn(`  ${body} not in this pack, skipping`);
      continue;
    }
    const gltf = JSON.parse(readFileSync(gltfPath, 'utf8'));
    const bin = readFileSync(join(work, gltf.buffers[0].uri));

    // Roughness maps are the single biggest texture and barely read on a
    // character this small; a constant is the better trade.
    for (const material of gltf.materials ?? []) {
      const pbr = material.pbrMetallicRoughness;
      if (pbr?.metallicRoughnessTexture) {
        delete pbr.metallicRoughnessTexture;
        pbr.roughnessFactor = CONSTANT_ROUGHNESS;
        pbr.metallicFactor = 0;
      }
    }

    // Fold every remaining image into the binary chunk.
    const chunks = [bin];
    let offset = bin.length;
    const bufferViews = gltf.bufferViews ?? [];

    for (const image of gltf.images ?? []) {
      if (!image.uri) continue;
      const prepared = prepareTexture(image.uri);
      if (!prepared) continue;
      const data = readFileSync(prepared.path);
      const padding = align(offset) - offset;
      if (padding > 0) {
        chunks.push(Buffer.alloc(padding));
        offset += padding;
      }
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
      chunks.push(data);
      offset += data.length;

      delete image.uri;
      image.bufferView = bufferViews.length - 1;
      image.mimeType = prepared.mimeType;
    }

    gltf.bufferViews = bufferViews;
    const binary = Buffer.concat(chunks);
    gltf.buffers = [{ byteLength: binary.length }];

    // GLB: header, JSON chunk padded with spaces, BIN chunk padded with zeros.
    const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
    const jsonPad = Buffer.alloc(align(jsonBuf.length) - jsonBuf.length, 0x20);
    const binPad = Buffer.alloc(align(binary.length) - binary.length, 0);
    const jsonChunk = Buffer.concat([jsonBuf, jsonPad]);
    const binChunk = Buffer.concat([binary, binPad]);

    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonChunk.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f_534a, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binChunk.length, 0);
    binHeader.writeUInt32LE(0x004e_4942, 4);

    mkdirSync(OUT_DIR, { recursive: true });
    const name = body.replace('_FullBody', '').replace('Superhero_', '') + '.glb';
    const outPath = join(OUT_DIR, name);
    writeFileSync(outPath, Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]));
    console.log(`  ${name.padEnd(12)} ${(header.readUInt32LE(8) / 1024 / 1024).toFixed(2)} MB`);
  }

  // Carry the licence next to the assets.
  const licence = readdirSync(work).find((f) => /license/i.test(f));
  if (licence)
    writeFileSync(join(OUT_DIR, 'Quaternius.LICENSE.txt'), readFileSync(join(work, licence)));
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('done');

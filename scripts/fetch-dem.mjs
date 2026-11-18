#!/usr/bin/env node
/**
 * Bundle an open DEM (AWS Terrain Tiles, Terrarium encoding) for offline presets.
 *
 * Usage:
 *   node scripts/fetch-dem.mjs --name malpasset --bbox 6.69,43.405,6.80,43.535 --cells 256 \
 *        --title "Malpasset" --out public/data/malpasset.json [--preview preview.png]
 *
 * Output JSON: { name, title, nx, ny, dx, dy, georef, zMin, zMax, attribution, encoding: 'f32-base64', data }
 * Requires Node >= 22.6 (TypeScript type stripping) to import src/data/geo.ts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { chooseDemZoom, planGrid, resampleMosaic, terrariumElevation } from '../src/data/geo.ts';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const name = arg('name', 'dem');
const title = arg('title', name);
const bboxArg = arg('bbox');
const cells = Number(arg('cells', '256'));
const out = arg('out', `public/data/${name}.json`);
const preview = arg('preview');
const maxTiles = Number(arg('maxTiles', '80'));
if (!bboxArg) {
  console.error('missing --bbox west,south,east,north');
  process.exit(1);
}
const [west, south, east, north] = bboxArg.split(',').map(Number);
const plan = planGrid({ west, south, east, north }, cells);
const range = chooseDemZoom(plan, maxTiles, 15);
console.log(`grid ${plan.nx}x${plan.ny}, dx=${plan.dx.toFixed(2)} m, zoom ${range.zoom}, ${range.count} tiles`);

async function fetchTile(z, x, y) {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const png = PNG.sync.read(buf);
      const e = new Float32Array(256 * 256);
      for (let k = 0; k < 256 * 256; k++) {
        e[k] = terrariumElevation(png.data[4 * k], png.data[4 * k + 1], png.data[4 * k + 2]);
      }
      return e;
    } catch (err) {
      if (attempt === 2) throw new Error(`${url}: ${err.message}`);
    }
  }
  return null;
}

const tw = range.x1 - range.x0 + 1;
const th = range.y1 - range.y0 + 1;
const W = tw * 256;
const H = th * 256;
const mosaic = new Float32Array(W * H);
const jobs = [];
for (let ty = range.y0; ty <= range.y1; ty++) {
  for (let tx = range.x0; tx <= range.x1; tx++) jobs.push([tx, ty]);
}
let done = 0;
const pool = 8;
async function worker() {
  while (jobs.length) {
    const [tx, ty] = jobs.shift();
    const e = await fetchTile(range.zoom, tx, ty);
    const ox = (tx - range.x0) * 256;
    const oy = (ty - range.y0) * 256;
    for (let r = 0; r < 256; r++) mosaic.set(e.subarray(r * 256, r * 256 + 256), (oy + r) * W + ox);
    done++;
    process.stdout.write(`\rtiles ${done}/${range.count}`);
  }
}
await Promise.all(Array.from({ length: pool }, worker));
process.stdout.write('\n');

const z = resampleMosaic(plan, range, mosaic, W, H);
let zMin = Infinity;
let zMax = -Infinity;
for (const v of z) {
  if (v < zMin) zMin = v;
  if (v > zMax) zMax = v;
}
const json = {
  name,
  title,
  nx: plan.nx,
  ny: plan.ny,
  dx: plan.dx,
  dy: plan.dy,
  georef: { kind: 'mercator', ...plan.bbox, zoom: range.zoom },
  zMin,
  zMax,
  attribution: 'AWS Terrain Tiles (Mapzen/Tilezen; SRTM, GMTED2010, ETOPO1, NED …)',
  encoding: 'f32-base64',
  data: Buffer.from(z.buffer).toString('base64'),
};
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(json));
console.log(`wrote ${out}: z in [${zMin.toFixed(1)}, ${zMax.toFixed(1)}] m`);

if (preview) {
  // simple hillshade + hypsometric preview, north up
  const { nx, ny, dx } = plan;
  const png = new PNG({ width: nx, height: ny });
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const zl = z[j * nx + Math.max(0, i - 1)];
      const zr = z[j * nx + Math.min(nx - 1, i + 1)];
      const zd = z[Math.max(0, j - 1) * nx + i];
      const zu = z[Math.min(ny - 1, j + 1) * nx + i];
      const gx = (zr - zl) / (2 * dx);
      const gy = (zu - zd) / (2 * dx);
      const shade = Math.max(0, Math.min(1, 0.6 + (-gx * 0.7 + gy * 0.7) * 2));
      const t = (z[c] - zMin) / Math.max(1e-6, zMax - zMin);
      const sea = z[c] <= 0;
      const col = sea ? [40, 90, 160] : [80 + 150 * t, 140 + 80 * t, 70 + 120 * t];
      const row = ny - 1 - j;
      const k = 4 * (row * nx + i);
      png.data[k] = col[0] * shade;
      png.data[k + 1] = col[1] * shade;
      png.data[k + 2] = col[2] * shade;
      png.data[k + 3] = 255;
    }
  }
  await fs.writeFile(preview, PNG.sync.write(png));
  console.log(`preview ${preview}`);
}

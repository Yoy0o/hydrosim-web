/**
 * Open DEM loader: AWS Open Data "Terrain Tiles" (Terrarium PNG encoding, global, incl. bathymetry).
 * https://registry.opendata.aws/terrain-tiles/  — elevation = R*256 + G + B/256 - 32768 (m)
 */
import type { Terrain } from '../types';
import { chooseDemZoom, planGrid, resampleMosaic, terrariumElevation, type BBox } from './geo';
import { bitmapPixels, fetchImageBitmap, pool } from './tiles';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_ATTRIBUTION =
  'DEM: AWS Terrain Tiles (Mapzen/Tilezen) — SRTM (NASA), GMTED2010 (USGS), ETOPO1 (NOAA), NED (USGS) 等';

export interface DemRequest {
  bbox: BBox;
  /** Number of cells along the longer side. */
  cells: number;
  name?: string;
  maxTiles?: number;
  signal?: AbortSignal;
  onProgress?: (msg: string, frac: number) => void;
}

export async function loadTerrariumDEM(req: DemRequest): Promise<Terrain> {
  const plan = planGrid(req.bbox, req.cells);
  const range = chooseDemZoom(plan, req.maxTiles ?? 64, 13);
  const tw = range.x1 - range.x0 + 1;
  const th = range.y1 - range.y0 + 1;
  const W = tw * 256;
  const H = th * 256;
  const mosaic = new Float32Array(W * H);
  const jobs: (() => Promise<void>)[] = [];
  for (let ty = range.y0; ty <= range.y1; ty++) {
    for (let tx = range.x0; tx <= range.x1; tx++) {
      jobs.push(async () => {
        const url = TERRARIUM_URL.replace('{z}', String(range.zoom)).replace('{x}', String(tx)).replace('{y}', String(ty));
        const bmp = await fetchImageBitmap(url, req.signal);
        const ox = (tx - range.x0) * 256;
        const oy = (ty - range.y0) * 256;
        if (!bmp) return; // missing tile => 0 m
        const px = bitmapPixels(bmp);
        bmp.close();
        for (let r = 0; r < 256; r++) {
          const row = (oy + r) * W + ox;
          for (let c = 0; c < 256; c++) {
            const k = 4 * (r * 256 + c);
            mosaic[row + c] = terrariumElevation(px[k], px[k + 1], px[k + 2]);
          }
        }
      });
    }
  }
  req.onProgress?.(`下载 DEM 瓦片 0/${range.count}（缩放级别 ${range.zoom}）`, 0);
  await pool(jobs, 8, (n) => req.onProgress?.(`下载 DEM 瓦片 ${n}/${range.count}（缩放级别 ${range.zoom}）`, n / range.count));
  req.onProgress?.('重采样到计算网格…', 1);
  const z = resampleMosaic(plan, range, mosaic, W, H);
  return {
    name: req.name ?? '在线 DEM',
    nx: plan.nx,
    ny: plan.ny,
    dx: plan.dx,
    dy: plan.dy,
    z,
    georef: { kind: 'mercator', ...plan.bbox, zoom: range.zoom },
    source: 'terrarium',
    attribution: TERRARIUM_ATTRIBUTION,
  };
}

/** Load a DEM bundled with the app (produced by scripts/fetch-dem.mjs). */
export async function loadBundledDEM(url: string): Promise<Terrain> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法加载内置地形 ${url}: HTTP ${res.status}`);
  const d = (await res.json()) as {
    name: string;
    title: string;
    nx: number;
    ny: number;
    dx: number;
    dy: number;
    georef: Terrain['georef'];
    attribution: string;
    data: string;
  };
  const bin = atob(d.data);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return {
    name: d.title,
    nx: d.nx,
    ny: d.ny,
    dx: d.dx,
    dy: d.dy,
    z: new Float32Array(bytes.buffer),
    georef: d.georef,
    source: 'bundled',
    attribution: TERRARIUM_ATTRIBUTION,
  };
}

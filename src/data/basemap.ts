/** Imagery draped on the terrain: Sentinel-2 cloudless (EOX, CC BY 4.0) or OpenStreetMap tiles. */
import { EARTH_R, lat2my, lon2mx, mercToPixel, type BBox } from './geo';
import { fetchImageBitmap, pool } from './tiles';

export type BasemapKind = 'satellite' | 'osm';

export const BASEMAPS: Record<BasemapKind, { url: string; maxZoom: number; attribution: string; label: string }> = {
  satellite: {
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg',
    maxZoom: 15,
    attribution: 'Sentinel-2 cloudless 2016 by EOX IT Services GmbH (含修改后的 Copernicus Sentinel 数据), CC BY 4.0',
    label: '卫星影像 (Sentinel-2 cloudless)',
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 17,
    attribution: '© OpenStreetMap contributors (ODbL)',
    label: 'OpenStreetMap',
  },
};

export async function loadBasemap(
  kind: BasemapKind,
  bbox: BBox,
  opts: { maxSize?: number; maxTiles?: number; signal?: AbortSignal; onProgress?: (msg: string, frac: number) => void } = {},
): Promise<HTMLCanvasElement> {
  const src = BASEMAPS[kind];
  const maxSize = opts.maxSize ?? 4096;
  const maxTiles = opts.maxTiles ?? 80;
  const mx0 = lon2mx(bbox.west);
  const mx1 = lon2mx(bbox.east);
  const my0 = lat2my(bbox.south);
  const my1 = lat2my(bbox.north);
  // choose zoom: as fine as possible with the output <= maxSize px and tile count <= maxTiles
  let zoom = 1;
  for (let z = 1; z <= src.maxZoom; z++) {
    const pixelMerc = (2 * Math.PI * EARTH_R) / (256 * 2 ** z);
    const w = (mx1 - mx0) / pixelMerc;
    const h = (my1 - my0) / pixelMerc;
    const [px0, py0] = mercToPixel(mx0, my1, z);
    const [px1, py1] = mercToPixel(mx1, my0, z);
    const tiles = (Math.floor(px1 / 256) - Math.floor(px0 / 256) + 1) * (Math.floor(py1 / 256) - Math.floor(py0 / 256) + 1);
    if (Math.max(w, h) > maxSize || tiles > maxTiles) break;
    zoom = z;
  }
  const [px0, py0] = mercToPixel(mx0, my1, zoom);
  const [px1, py1] = mercToPixel(mx1, my0, zoom);
  const tx0 = Math.floor(px0 / 256);
  const ty0 = Math.floor(py0 / 256);
  const tx1 = Math.floor((px1 - 1e-6) / 256);
  const ty1 = Math.floor((py1 - 1e-6) / 256);
  const mosaic = document.createElement('canvas');
  mosaic.width = (tx1 - tx0 + 1) * 256;
  mosaic.height = (ty1 - ty0 + 1) * 256;
  const mctx = mosaic.getContext('2d')!;
  mctx.fillStyle = '#6b7280';
  mctx.fillRect(0, 0, mosaic.width, mosaic.height);
  const jobs: (() => Promise<void>)[] = [];
  const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(async () => {
        const url = src.url.replace('{z}', String(zoom)).replace('{x}', String(tx)).replace('{y}', String(ty));
        try {
          const bmp = await fetchImageBitmap(url, opts.signal);
          if (bmp) {
            mctx.drawImage(bmp, (tx - tx0) * 256, (ty - ty0) * 256);
            bmp.close();
          }
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          // keep grey placeholder for failed tiles
        }
      });
    }
  }
  opts.onProgress?.(`下载影像瓦片 0/${total}`, 0);
  await pool(jobs, 6, (n) => opts.onProgress?.(`下载影像瓦片 ${n}/${total}`, n / total));
  const out = document.createElement('canvas');
  out.width = Math.max(2, Math.round(px1 - px0));
  out.height = Math.max(2, Math.round(py1 - py0));
  const ctx = out.getContext('2d')!;
  ctx.drawImage(mosaic, px0 - tx0 * 256, py0 - ty0 * 256, px1 - px0, py1 - py0, 0, 0, out.width, out.height);
  return out;
}

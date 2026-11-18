/**
 * OpenStreetMap buildings and land cover from OpenFreeMap vector tiles (OpenMapTiles schema, CORS enabled,
 * no key). Tiles are decoded with @mapbox/vector-tile and rasterised onto the simulation grid:
 *  - land cover: class at each cell centre, priority water > landuse > landcover
 *  - buildings: 4 x 4 sub-sample coverage per cell and the tallest render_height
 * Each tile contributes only inside its own extent (MVT tiles carry overlapping buffers).
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { rasterizeRings, type GridGeom } from '../core/raster';
import { LANDCOVER_CLASSES, LANDCOVER_INDEX as IDX, type BuildingRaster, type LandCoverRaster } from '../model';
import { EARTH_R, lat2my, lon2mx, mercToPixel, type BBox } from './geo';
import { pool } from './tiles';

export const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OSM_VECTOR_ATTRIBUTION = '建筑物/土地覆盖：© OpenStreetMap contributors，OpenMapTiles，OpenFreeMap';

let templateCache: string | null = null;

async function tileTemplate(signal?: AbortSignal): Promise<string> {
  if (templateCache) return templateCache;
  const res = await fetch(OFM_TILEJSON, { signal });
  if (!res.ok) throw new Error(`OpenFreeMap TileJSON: HTTP ${res.status}`);
  const j = (await res.json()) as { tiles?: string[] };
  if (!j.tiles?.length) throw new Error('OpenFreeMap TileJSON 无瓦片地址');
  templateCache = j.tiles[0];
  return templateCache;
}

function landcoverClass(layer: string, props: Record<string, unknown>): number {
  const cls = String(props.class ?? '');
  const sub = String(props.subclass ?? '');
  if (layer === 'water') return cls === 'swimming_pool' ? 0 : IDX.water;
  if (layer === 'landcover') {
    if (/scrub|heath/.test(sub)) return IDX.scrub;
    switch (cls) {
      case 'wood':
      case 'forest':
        return IDX.wood;
      case 'grass':
        return IDX.grass;
      case 'farmland':
        return /vineyard|orchard|plant_nursery/.test(sub) ? IDX.orchard : IDX.farmland;
      case 'wetland':
        return IDX.wetland;
      case 'sand':
        return IDX.sand;
      case 'rock':
        return IDX.rock;
      case 'ice':
        return IDX.ice;
      default:
        return 0;
    }
  }
  if (layer === 'landuse') {
    if (/residential|suburb|neighbourhood|quarter/.test(cls)) return IDX.residential;
    if (/commercial|industrial|retail|railway|garages/.test(cls)) return IDX.commercial;
    if (/pitch|playground|track|stadium|park|garden/.test(cls)) return IDX.grass;
    return cls ? IDX.urbanOther : 0;
  }
  return 0;
}

export interface OsmVectorResult {
  buildings: BuildingRaster | null;
  landcover: LandCoverRaster | null;
  tiles: number;
  zoom: number;
  /** Cells per land-cover class key. */
  classCells: Record<string, number>;
}

interface Tile {
  tx: number;
  ty: number;
  vt: VectorTile;
}

/**
 * @param bbox the terrain's geographic box (Web Mercator grid, see data/geo.ts)
 */
export async function importOsmVector(
  bbox: BBox,
  g: GridGeom,
  opts: { buildings: boolean; landcover: boolean; signal?: AbortSignal; onProgress?: (msg: string, frac: number) => void; maxTiles?: number },
): Promise<OsmVectorResult> {
  const C = 2 * Math.PI * EARTH_R;
  const mx0 = lon2mx(bbox.west);
  const my0 = lat2my(bbox.south);
  const mx1 = lon2mx(bbox.east);
  const my1 = lat2my(bbox.north);
  const cosLat = Math.cos(((bbox.south + bbox.north) / 2) * (Math.PI / 180));
  const maxTiles = opts.maxTiles ?? 196;
  let zoom = 14;
  let range = { x0: 0, x1: 0, y0: 0, y1: 0 };
  for (; zoom >= 12; zoom--) {
    const [px0, py0] = mercToPixel(mx0, my1, zoom);
    const [px1, py1] = mercToPixel(mx1, my0, zoom);
    range = { x0: Math.floor(px0 / 256), x1: Math.floor((px1 - 1e-6) / 256), y0: Math.floor(py0 / 256), y1: Math.floor((py1 - 1e-6) / 256) };
    if ((range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) <= maxTiles) break;
  }
  if (zoom < 12) throw new Error('区域过大：建筑物/土地覆盖导入请将区域控制在约 400 km² 以内');
  const template = await tileTemplate(opts.signal);
  const jobs: (() => Promise<Tile | null>)[] = [];
  for (let ty = range.y0; ty <= range.y1; ty++) {
    for (let tx = range.x0; tx <= range.x1; tx++) {
      jobs.push(async () => {
        const url = template.replace('{z}', String(zoom)).replace('{x}', String(tx)).replace('{y}', String(ty));
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await fetch(url, { signal: opts.signal });
            if (res.status === 404 || res.status === 204) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = new Uint8Array(await res.arrayBuffer());
            return { tx, ty, vt: new VectorTile(new PbfReader(buf)) };
          } catch (err) {
            if (opts.signal?.aborted || attempt === 2) throw err;
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
        return null;
      });
    }
  }
  const total = jobs.length;
  opts.onProgress?.(`下载 OpenStreetMap 矢量瓦片 0/${total}（z${zoom}）`, 0);
  const tiles = (await pool(jobs, 6, (k) => opts.onProgress?.(`下载 OpenStreetMap 矢量瓦片 ${k}/${total}（z${zoom}）`, k / total))).filter(
    (t): t is Tile => !!t,
  );
  opts.onProgress?.('栅格化建筑物与土地覆盖…', 1);

  const n = g.nx * g.ny;
  const scale = 1 / (256 * 2 ** zoom);
  /** Tile coordinates (extent units) -> local grid metres. */
  const toLocal = (tx: number, ty: number, E: number, px: number, py: number): [number, number] => {
    const gx = (tx + px / E) * 256;
    const gy = (ty + py / E) * 256;
    const mx = gx * scale * C - C / 2;
    const my = C / 2 - gy * scale * C;
    return [(mx - mx0) * cosLat, (my - my0) * cosLat];
  };
  const tileClip = (t: Tile, E: number): { x0: number; x1: number; y0: number; y1: number } => {
    const [x0, y1] = toLocal(t.tx, t.ty, E, 0, 0);
    const [x1, y0] = toLocal(t.tx, t.ty, E, E, E);
    return { x0, x1, y0, y1 };
  };
  const featureRings = (t: Tile, E: number, geom: { x: number; y: number }[][]): [number, number][][] =>
    geom.map((ring) => ring.map((p) => toLocal(t.tx, t.ty, E, p.x, p.y)));

  let landcover: LandCoverRaster | null = null;
  const classCells: Record<string, number> = {};
  if (opts.landcover) {
    const cls = new Uint8Array(n);
    for (const layerName of ['landcover', 'landuse', 'water']) {
      for (const t of tiles) {
        const layer = t.vt.layers[layerName];
        if (!layer) continue;
        const clip = tileClip(t, layer.extent);
        for (let f = 0; f < layer.length; f++) {
          const feat = layer.feature(f);
          if (feat.type !== 3) continue;
          const k = landcoverClass(layerName, feat.properties as Record<string, unknown>);
          if (!k) continue;
          rasterizeRings(g, featureRings(t, layer.extent, feat.loadGeometry()), 1, (c) => (cls[c] = k), clip);
        }
      }
    }
    for (let c = 0; c < n; c++) {
      const key = LANDCOVER_CLASSES[cls[c]].key;
      classCells[key] = (classCells[key] ?? 0) + 1;
    }
    landcover = { cls, source: 'OpenStreetMap（OpenFreeMap 矢量瓦片）' };
  }

  let buildings: BuildingRaster | null = null;
  if (opts.buildings) {
    const cover = new Uint8Array(n);
    const height = new Float32Array(n);
    const Lx = g.nx * g.dx;
    const Ly = g.ny * g.dy;
    let count = 0;
    for (const t of tiles) {
      const layer = t.vt.layers.building;
      if (!layer) continue;
      const clip = tileClip(t, layer.extent);
      for (let f = 0; f < layer.length; f++) {
        const feat = layer.feature(f);
        if (feat.type !== 3) continue;
        const props = feat.properties as Record<string, unknown>;
        const hgt = Number(props.render_height ?? 0) || 0;
        const geom = feat.loadGeometry();
        const rings = featureRings(t, layer.extent, geom);
        rasterizeRings(
          g,
          rings,
          4,
          (c) => {
            if (cover[c] < 16) cover[c]++;
            if (hgt > height[c]) height[c] = hgt;
          },
          clip,
        );
        // OpenMapTiles merges buildings of equal height into one multipolygon feature: count exterior rings
        // (positive area in tile coordinates, y down) whose centroid lies in this tile and in the domain
        for (let r = 0; r < geom.length; r++) {
          const ring = geom[r];
          let a = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
          if (a <= 0) continue;
          let cx = 0;
          let cy = 0;
          for (const [x, y] of rings[r]) {
            cx += x;
            cy += y;
          }
          cx /= rings[r].length;
          cy /= rings[r].length;
          if (cx >= Math.max(0, clip.x0) && cx < Math.min(Lx, clip.x1) && cy >= Math.max(0, clip.y0) && cy < Math.min(Ly, clip.y1)) count++;
        }
      }
    }
    buildings = { cover, height, count, source: 'OpenStreetMap（OpenFreeMap 矢量瓦片）' };
  }
  return { buildings, landcover, tiles: tiles.length, zoom, classCells };
}

/**
 * Web Mercator helpers and grid planning for DEM tiles (no dependencies: also imported by the Node
 * bundling script `scripts/fetch-dem.mjs` through Node's TypeScript type stripping).
 */
export const EARTH_R = 6378137;
const D2R = Math.PI / 180;

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function lon2mx(lon: number): number {
  return EARTH_R * lon * D2R;
}
export function lat2my(lat: number): number {
  return EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
}
export function mx2lon(mx: number): number {
  return mx / EARTH_R / D2R;
}
export function my2lat(my: number): number {
  return (2 * Math.atan(Math.exp(my / EARTH_R)) - Math.PI / 2) / D2R;
}

/** Ground size (m) of a lon/lat box using the scale factor at its centre latitude. */
export function bboxSizeMeters(b: BBox): { width: number; height: number; cosLat: number } {
  const cosLat = Math.cos(((b.south + b.north) / 2) * D2R);
  return {
    width: (lon2mx(b.east) - lon2mx(b.west)) * cosLat,
    height: (lat2my(b.north) - lat2my(b.south)) * cosLat,
    cosLat,
  };
}

export interface GridPlan {
  nx: number;
  ny: number;
  /** True ground cell size (m). */
  dx: number;
  dy: number;
  /** Cell size in Web Mercator metres. */
  dmx: number;
  dmy: number;
  cosLat: number;
  mx0: number;
  my0: number;
  mx1: number;
  my1: number;
  /** Bounding box adjusted to an integer number of square cells. */
  bbox: BBox;
}

/** Plan a square-cell grid with `cellsLong` cells along the longer side of the box. */
export function planGrid(b: BBox, cellsLong: number): GridPlan {
  const { width, height, cosLat } = bboxSizeMeters(b);
  const long = Math.max(width, height);
  const d = long / cellsLong;
  const nx = Math.max(2, Math.round(width / d));
  const ny = Math.max(2, Math.round(height / d));
  const dm = d / cosLat;
  const mx0 = lon2mx(b.west);
  const my0 = lat2my(b.south);
  const mx1 = mx0 + nx * dm;
  const my1 = my0 + ny * dm;
  return {
    nx,
    ny,
    dx: d,
    dy: d,
    dmx: dm,
    dmy: dm,
    cosLat,
    mx0,
    my0,
    mx1,
    my1,
    bbox: { west: b.west, south: b.south, east: mx2lon(mx1), north: my2lat(my1) },
  };
}

/** Global pixel coordinates (256 px tiles) of a Mercator point at a zoom level. */
export function mercToPixel(mx: number, my: number, zoom: number): [number, number] {
  const size = 256 * 2 ** zoom;
  const c = Math.PI * EARTH_R;
  return [((mx + c) / (2 * c)) * size, ((c - my) / (2 * c)) * size];
}

export interface TileRange {
  zoom: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  count: number;
}

export function tileRange(plan: Pick<GridPlan, 'mx0' | 'my0' | 'mx1' | 'my1'>, zoom: number): TileRange {
  const [px0, py0] = mercToPixel(plan.mx0, plan.my1, zoom); // north-west
  const [px1, py1] = mercToPixel(plan.mx1, plan.my0, zoom); // south-east
  const n = 2 ** zoom;
  const x0 = Math.max(0, Math.floor(px0 / 256));
  const x1 = Math.min(n - 1, Math.floor((px1 - 1e-6) / 256));
  const y0 = Math.max(0, Math.floor(py0 / 256));
  const y1 = Math.min(n - 1, Math.floor((py1 - 1e-6) / 256));
  return { zoom, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

/**
 * Choose the DEM tile zoom: the coarsest zoom whose pixels are at most half the grid cell (the cell
 * value is then an area average of several source pixels), limited to `maxZoom` and `maxTiles` tiles.
 * Native resolution of the source data is ~30 m (SRTM) in most places, i.e. zoom 12-13.
 */
export function chooseDemZoom(plan: GridPlan, maxTiles = 64, maxZoom = 13): TileRange {
  let zoom = 0;
  for (let z = 0; z <= maxZoom; z++) {
    const pixelMerc = (2 * Math.PI * EARTH_R) / (256 * 2 ** z);
    zoom = z;
    if (pixelMerc <= plan.dmx / 2) break;
  }
  let r = tileRange(plan, zoom);
  while (r.count > maxTiles && zoom > 0) {
    zoom--;
    r = tileRange(plan, zoom);
  }
  return r;
}

/** Decode a Terrarium RGB pixel to elevation (m). */
export function terrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Resample a tile mosaic (row-major, north row first) to the planned grid (row-major, south row first).
 * Each cell value is the average of k x k bilinear samples over the cell footprint (box filter),
 * k ~ cell size in source pixels (1..4).
 */
export function resampleMosaic(
  plan: GridPlan,
  range: TileRange,
  mosaic: Float32Array,
  mosaicW: number,
  mosaicH: number,
): Float32Array {
  const { nx, ny } = plan;
  const out = new Float32Array(nx * ny);
  const ox = range.x0 * 256;
  const oy = range.y0 * 256;
  const pixelMerc = (2 * Math.PI * EARTH_R) / (256 * 2 ** range.zoom);
  const k = Math.max(1, Math.min(4, Math.round(plan.dmx / pixelMerc)));
  const sample = (mx: number, my: number): number => {
    const [px, py] = mercToPixel(mx, my, range.zoom);
    let fx = px - ox - 0.5;
    let fy = py - oy - 0.5;
    if (fx < 0) fx = 0;
    if (fy < 0) fy = 0;
    if (fx > mosaicW - 1) fx = mosaicW - 1;
    if (fy > mosaicH - 1) fy = mosaicH - 1;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(mosaicW - 1, x0 + 1);
    const y1 = Math.min(mosaicH - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = mosaic[y0 * mosaicW + x0];
    const b = mosaic[y0 * mosaicW + x1];
    const c = mosaic[y1 * mosaicW + x0];
    const d = mosaic[y1 * mosaicW + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let sum = 0;
      for (let sj = 0; sj < k; sj++) {
        const my = plan.my0 + (j + (sj + 0.5) / k) * plan.dmy;
        for (let si = 0; si < k; si++) {
          const mx = plan.mx0 + (i + (si + 0.5) / k) * plan.dmx;
          sum += sample(mx, my);
        }
      }
      out[j * nx + i] = sum / (k * k);
    }
  }
  return out;
}

/** Local grid metres (origin south-west) -> lon/lat for a mercator georeference. */
export function localToLonLat(x: number, y: number, bbox: BBox, cosLat: number): [number, number] {
  const mx = lon2mx(bbox.west) + x / cosLat;
  const my = lat2my(bbox.south) + y / cosLat;
  return [mx2lon(mx), my2lat(my)];
}

/** lon/lat -> local grid metres for a mercator georeference. */
export function lonLatToLocal(lon: number, lat: number, bbox: BBox, cosLat: number): [number, number] {
  return [(lon2mx(lon) - lon2mx(bbox.west)) * cosLat, (lat2my(lat) - lat2my(bbox.south)) * cosLat];
}

export function cosLatOf(b: BBox): number {
  return Math.cos(((b.south + b.north) / 2) * D2R);
}

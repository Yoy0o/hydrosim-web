/**
 * Model inputs derived from the raw terrain and the scenario: effective bed (buildings as blocks, levees
 * and weirs baked in, gates/breaches at t = 0), per-cell Manning field and solver structures.
 */
import { cellOf, polygonCells, rasterizeLine, rasterizeRings, type GridGeom } from './core/raster';
import { lineBed, type DynamicLineSpec, type LinkSpec } from './core/solver';
import { sampleSeries, type TimeSeries } from './core/timeseries';
import type { BuildingsDef, RoughnessDef, Scenario, StructureLine, Terrain } from './types';

/** Building footprints rasterised at 4 x 4 sub-samples per cell. */
export interface BuildingRaster {
  /** Covered sub-samples per cell (0..16). */
  cover: Uint8Array;
  /** Tallest building height per cell (m, 0 = unknown). */
  height: Float32Array;
  count: number;
  source: string;
}

/** Land-cover class index per cell (index into LANDCOVER_CLASSES, 0 = no data). */
export interface LandCoverRaster {
  cls: Uint8Array;
  source: string;
}

export interface LandCoverClass {
  key: string;
  label: string;
  /** Default Manning n. */
  n: number;
  color: string;
}

/** Land-cover classes (OpenMapTiles landcover/landuse/water) with typical Manning coefficients. */
export const LANDCOVER_CLASSES: LandCoverClass[] = [
  { key: 'none', label: '无数据', n: 0, color: '#4b5563' },
  { key: 'water', label: '水体', n: 0.03, color: '#3b82f6' },
  { key: 'wood', label: '林地', n: 0.1, color: '#166534' },
  { key: 'scrub', label: '灌丛', n: 0.07, color: '#65a30d' },
  { key: 'grass', label: '草地/公园', n: 0.035, color: '#a3e635' },
  { key: 'farmland', label: '农田', n: 0.04, color: '#facc15' },
  { key: 'orchard', label: '果园/葡萄园', n: 0.06, color: '#ca8a04' },
  { key: 'wetland', label: '湿地', n: 0.06, color: '#2dd4bf' },
  { key: 'sand', label: '沙地/海滩', n: 0.025, color: '#fde68a' },
  { key: 'rock', label: '裸岩/裸地', n: 0.03, color: '#a8a29e' },
  { key: 'ice', label: '冰川/冰雪', n: 0.02, color: '#e0f2fe' },
  { key: 'residential', label: '居住用地', n: 0.08, color: '#f87171' },
  { key: 'commercial', label: '商业/工业用地', n: 0.06, color: '#c084fc' },
  { key: 'urbanOther', label: '其他建设用地', n: 0.05, color: '#fb923c' },
];

export const LANDCOVER_INDEX: Record<string, number> = Object.fromEntries(LANDCOVER_CLASSES.map((c, k) => [c.key, k]));

/** Rasterise building footprints (4 x 4 sub-samples per cell) into a building raster. */
export function buildingRasterFromPolygons(g: GridGeom, items: { polygon: [number, number][]; height: number }[], source: string): BuildingRaster {
  const n = g.nx * g.ny;
  const cover = new Uint8Array(n);
  const height = new Float32Array(n);
  let count = 0;
  for (const it of items) {
    if (it.polygon.length < 3) continue;
    count++;
    rasterizeRings(g, [it.polygon], 4, (c) => {
      if (cover[c] < 16) cover[c]++;
      if (it.height > height[c]) height[c] = it.height;
    });
  }
  return { cover, height, count, source };
}

export function defaultRoughness(): RoughnessDef {
  return { useLandcover: true, table: Object.fromEntries(LANDCOVER_CLASSES.slice(1).map((c) => [c.key, c.n])), zones: [] };
}

export function defaultBuildings(): BuildingsDef {
  return { mode: 'block', defaultHeight: 10, n: 0.3, useOsm: true, items: [] };
}

/** Fill optional scenario sections (older project files / presets). */
export function ensureScenarioDefaults(sc: Scenario): Scenario {
  if (!sc.roughness) sc.roughness = defaultRoughness();
  for (const c of LANDCOVER_CLASSES.slice(1)) if (sc.roughness.table[c.key] === undefined) sc.roughness.table[c.key] = c.n;
  if (!sc.buildings) sc.buildings = defaultBuildings();
  if (!sc.structures) sc.structures = [];
  if (!sc.links) sc.links = [];
  return sc;
}

/** Time series of the crest of a gate or breach. */
export function structureSeries(s: StructureLine, groundMin: number): TimeSeries {
  const bottom = s.bottom ?? groundMin;
  const t1 = s.t1 ?? 0;
  if (s.kind === 'breach') {
    const dur = Math.max(1, s.ramp ?? 600);
    return t1 > 0 ? [[0, s.crest], [t1, s.crest], [t1 + dur, bottom]] : [[0, s.crest], [dur, bottom]];
  }
  if (s.kind === 'gate') {
    const ramp = Math.max(1, s.ramp ?? 60);
    const out: TimeSeries = t1 > 0 ? [[0, s.crest], [t1, s.crest], [t1 + ramp, bottom]] : [[0, bottom]];
    const t2 = s.t2 ?? 0;
    const opened = t1 > 0 ? t1 + ramp : 0;
    if (t2 > opened) out.push([t2, bottom], [t2 + ramp, s.crest]);
    return out;
  }
  return [[0, s.crest]];
}

export interface ModelInputs {
  bed: Float32Array;
  manning: Float32Array | null;
  lines: DynamicLineSpec[];
  links: LinkSpec[];
  /** Cells raised as buildings (block mode). */
  buildingCells: number;
  /** Building coverage used (0..16 per cell), for display. */
  buildingCover: Uint8Array | null;
  /** Cells per structure (by id), for display. */
  structureCells: Map<string, number[]>;
}

export function buildModelInputs(
  base: Terrain,
  sc: Scenario,
  aux: { buildings: BuildingRaster | null; landcover: LandCoverRaster | null },
): ModelInputs {
  ensureScenarioDefaults(sc);
  const g: GridGeom = { nx: base.nx, ny: base.ny, dx: base.dx, dy: base.dy };
  const n = g.nx * g.ny;
  const B = sc.buildings!;
  // ---- buildings
  let cover: Uint8Array | null = null;
  let bh: Float32Array | null = null;
  if (B.mode !== 'off' && ((B.useOsm && aux.buildings) || B.items.length)) {
    cover = new Uint8Array(n);
    bh = new Float32Array(n);
    if (B.useOsm && aux.buildings) {
      cover.set(aux.buildings.cover);
      bh.set(aux.buildings.height);
    }
    for (const item of B.items) {
      if (item.polygon.length < 3) continue;
      rasterizeRings(g, [item.polygon], 4, (c) => {
        if (cover![c] < 16) cover![c]++;
        if (item.height > bh![c]) bh![c] = item.height;
      });
    }
  }
  const bed0 = base.z.slice();
  let buildingCells = 0;
  if (B.mode === 'block' && cover && bh) {
    for (let c = 0; c < n; c++) {
      if (cover[c] >= 8) {
        bed0[c] = base.z[c] + (bh[c] > 0 ? bh[c] : B.defaultHeight);
        buildingCells++;
      }
    }
  }
  // ---- structure lines
  const bed = bed0.slice();
  const structureCells = new Map<string, number[]>();
  const lines: DynamicLineSpec[] = [];
  for (const s of sc.structures!) {
    if (s.points.length < 2) continue;
    const cells = rasterizeLine(g, s.points, s.width);
    structureCells.set(s.id, cells);
    if (s.kind === 'levee') for (const c of cells) bed[c] = Math.max(bed[c], s.crest);
    else if (s.kind === 'weir') for (const c of cells) bed[c] = s.crest;
  }
  // gates set the bed to their crest (closed crest -> sill), breaches erode the existing bed (DEM levees
  // included) down to their bottom; both start from the bed with static structures applied
  for (const s of sc.structures!) {
    if (s.kind !== 'gate' && s.kind !== 'breach') continue;
    const cells = structureCells.get(s.id);
    if (!cells || !cells.length) continue;
    const zGround = cells.map((c) => bed[c]);
    const series = structureSeries(s, Math.min(...zGround));
    const mode = s.kind === 'gate' ? 'set' : 'lower';
    const crest0 = sampleSeries(series, 0);
    cells.forEach((c, k) => (bed[c] = lineBed(mode, zGround[k], crest0)));
    lines.push({ cells, zGround, series, mode });
  }
  // ---- roughness
  const R = sc.roughness!;
  const lc = R.useLandcover ? aux.landcover : null;
  const resist = B.mode === 'resistance' && cover;
  let manning: Float32Array | null = null;
  if (lc || R.zones.length || resist) {
    manning = new Float32Array(n).fill(sc.manning);
    if (lc) {
      const lut = LANDCOVER_CLASSES.map((c) => R.table[c.key] ?? c.n);
      for (let c = 0; c < n; c++) {
        const k = lc.cls[c];
        if (k > 0 && lut[k] > 0) manning[c] = lut[k];
      }
    }
    for (const z of R.zones) for (const c of polygonCells(g, z.polygon)) manning[c] = z.n;
    if (resist) {
      for (let c = 0; c < n; c++) {
        if (cover![c] > 0) {
          const f = cover![c] / 16;
          manning[c] = (1 - f) * manning[c] + f * B.n;
        }
      }
    }
  }
  // ---- culverts / pumps
  const links: LinkSpec[] = sc.links!.map((L) => ({
    kind: L.kind,
    a: cellOf(g, L.x1, L.y1),
    b: cellOf(g, L.x2, L.y2),
    area: Math.max(1, L.count) * Math.PI * 0.25 * L.diameter * L.diameter,
    cd: L.cd,
    series: L.series,
  }));
  return { bed, manning, lines, links, buildingCells, buildingCover: cover, structureCells };
}

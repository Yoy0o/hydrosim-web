import type { BoundarySpec, RainSpec, Side } from './core/solver';
import type { TimeSeries } from './core/timeseries';
import type { BBox } from './data/geo';
import type { BuildingRaster, LandCoverRaster } from './model';

export type GeoRef =
  | { kind: 'local' }
  | ({ kind: 'mercator'; zoom?: number } & BBox)
  | { kind: 'projected'; xll: number; yll: number; cellsize: number };

export type TerrainSource = 'synthetic' | 'terrarium' | 'asc' | 'bundled';

export interface Terrain {
  name: string;
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  /** Bed elevation (m), row-major, j = 0 is the south row. */
  z: Float32Array;
  georef: GeoRef;
  source: TerrainSource;
  attribution?: string;
}

export interface ProbeDef {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface SectionDef {
  id: string;
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SourceDef {
  id: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  /** Q(t) in m^3/s */
  series: TimeSeries;
  /** Free text: where the hydrograph comes from. */
  origin?: string;
}

export interface RegionDef {
  id: string;
  name: string;
  /** Polygon vertices in local metres. */
  polygon: [number, number][];
  /** Initial water level (m a.s.l.) inside the polygon. */
  level: number;
}

export interface RainfallDef extends RainSpec {
  origin?: string;
}

/** Polygon with its own Manning coefficient (overrides land cover). */
export interface RoughnessZone {
  id: string;
  name: string;
  polygon: [number, number][];
  n: number;
}

export interface RoughnessDef {
  /** Use the land-cover raster (OpenStreetMap) when available. */
  useLandcover: boolean;
  /** Manning n per land-cover class key. */
  table: Record<string, number>;
  zones: RoughnessZone[];
}

export interface BuildingPolygon {
  id: string;
  polygon: [number, number][];
  /** Height above ground (m). */
  height: number;
}

/**
 * Buildings: 'block' raises the bed of cells at least half covered by buildings (water flows around them),
 * 'resistance' blends a high Manning n by the covered fraction (sub-grid), 'off' ignores them.
 */
export interface BuildingsDef {
  mode: 'off' | 'block' | 'resistance';
  /** Height used when a footprint has none (m). */
  defaultHeight: number;
  /** Manning n of building-covered area in 'resistance' mode. */
  n: number;
  /** Include footprints imported from OpenStreetMap. */
  useOsm: boolean;
  /** Footprints drawn by the user. */
  items: BuildingPolygon[];
}

export type StructureKind = 'levee' | 'weir' | 'gate' | 'breach';

/**
 * Structure line ("z-line"): levee raises the bed to the crest, weir sets it to the crest; gate and breach
 * are time-varying crests (gate: closed crest -> sill between t1 and t2; breach: crest -> bottom from t1 over ramp).
 */
export interface StructureLine {
  id: string;
  name: string;
  kind: StructureKind;
  points: [number, number][];
  /** Crest elevation (m); for gates the closed crest, for breaches the initial crest. */
  crest: number;
  /** Line width (m); <= cell size means a single 4-connected line of cells. */
  width: number;
  /** Gate sill / final breach bottom (m); default: lowest ground along the line. */
  bottom?: number;
  /** Gate opening time / breach start (s). */
  t1?: number;
  /** Gate closing time (s), optional. */
  t2?: number;
  /** Gate travel time / breach development duration (s). */
  ramp?: number;
}

export type LinkKind = 'culvert' | 'pump';

/** Culvert (orifice equation, barrels of a given diameter) or pump between an inlet and an outlet. */
export interface LinkDef {
  id: string;
  name: string;
  kind: LinkKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  diameter: number;
  count: number;
  cd: number;
  /** Pump discharge Q(t) (m^3/s). */
  series: TimeSeries;
}

export interface SimSettings {
  /** Simulated duration (s). */
  duration: number;
  cfl: number;
  order: 1 | 2;
  /** Result frame interval (s) for playback. */
  outputInterval: number;
  maxDt: number;
  hDry: number;
  arrivalDepth: number;
  /** Compute engine preference (default auto: WebGPU when available). */
  engine?: 'auto' | 'cpu' | 'gpu';
}

export type ColorMode =
  | 'realistic'
  | 'depth'
  | 'speed'
  | 'wse'
  | 'froude'
  | 'hazard'
  | 'maxDepth'
  | 'maxSpeed'
  | 'maxHazard'
  | 'arrival';

export type ColormapName = 'blues' | 'turbo' | 'viridis' | 'magma' | 'hazard';

export interface ViewSettings {
  exaggeration: number;
  colorMode: ColorMode;
  colormap: ColormapName;
  autoRange: boolean;
  rangeMin: number;
  rangeMax: number;
  /** Depth below which water is not drawn (m). */
  showDepth: number;
  particles: boolean;
  particleCount: number;
  particleSpeed: number;
  contours: boolean;
  contourInterval: number;
  basemap: 'none' | 'satellite' | 'osm';
  showBoundaries: boolean;
  waterOpacity: number;
  /** Overlay drawn on the terrain. */
  terrainOverlay: 'none' | 'roughness' | 'landcover' | 'buildings';
}

export interface Scenario {
  name: string;
  description: string;
  manning: number;
  boundaries: Record<Side, BoundarySpec>;
  initial: { baseLevel: number | null; regions: RegionDef[] };
  sources: SourceDef[];
  rainfall: RainfallDef;
  simulation: SimSettings;
  probes: ProbeDef[];
  sections: SectionDef[];
  /** ISO date-time of t = 0 for real-data driven scenarios (UTC). */
  startTime?: string;
  view?: Partial<ViewSettings>;
  /** Spatially varying roughness (optional for backward compatibility; see ensureScenarioDefaults). */
  roughness?: RoughnessDef;
  buildings?: BuildingsDef;
  structures?: StructureLine[];
  links?: LinkDef[];
}

export interface LoadedCase {
  terrain: Terrain;
  scenario: Scenario;
  /** Optional explicit initial depth (overrides base level / regions), e.g. analytical benchmarks. */
  initialDepth?: Float32Array;
  /** Suggested basemap for real-world terrain. */
  basemap?: ViewSettings['basemap'];
  /** Rasters imported from OpenStreetMap (buildings, land cover). */
  buildings?: BuildingRaster | null;
  landcover?: LandCoverRaster | null;
}

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

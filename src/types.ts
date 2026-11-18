import type { BoundarySpec, RainSpec, Side } from './core/solver';
import type { TimeSeries } from './core/timeseries';
import type { BBox } from './data/geo';

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
}

export interface LoadedCase {
  terrain: Terrain;
  scenario: Scenario;
  /** Optional explicit initial depth (overrides base level / regions), e.g. analytical benchmarks. */
  initialDepth?: Float32Array;
  /** Suggested basemap for real-world terrain. */
  basemap?: ViewSettings['basemap'];
}

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

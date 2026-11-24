/** Application controller: scenario state, simulation worker, 3D layers, tools and result stores. */
import * as THREE from 'three';
import { coriolisParameter, geostrophicTilt, lineBed, type SolverParams } from './core/solver';
import { sampleSeries } from './core/timeseries';
import { bedShearField } from './core/derived';
import { initialDepth, sectionCells } from './core/geometry';
import { fillDepressions } from './core/hydro';
import { BASEMAPS, loadBasemap } from './data/basemap';
import { OSM_VECTOR_ATTRIBUTION, importOsmVector } from './data/osmVector';
import { LANDCOVER_CLASSES, buildModelInputs, ensureScenarioDefaults, type BuildingRaster, type LandCoverRaster, type ModelInputs } from './model';
import { DEFAULT_PRESET, PRESETS, defaultView, genericScenario } from './data/presets';
import { FrameStore, SeriesStore, type ResultFrame } from './results';
import type { ColorMode, LinkKind, LoadedCase, Scenario, StructureKind, Terrain, ViewSettings } from './types';
import { uid } from './types';
import { COLOR_MODES, colormapTexture, robustRange } from './viz/colormaps';
import { MarkerLayer } from './viz/markers';
import { ParticleLayer } from './viz/particles';
import { pickSurface } from './viz/picking';
import { GridFrame, Viewer } from './viz/scene';
import { TerrainLayer, gridIndex } from './viz/terrain';
import { WaterLayer } from './viz/water';
import { SimClient } from './worker/client';
import type { EngineInfo, EnginePref, SimStats, WorkerToMain } from './worker/protocol';

export type AppEvent =
  | 'case'
  | 'scenario'
  | 'view'
  | 'frame'
  | 'records'
  | 'simstate'
  | 'tool'
  | 'playback'
  | 'selection'
  | 'hover'
  | 'busy'
  | 'message'
  | 'style'
  | 'engine';

export type Tool = 'navigate' | 'probe' | 'section' | 'source' | 'region' | 'pour' | 'roughZone' | 'building' | 'structure' | 'link';

/** Tools that collect a polygon / polyline draft finished by double-click or Enter. */
const DRAFT_TOOLS: Tool[] = ['region', 'roughZone', 'building', 'structure'];

export interface HoverInfo {
  x: number;
  y: number;
  z: number;
  h: number;
  u: number;
  v: number;
  lon?: number;
  lat?: number;
}

export interface Envelopes {
  maxH: Float32Array;
  maxV: Float32Array;
  maxHaz: Float32Array;
  arrival: Float32Array;
  t: number;
}

export type ChangeKind = 'params' | 'initial' | 'observers' | 'markers' | 'settings' | 'roughness' | 'links' | 'bed';

export class App {
  readonly viewer: Viewer;
  readonly terrainLayer: TerrainLayer;
  readonly waterLayer: WaterLayer;
  readonly particles: ParticleLayer;
  readonly markers: MarkerLayer;
  readonly sim: SimClient;
  readonly series = new SeriesStore();
  readonly frames = new FrameStore(400);

  /** Effective terrain used by the solver and views (buildings, levees, gates at t = 0 baked in). */
  terrain: Terrain | null = null;
  /** Raw DEM as loaded. */
  baseTerrain: Terrain | null = null;
  /** Rasters imported from OpenStreetMap. */
  aux: { buildings: BuildingRaster | null; landcover: LandCoverRaster | null } = { buildings: null, landcover: null };
  model: ModelInputs | null = null;
  structureKind: StructureKind = 'levee';
  linkKind: LinkKind = 'culvert';
  private dynT = NaN;
  scenario: Scenario | null = null;
  view: ViewSettings = defaultView();
  presetId: string | null = null;
  presetGroup: string | null = null;
  private initialOverride: Float32Array | null = null;

  current: ResultFrame | null = null;
  stats: SimStats | null = null;
  envelopes: Envelopes | null = null;
  running = false;
  finished = false;
  speed = 0;
  playbackIndex: number | null = null;
  tool: Tool = 'navigate';
  draft: [number, number][] = [];
  selected: string | null = null;
  hover: HoverInfo | null = null;
  range: [number, number] = [0, 1];
  basemapCanvas: HTMLCanvasElement | null = null;
  attribution: string[] = [];
  busy: { msg: string; frac: number } | null = null;
  pourRate = 100;
  /** Engine actually used by the worker (reported on init). */
  engineInfo: EngineInfo | null = null;
  /** Whether WebGPU is exposed by this browser (main-thread check, used for UI limits). */
  readonly gpuAvailable = typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
  private lastRangeUpdate = 0;
  private listeners = new Map<AppEvent, Set<(arg?: unknown) => void>>();
  private loadToken = 0;
  private basemapAbort: AbortController | null = null;

  constructor(viewport: HTMLElement) {
    this.viewer = new Viewer(viewport);
    this.terrainLayer = new TerrainLayer(this.viewer.uniforms);
    this.waterLayer = new WaterLayer(this.viewer.uniforms);
    this.particles = new ParticleLayer();
    this.viewer.overlay.add(this.particles.lines);
    this.markers = new MarkerLayer(this.viewer);
    this.sim = new SimClient();
    this.sim.onMessage = (m) => this.onWorker(m);
    this.viewer.onFrame((dt) => this.particles.update(dt, this.viewer.exaggeration));
    this.setupPointer(viewport);
  }

  // ---------------------------------------------------------------- events
  on(ev: AppEvent, fn: (arg?: unknown) => void): () => void {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
    return () => this.listeners.get(ev)!.delete(fn);
  }
  emit(ev: AppEvent, arg?: unknown): void {
    this.listeners.get(ev)?.forEach((fn) => fn(arg));
  }
  toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    this.emit('message', { msg, kind });
  }
  setBusy(msg: string | null, frac = 0): void {
    this.busy = msg ? { msg, frac } : null;
    this.emit('busy');
  }

  // ---------------------------------------------------------------- loading
  async loadPreset(id: string = DEFAULT_PRESET): Promise<void> {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) throw new Error(`unknown preset ${id}`);
    const token = ++this.loadToken;
    this.setBusy(`加载算例：${p.name}…`, 0);
    try {
      const c = await p.load((msg, frac) => this.setBusy(msg, frac));
      if (token !== this.loadToken) return;
      this.presetId = p.id;
      this.presetGroup = p.group;
      this.loadCase(c);
    } catch (err) {
      this.toast(`加载失败：${(err as Error).message}`, 'error');
    } finally {
      if (token === this.loadToken) this.setBusy(null);
    }
  }

  loadTerrain(terrain: Terrain, basemap: ViewSettings['basemap'] = 'none'): void {
    this.presetId = null;
    this.presetGroup = null;
    const sc = genericScenario(terrain);
    sc.view = { ...sc.view, basemap };
    this.loadCase({ terrain, scenario: sc, basemap });
  }

  loadCase(c: LoadedCase, keepView = false): void {
    this.pauseIfRunning();
    this.baseTerrain = c.terrain;
    this.scenario = ensureScenarioDefaults(c.scenario, c.terrain);
    this.aux = { buildings: c.buildings ?? null, landcover: c.landcover ?? null };
    this.initialOverride = c.initialDepth ?? null;
    if (!keepView) this.view = { ...defaultView(), ...(c.scenario.view ?? {}) };
    this.computeModel();
    this.buildLayers(true);
    this.terrainLayer.setTexture(null);
    this.basemapCanvas = null;
    this.resetResults();
    this.selected = null;
    this.draft = [];
    const t = this.terrain!;
    const L = Math.max(t.nx * t.dx, t.ny * t.dy);
    this.pourRate = +Math.max(0.1, (L * L * 3e-4) / 60).toPrecision(2);
    this.updateAttribution();
    this.initWorker();
    this.refreshMarkers();
    this.updateOverlay();
    this.applyStyle(true);
    if (this.view.basemap !== 'none') void this.loadBasemapTexture(this.view.basemap);
    this.emit('case');
    this.emit('scenario');
    this.emit('view');
    this.emit('simstate');
    this.emit('playback');
  }

  /** Effective bed and solver structures from the raw terrain and the scenario. */
  private computeModel(): void {
    const base = this.baseTerrain!;
    this.model = buildModelInputs(base, this.scenario!, this.aux);
    this.terrain = { ...base, z: this.model.bed };
    this.dynT = NaN;
  }

  private buildLayers(resetCamera: boolean): void {
    const t = this.terrain!;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let k = 0; k < t.z.length; k++) {
      const v = t.z[k];
      if (v < zMin) zMin = v;
      if (v > zMax) zMax = v;
    }
    const frame = new GridFrame(t.nx, t.ny, t.dx, t.dy, zMin, zMax);
    const index = gridIndex(t.nx, t.ny);
    this.viewer.setExaggeration(this.view.exaggeration);
    this.terrainLayer.build(t, frame, index, this.viewer.geo);
    this.terrainLayer.setLab(this.presetGroup === '基准验证');
    this.terrainLayer.setContours(this.view.contours, this.view.contourInterval);
    this.waterLayer.build(t, frame, index, this.viewer.geo);
    this.viewer.setFrame(frame, resetCamera);
    this.particles.setFrame(frame, t.z);
    this.particles.setCount(this.view.particles ? this.view.particleCount : 0);
    this.particles.speedFactor = this.view.particleSpeed;
    this.particles.showDepth = this.view.showDepth;
    this.markers.setTerrain(t);
  }

  private resetResults(): void {
    this.current = null;
    this.envelopes = null;
    this.stats = null;
    this.series.clear();
    this.frames.clear();
    this.playbackIndex = null;
    this.finished = false;
    this.running = false;
  }

  /** Terrain-changing edits (buildings, structure lines, DEM processing): rebuild views and restart. */
  private rebuildBed(): void {
    this.pauseIfRunning();
    this.computeModel();
    this.buildLayers(false);
    this.resetResults();
    this.initWorker();
    this.refreshMarkers();
    this.updateOverlay();
    this.applyStyle(true);
    this.emit('case');
    this.emit('simstate');
    this.emit('playback');
  }

  /** Import buildings and/or land cover from OpenStreetMap vector tiles for the current (geo-referenced) terrain. */
  async importOsm(what: { buildings: boolean; landcover: boolean }): Promise<void> {
    const base = this.baseTerrain;
    const sc = this.scenario;
    if (!base || !sc) return;
    if (base.georef.kind !== 'mercator') {
      this.toast('OpenStreetMap 导入需要地理坐标地形（在线 DEM 或真实地形算例）', 'info');
      return;
    }
    this.setBusy('准备下载 OpenStreetMap 数据…', 0);
    try {
      const r = await importOsmVector(base.georef, base, { ...what, onProgress: (m, fr) => this.setBusy(m, fr) });
      if (this.baseTerrain !== base) return;
      if (what.landcover) this.aux.landcover = r.landcover;
      if (what.buildings) this.aux.buildings = r.buildings;
      this.updateAttribution();
      const n = base.nx * base.ny;
      const parts: string[] = [];
      if (r.landcover) {
        const covered = n - (r.classCells.none ?? 0);
        parts.push(`土地覆盖 ${((100 * covered) / n).toFixed(0)}% 网格有分类`);
      }
      if (r.buildings) parts.push(`建筑物 ${r.buildings.count.toLocaleString()} 栋`);
      if (what.buildings && sc.buildings!.mode === 'block') this.rebuildBed();
      else this.update('roughness', () => undefined);
      const coarse = what.buildings && sc.buildings!.mode === 'block' && Math.max(base.dx, base.dy) > 15;
      this.toast(
        `已导入 OpenStreetMap（${r.tiles} 个 z${r.zoom} 矢量瓦片）：${parts.join('，')}` +
          (coarse ? `。网格 ${base.dx.toFixed(0)} m 较粗，建议在"③ 建筑物与水工结构"中改用"高糙率"处理建筑物` : ''),
        'ok',
      );
    } catch (err) {
      this.toast(`OpenStreetMap 导入失败：${(err as Error).message}`, 'error');
    } finally {
      this.setBusy(null);
    }
  }

  /** Terrain overlay texture: roughness, land-cover classes or building coverage. */
  updateOverlay(): void {
    const t = this.terrain;
    const m = this.model;
    const sc = this.scenario;
    if (!t || !m || !sc) return;
    const mode = this.view.terrainOverlay;
    if (mode === 'none') {
      this.terrainLayer.setOverlay(null, 0);
      return;
    }
    const n = t.nx * t.ny;
    const rgba = new Uint8Array(4 * n);
    const hex = (h: string): [number, number, number] => {
      const v = parseInt(h.slice(1), 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    };
    if (mode === 'roughness') {
      const lo = Math.log(ROUGH_RANGE[0]);
      const hi = Math.log(ROUGH_RANGE[1]);
      for (let c = 0; c < n; c++) {
        const v = m.manning ? m.manning[c] : sc.manning;
        const [r, g, b] = roughColor((Math.log(Math.max(1e-4, v)) - lo) / (hi - lo));
        rgba[4 * c] = r;
        rgba[4 * c + 1] = g;
        rgba[4 * c + 2] = b;
        rgba[4 * c + 3] = 235;
      }
    } else if (mode === 'landcover') {
      const lc = this.aux.landcover;
      const cols = LANDCOVER_CLASSES.map((k) => hex(k.color));
      if (lc) {
        for (let c = 0; c < n; c++) {
          const k = lc.cls[c];
          if (k > 0) {
            rgba[4 * c] = cols[k][0];
            rgba[4 * c + 1] = cols[k][1];
            rgba[4 * c + 2] = cols[k][2];
            rgba[4 * c + 3] = 230;
          }
        }
      }
    } else if (mode === 'buildings') {
      const cov = m.buildingCover;
      if (cov) {
        for (let c = 0; c < n; c++) {
          if (cov[c] > 0) {
            rgba[4 * c] = 200;
            rgba[4 * c + 1] = 70;
            rgba[4 * c + 2] = 60;
            rgba[4 * c + 3] = Math.round((255 * cov[c]) / 16);
          }
        }
      }
    }
    this.terrainLayer.setOverlay({ data: rgba, nx: t.nx, ny: t.ny }, 1);
  }

  /** Show gates / breaches at the displayed time by moving the affected terrain and water vertices. */
  private syncDynamicBed(time: number): void {
    const m = this.model;
    const tr = this.terrain;
    if (!m || !tr || !m.lines.length || time === this.dynT) return;
    this.dynT = time;
    let changed = false;
    for (const L of m.lines) {
      const crest = sampleSeries(L.series, time);
      L.cells.forEach((c, k) => {
        const zb = Math.fround(lineBed(L.mode, L.zGround[k], crest));
        if (tr.z[c] !== zb) {
          tr.z[c] = zb;
          changed = true;
        }
      });
    }
    if (changed) {
      this.terrainLayer.setHeights(tr.z);
      this.waterLayer.setHeights(tr.z);
    }
  }

  async loadBasemapTexture(kind: ViewSettings['basemap']): Promise<void> {
    const t = this.terrain;
    this.view.basemap = kind;
    this.basemapAbort?.abort();
    if (!t || kind === 'none' || t.georef.kind !== 'mercator') {
      this.terrainLayer.setTexture(null);
      this.basemapCanvas = null;
      this.updateAttribution();
      this.emit('view');
      if (kind !== 'none' && t && t.georef.kind !== 'mercator') this.toast('影像贴图仅适用于地理坐标（在线 DEM）地形', 'info');
      return;
    }
    const ac = new AbortController();
    this.basemapAbort = ac;
    const geo = t.georef;
    try {
      const canvas = await loadBasemap(kind, geo, { signal: ac.signal, onProgress: (m) => this.emit('message', { msg: m, kind: 'progress' }) });
      if (ac.signal.aborted || this.terrain !== t) return;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 8;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      this.terrainLayer.setTexture(tex);
      this.basemapCanvas = canvas;
      this.updateAttribution();
      this.emit('view');
    } catch (err) {
      if (!ac.signal.aborted) this.toast(`影像加载失败：${(err as Error).message}`, 'error');
    }
  }

  private updateAttribution(): void {
    const t = this.terrain;
    this.attribution = [];
    if (t?.attribution) this.attribution.push(t.attribution);
    if (this.basemapCanvas && this.view.basemap !== 'none') this.attribution.push(BASEMAPS[this.view.basemap].attribution);
    if (this.aux.buildings || this.aux.landcover) this.attribution.push(OSM_VECTOR_ATTRIBUTION);
    if (this.scenario?.rainfall.origin?.includes('Open-Meteo') || this.scenario?.sources.some((s) => s.origin?.includes('Open-Meteo')))
      this.attribution.push('气象/水文：Open-Meteo.com（ERA5 · Copernicus GloFAS），CC BY 4.0');
  }

  // ---------------------------------------------------------------- worker
  solverParams(): SolverParams {
    const s = this.scenario!;
    return {
      gravity: 9.81,
      cfl: s.simulation.cfl,
      order: s.simulation.order,
      hDry: s.simulation.hDry,
      maxDt: s.simulation.maxDt,
      manning: s.manning,
      boundaries: structuredClone(s.boundaries),
      sources: s.sources.map((q) => ({ x: q.x, y: q.y, radius: q.radius, series: q.series })),
      rainfall: s.rainfall.enabled ? { ...s.rainfall } : null,
      velocityCap: 25,
      arrivalDepth: s.simulation.arrivalDepth,
      manningField: this.model?.manning ?? null,
      lines: this.model?.lines ?? [],
      links: this.model?.links ?? [],
      coriolis: s.physics?.coriolis ? coriolisParameter(s.physics.latitude) : 0,
      wind:
        s.physics?.wind.enabled
          ? { speed: s.physics.wind.speed, direction: s.physics.wind.direction, densityRatio: 1.225 / Math.max(500, s.physics.waterDensity) }
          : null,
    };
  }

  private recordInterval(): number {
    const d = this.scenario!.simulation.duration;
    return Math.max(d / 1500, 1e-3);
  }

  computeInitialDepth(): Float32Array {
    const t = this.terrain!;
    if (this.initialOverride) return this.initialOverride.slice();
    const s = this.scenario!;
    // with rotation, an initial current starts in geostrophic balance: the base level carries its tilt
    const vel = s.initial.velocity;
    const f = s.physics?.coriolis ? coriolisParameter(s.physics.latitude) : 0;
    const Lx = t.nx * t.dx;
    const Ly = t.ny * t.dy;
    const tilt = f !== 0 && vel && (vel.u !== 0 || vel.v !== 0) ? (x: number, y: number) => geostrophicTilt(f, 9.81, vel.u, vel.v, x, y, Lx / 2, Ly / 2) : undefined;
    return initialDepth(t, s.initial.baseLevel, s.initial.regions, tilt);
  }

  /** Initial depth and unit discharges (uniform initial current in wet cells, if set). */
  computeInitialState(): { h: Float32Array; hu: Float32Array | null; hv: Float32Array | null } {
    const h = this.computeInitialDepth();
    const vel = this.scenario!.initial.velocity;
    if (!vel || (vel.u === 0 && vel.v === 0)) return { h, hu: null, hv: null };
    const hu = new Float32Array(h.length);
    const hv = new Float32Array(h.length);
    const hd = this.scenario!.simulation.hDry;
    for (let k = 0; k < h.length; k++) {
      if (h[k] > hd) {
        hu[k] = h[k] * vel.u;
        hv[k] = h[k] * vel.v;
      }
    }
    return { h, hu, hv };
  }

  private observerSpecs() {
    const t = this.terrain!;
    const s = this.scenario!;
    const probes = s.probes.map((p) => {
      const i = Math.min(t.nx - 1, Math.max(0, Math.floor(p.x / t.dx)));
      const j = Math.min(t.ny - 1, Math.max(0, Math.floor(p.y / t.dy)));
      return { id: p.id, cell: j * t.nx + i };
    });
    const sections = s.sections.map((q) => {
      const sc = sectionCells(t, q.x1, q.y1, q.x2, q.y2);
      return { id: q.id, cells: sc.cells, weights: sc.weights, nx: sc.nx, ny: sc.ny };
    });
    return { probes, sections };
  }

  private initWorker(): void {
    const t = this.terrain!;
    const s = this.scenario!;
    const obs = this.observerSpecs();
    const st = this.computeInitialState();
    this.sim.init({
      grid: { nx: t.nx, ny: t.ny, dx: t.dx, dy: t.dy },
      z: t.z.slice(),
      h0: st.h,
      hu0: st.hu,
      hv0: st.hv,
      params: this.solverParams(),
      duration: s.simulation.duration,
      outputInterval: s.simulation.outputInterval,
      recordInterval: this.recordInterval(),
      probes: obs.probes,
      sections: obs.sections,
      engine: this.enginePref(),
    });
    this.engineInfo = null;
    this.emit('engine');
    this.sim.setSpeed(this.speed);
    if (COLOR_MODES[this.view.colorMode].envelope) this.sim.requestEnvelopes();
  }

  private onWorker(m: WorkerToMain): void {
    switch (m.type) {
      case 'ready':
        this.stats = m.stats;
        this.engineInfo = m.engine;
        if (m.engine.note) this.toast(m.engine.note, 'info');
        this.emit('engine');
        this.emit('simstate');
        break;
      case 'frame': {
        if (m.reset) {
          this.series.clear();
          this.frames.clear();
          this.envelopes = null;
          this.playbackIndex = null;
          this.emit('playback');
        }
        this.stats = m.stats;
        this.running = m.stats.running;
        this.current = { t: m.stats.t, h: m.h, u: m.u, v: m.v };
        if (m.records.length) {
          this.series.add(m.records, m.probeIds, m.sectionIds);
          this.emit('records');
        }
        if (this.playbackIndex === null) this.applyState();
        this.sim.ack();
        this.emit('frame');
        break;
      }
      case 'output':
        this.frames.add({ t: m.t, h: m.h, u: m.u, v: m.v });
        this.emit('playback');
        break;
      case 'envelopes':
        this.envelopes = m;
        if (COLOR_MODES[this.view.colorMode].envelope) this.applyState();
        break;
      case 'state':
        this.running = m.running;
        this.finished = m.finished;
        if (m.finished) this.toast('计算完成', 'ok');
        this.emit('simstate');
        break;
      case 'error':
        this.running = false;
        this.toast(`计算错误：${m.message}`, 'error');
        this.emit('simstate');
        break;
    }
  }

  enginePref(): EnginePref {
    return this.scenario?.simulation.engine ?? 'auto';
  }

  /** Switch the compute engine (restarts the simulation from the initial state). */
  setEngine(pref: EnginePref): void {
    if (!this.scenario) return;
    this.scenario.simulation.engine = pref;
    this.running = false;
    this.finished = false;
    this.engineInfo = null;
    this.sim.setEngine(pref);
    this.emit('engine');
    this.emit('scenario');
    this.emit('simstate');
  }

  // ---------------------------------------------------------------- run control
  run(): void {
    if (!this.scenario) return;
    if (this.finished) {
      this.toast('已到达模拟时长。可在"计算设置"中延长时长，或点击重置。', 'info');
      return;
    }
    this.playbackIndex = null;
    this.emit('playback');
    this.sim.run();
    this.running = true;
    this.emit('simstate');
  }
  pause(): void {
    this.sim.pause();
    this.running = false;
    this.emit('simstate');
  }
  private pauseIfRunning(): void {
    if (this.running) this.pause();
  }
  toggleRun(): void {
    if (this.running) this.pause();
    else this.run();
  }
  step(n = 1): void {
    this.playbackIndex = null;
    this.sim.step(n);
  }
  reset(): void {
    this.sim.pause();
    this.running = false;
    this.finished = false;
    this.sim.reset();
    this.emit('simstate');
  }
  setSpeed(v: number): void {
    this.speed = v;
    this.sim.setSpeed(v);
    this.emit('simstate');
  }

  // ---------------------------------------------------------------- scenario edits
  /**
   * Apply an edit to the scenario. kind decides how the change propagates:
   *  params    -> hot update of solver parameters (boundaries, sources, rain, numerics)
   *  initial   -> recompute initial depth and reset the simulation
   *  observers -> probes / sections changed
   *  markers   -> only marker visuals
   *  settings  -> duration / output interval
   */
  update(kind: ChangeKind, mutate: (s: Scenario) => void): void {
    const s = this.scenario;
    if (!s) return;
    mutate(s);
    if (kind === 'params') {
      this.sim.setParams(this.solverParams());
      this.updateAttribution();
    } else if (kind === 'initial') {
      this.initialOverride = null;
      const st = this.computeInitialState();
      this.sim.setDepth(st.h, st.hu, st.hv);
      this.finished = false;
      this.running = false;
      this.emit('simstate');
    } else if (kind === 'observers') {
      const o = this.observerSpecs();
      this.sim.setObservers(o.probes, o.sections);
    } else if (kind === 'roughness' || kind === 'links') {
      // the bed does not change: refresh the Manning field / links and update the running solver
      this.model = buildModelInputs(this.baseTerrain!, s, this.aux);
      this.sim.setParams(kind === 'roughness' ? { manning: s.manning, manningField: this.model.manning } : { links: this.model.links });
      this.updateOverlay();
    } else if (kind === 'bed') {
      this.rebuildBed();
      this.toast('地形/结构已更新，模拟已从初始状态重新开始', 'info');
    } else if (kind === 'settings') {
      this.sim.setParams(this.solverParams(), {
        duration: s.simulation.duration,
        outputInterval: s.simulation.outputInterval,
        recordInterval: this.recordInterval(),
      });
      if (this.stats && this.stats.t < s.simulation.duration) this.finished = false;
      this.emit('simstate');
    }
    this.refreshMarkers();
    this.emit('scenario');
  }

  refreshMarkers(): void {
    if (!this.scenario) return;
    this.markers.rebuild(this.scenario, { showBoundaries: this.view.showBoundaries, selected: this.selected });
  }

  select(id: string | null): void {
    this.selected = id;
    this.refreshMarkers();
    this.emit('selection');
  }

  // ---------------------------------------------------------------- view
  setView(patch: Partial<ViewSettings>): void {
    const prev = this.view;
    this.view = { ...this.view, ...patch };
    const v = this.view;
    if (patch.exaggeration !== undefined && patch.exaggeration !== prev.exaggeration) {
      this.viewer.setExaggeration(v.exaggeration);
      this.refreshMarkers();
    }
    if (patch.contours !== undefined || patch.contourInterval !== undefined) this.terrainLayer.setContours(v.contours, v.contourInterval);
    if (patch.particles !== undefined || patch.particleCount !== undefined) this.particles.setCount(v.particles ? v.particleCount : 0);
    if (patch.particleSpeed !== undefined) this.particles.speedFactor = v.particleSpeed;
    if (patch.showDepth !== undefined) this.particles.showDepth = v.showDepth;
    if (patch.showBoundaries !== undefined) this.refreshMarkers();
    if (patch.colorMode !== undefined && patch.colorMode !== prev.colorMode) {
      const info = COLOR_MODES[v.colorMode];
      if (patch.colormap === undefined) this.view.colormap = info.defaultMap;
      if (patch.autoRange === undefined) this.view.autoRange = true;
      if (info.envelope) this.sim.requestEnvelopes();
    }
    if (patch.basemap !== undefined && patch.basemap !== prev.basemap) void this.loadBasemapTexture(v.basemap);
    if (patch.terrainOverlay !== undefined && patch.terrainOverlay !== prev.terrainOverlay) this.updateOverlay();
    // derived colour modes (bed shear stress) are computed from the displayed state: upload it now,
    // otherwise a paused run would keep showing the previous auxiliary field
    if (patch.colorMode !== undefined && patch.colorMode !== prev.colorMode) this.applyState();
    this.applyStyle(true);
    this.emit('view');
  }

  /** Currently displayed state (live or playback). */
  displayed(): ResultFrame | null {
    if (this.playbackIndex !== null) return this.frames.frames[this.playbackIndex] ?? null;
    return this.current;
  }

  setPlayback(index: number | null): void {
    if (index !== null) {
      if (this.running) this.pause();
      index = Math.max(0, Math.min(this.frames.frames.length - 1, index));
    }
    this.playbackIndex = index;
    this.applyState();
    this.emit('playback');
    this.emit('frame');
  }

  /** Upload the displayed state (or envelope) to the water layer and particles. */
  applyState(): void {
    const t = this.terrain;
    if (!t) return;
    const mode = this.view.colorMode;
    const info = COLOR_MODES[mode];
    const n = t.nx * t.ny;
    this.syncDynamicBed(this.displayed()?.t ?? this.stats?.t ?? 0);
    if (info.envelope) {
      const e = this.envelopes;
      if (!e) {
        this.waterLayer.update(new Float32Array(n), null, null, t.z);
        this.particles.setField(new Float32Array(n), new Float32Array(n), new Float32Array(n), 1);
      } else {
        this.waterLayer.update(e.maxH, null, null, t.z);
        const aux = mode === 'maxDepth' ? e.maxH : mode === 'maxSpeed' ? e.maxV : mode === 'maxHazard' ? e.maxHaz : e.arrival;
        this.waterLayer.setAux(aux, mode === 'arrival' ? 1 / 60 : 1);
        this.particles.setField(new Float32Array(n), new Float32Array(n), new Float32Array(n), 1);
      }
    } else {
      const s = this.displayed();
      if (!s) return;
      this.waterLayer.update(s.h, s.u, s.v, t.z);
      if (info.derived) this.waterLayer.setAux(this.shearField(s));
      this.particles.setField(s.h, s.u, s.v, Math.max(0.5, (this.stats?.maxV ?? 1) * 0.6));
    }
    const now = performance.now();
    if (this.view.autoRange && now - this.lastRangeUpdate > 800) {
      this.lastRangeUpdate = now;
      this.computeAutoRange();
      this.applyStyle(false);
    }
  }

  private shearBuf: Float32Array | null = null;
  /** Bed shear stress (Pa) of a state, with the model Manning field and the water density (§6.3). */
  shearField(s: { h: Float32Array; u: Float32Array; v: Float32Array }): Float32Array {
    const sc = this.scenario!;
    this.shearBuf = bedShearField(s.h, s.u, s.v, sc.manning, this.model?.manning ?? null, sc.physics?.waterDensity ?? 1000, this.shearBuf ?? undefined);
    return this.shearBuf;
  }

  /** Manning n at a cell (field or uniform). */
  manningAt(c: number): number {
    return this.model?.manning ? this.model.manning[c] : (this.scenario?.manning ?? 0);
  }

  computeAutoRange(): void {
    const t = this.terrain;
    if (!t) return;
    const mode: ColorMode = this.view.colorMode;
    const info = COLOR_MODES[mode];
    const thr = this.view.showDepth;
    if (info.fixed) {
      this.range = [...info.fixed];
      return;
    }
    if (info.envelope) {
      const e = this.envelopes;
      if (!e) {
        this.range = [0, 1];
        return;
      }
      if (mode === 'arrival') {
        let mx = 0;
        for (let k = 0; k < e.arrival.length; k++) if (e.arrival[k] > mx) mx = e.arrival[k];
        this.range = [0, Math.max(1, mx / 60)];
        return;
      }
      const arr = mode === 'maxDepth' ? e.maxH : e.maxV;
      const [, hi] = robustRange(arr, (k) => e.maxH[k] >= thr, 0, 0.98);
      this.range = [0, niceCeil(hi)];
      return;
    }
    const s = this.displayed();
    if (!s) return;
    if (mode === 'depth' || mode === 'realistic') {
      const [, hi] = robustRange(s.h, (k) => s.h[k] >= thr, 0, 0.98);
      this.range = [0, niceCeil(hi)];
    } else if (mode === 'speed') {
      const sp = new Float32Array(s.h.length);
      for (let k = 0; k < sp.length; k++) sp[k] = Math.hypot(s.u[k], s.v[k]);
      const [, hi] = robustRange(sp, (k) => s.h[k] >= thr, 0, 0.98);
      this.range = [0, niceCeil(hi)];
    } else if (mode === 'shear') {
      const tau = this.shearField(s);
      const [, hi] = robustRange(tau, (k) => s.h[k] >= thr, 0, 0.98);
      this.range = [0, niceCeil(hi)];
    } else if (mode === 'wse') {
      const w = new Float32Array(s.h.length);
      for (let k = 0; k < w.length; k++) w[k] = t.z[k] + s.h[k];
      const [lo, hi] = robustRange(w, (k) => s.h[k] >= thr, 0.02, 0.98);
      this.range = [Math.floor(lo * 10) / 10, Math.ceil(hi * 10) / 10];
    }
  }

  applyStyle(recomputeRange: boolean): void {
    const v = this.view;
    const info = COLOR_MODES[v.colorMode];
    if (recomputeRange && v.autoRange) this.computeAutoRange();
    const [lo, hi] = v.autoRange ? this.range : [v.rangeMin, v.rangeMax];
    if (!v.autoRange) this.range = [lo, hi];
    this.waterLayer.setStyle({
      mode: info.shader,
      cmap: colormapTexture(v.colormap),
      min: lo,
      max: hi,
      showDepth: v.showDepth,
      opacity: v.waterOpacity,
    });
    this.emit('style');
  }

  // ---------------------------------------------------------------- tools & pointer
  setTool(tool: Tool): void {
    this.tool = tool;
    this.draft = [];
    this.markers.setDraft([], false);
    this.markers.setCursor(null);
    this.emit('tool');
  }

  /** Kind of structure line drawn by the 'structure' tool (activates the tool). */
  setStructureKind(kind: StructureKind, activate = true): void {
    this.structureKind = kind;
    if (activate && this.tool !== 'structure') this.setTool('structure');
    else this.emit('tool');
  }

  /** Kind of link placed by the 'link' tool (activates the tool). */
  setLinkKind(kind: LinkKind, activate = true): void {
    this.linkKind = kind;
    if (activate && this.tool !== 'link') this.setTool('link');
    else this.emit('tool');
  }

  private pick(ev: { clientX: number; clientY: number }): { x: number; y: number; elev: number } | null {
    if (!this.terrain) return null;
    const s = this.displayed();
    return pickSurface(this.viewer, this.terrain, this.viewer.ndc(ev), s?.h ?? null, this.view.showDepth);
  }

  private setupPointer(el: HTMLElement): void {
    let down: { x: number; y: number; t: number } | null = null;
    let pouring = false;
    let hoverQueued: PointerEvent | null = null;
    const canvas = this.viewer.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (this.tool === 'pour' && e.button === 0) {
        const p = this.pick(e);
        if (p && this.terrain) {
          pouring = true;
          this.viewer.controls.enabled = false;
          this.sim.pour(p.x, p.y, 3 * Math.max(this.terrain.dx, this.terrain.dy), this.pourRate);
          if (!this.running) this.run();
        }
      }
    });
    const endPour = (): void => {
      if (pouring) {
        pouring = false;
        this.sim.pour(0, 0, 0, 0);
        this.viewer.controls.enabled = true;
      }
    };
    window.addEventListener('pointerup', (e) => {
      endPour();
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (e.target === canvas && moved < 5 && quick && e.button === 0) this.onClick(e);
    });
    canvas.addEventListener('dblclick', () => {
      if (DRAFT_TOOLS.includes(this.tool)) this.finishDraft();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!hoverQueued) requestAnimationFrame(() => {
        if (hoverQueued) this.onHover(hoverQueued, pouring);
        hoverQueued = null;
      });
      hoverQueued = e;
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.markers.setCursor(null);
      this.emit('hover');
    });
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') this.setTool('navigate');
      if (e.key === 'Enter' && DRAFT_TOOLS.includes(this.tool)) this.finishDraft();
      if (e.key === ' ') {
        e.preventDefault();
        this.toggleRun();
      }
    });
    void el;
  }

  private onHover(e: PointerEvent, pouring: boolean): void {
    const p = this.pick(e);
    const t = this.terrain;
    if (!p || !t) {
      this.hover = null;
      this.markers.setCursor(null);
      this.emit('hover');
      return;
    }
    const i = Math.min(t.nx - 1, Math.max(0, Math.floor(p.x / t.dx)));
    const j = Math.min(t.ny - 1, Math.max(0, Math.floor(p.y / t.dy)));
    const k = j * t.nx + i;
    const s = this.displayed();
    this.hover = { x: p.x, y: p.y, z: t.z[k], h: s ? s.h[k] : 0, u: s ? s.u[k] : 0, v: s ? s.v[k] : 0 };
    if (t.georef.kind === 'mercator') {
      const g = t.georef;
      const cosLat = Math.cos(((g.south + g.north) / 2) * (Math.PI / 180));
      const R = 6378137;
      const mx = (g.west * Math.PI) / 180 * R + p.x / cosLat;
      const my = R * Math.log(Math.tan(Math.PI / 4 + (g.south * Math.PI) / 360)) + p.y / cosLat;
      this.hover.lon = ((mx / R) * 180) / Math.PI;
      this.hover.lat = ((2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180) / Math.PI;
    }
    if (this.tool === 'pour') {
      this.markers.setCursor(p.x, p.y, 3 * Math.max(t.dx, t.dy), s?.h);
      if (pouring) this.sim.pour(p.x, p.y, 3 * Math.max(t.dx, t.dy), this.pourRate);
    } else if (this.tool === 'source') {
      this.markers.setCursor(p.x, p.y, 2 * Math.max(t.dx, t.dy));
    } else this.markers.setCursor(null);
    if ((DRAFT_TOOLS.includes(this.tool) || this.tool === 'section' || this.tool === 'link') && this.draft.length) {
      this.markers.setDraft(this.draft, this.isPolygonTool(), [p.x, p.y]);
    }
    this.emit('hover');
  }

  private onClick(e: PointerEvent): void {
    const p = this.pick(e);
    const t = this.terrain;
    const s = this.scenario;
    if (!p || !t || !s) return;
    switch (this.tool) {
      case 'probe': {
        const n = s.probes.length + 1;
        const id = uid('p');
        this.update('observers', (sc) => sc.probes.push({ id, name: `P${n}`, x: p.x, y: p.y }));
        this.select(id);
        this.toast(`已添加观测点 P${n}`, 'ok');
        break;
      }
      case 'section': {
        this.draft.push([p.x, p.y]);
        if (this.draft.length === 2) {
          const [[x1, y1], [x2, y2]] = this.draft;
          const n = s.sections.length + 1;
          const id = uid('s');
          this.update('observers', (sc) => sc.sections.push({ id, name: `S${n}`, x1, y1, x2, y2 }));
          this.draft = [];
          this.markers.setDraft([], false);
          this.select(id);
          this.toast(`已添加断面 S${n}（流量以沿 起点→终点 方向的右侧为正）`, 'ok');
        } else this.markers.setDraft(this.draft, false);
        break;
      }
      case 'source': {
        const n = s.sources.length + 1;
        const id = uid('q');
        const Q = +Math.max(1, this.pourRate).toPrecision(2);
        this.update('params', (sc) =>
          sc.sources.push({ id, name: `入流点 Q${n}`, x: p.x, y: p.y, radius: 2 * Math.max(t.dx, t.dy), series: [[0, Q]], origin: '恒定流量' }),
        );
        this.select(id);
        this.toast(`已添加入流点 Q${n}（${Q} m³/s，可在左侧"源汇项"中编辑过程线）`, 'ok');
        break;
      }
      case 'region':
      case 'roughZone':
      case 'building':
      case 'structure':
        this.draft.push([p.x, p.y]);
        this.markers.setDraft(this.draft, this.isPolygonTool());
        break;
      case 'link': {
        this.draft.push([p.x, p.y]);
        if (this.draft.length === 2) {
          const [[x1, y1], [x2, y2]] = this.draft;
          this.draft = [];
          this.markers.setDraft([], false);
          this.addLink(x1, y1, x2, y2);
        } else this.markers.setDraft(this.draft, false);
        break;
      }
      default:
        break;
    }
  }

  private isPolygonTool(): boolean {
    return this.tool === 'region' || this.tool === 'roughZone' || this.tool === 'building';
  }

  /** Bed (effective) elevation at a point. */
  private bedAt(x: number, y: number): number {
    const t = this.terrain!;
    const i = Math.min(t.nx - 1, Math.max(0, Math.floor(x / t.dx)));
    const j = Math.min(t.ny - 1, Math.max(0, Math.floor(y / t.dy)));
    return t.z[j * t.nx + i];
  }

  /** Finish the polygon / polyline being drawn with the current tool. */
  finishDraft(): void {
    if (this.tool === 'region') return this.finishRegion();
    const t = this.terrain;
    const s = this.scenario;
    if (!t || !s) return;
    const pts = this.draft.slice();
    const need = this.tool === 'structure' ? 2 : 3;
    if (pts.length < need) {
      if (pts.length) this.toast(this.tool === 'structure' ? '结构线至少需要 2 个点' : '多边形至少需要 3 个顶点', 'info');
      return;
    }
    this.draft = [];
    this.markers.setDraft([], false);
    if (this.tool === 'roughZone') {
      const id = uid('z');
      const n = s.roughness!.zones.length + 1;
      this.update('roughness', (sc) => sc.roughness!.zones.push({ id, name: `糙率分区 ${n}`, polygon: pts, n: 0.1 }));
      this.select(id);
      this.toast(`已添加糙率分区 ${n}（n = 0.1，可在"② 糙率与土地利用"中修改）`, 'ok');
    } else if (this.tool === 'building') {
      const id = uid('b');
      // resistance mode only changes roughness; block mode (or switching on from 'off') changes the bed
      const kind: ChangeKind = s.buildings!.mode === 'resistance' ? 'roughness' : 'bed';
      this.update(kind, (sc) => {
        if (sc.buildings!.mode === 'off') sc.buildings!.mode = 'block';
        sc.buildings!.items.push({ id, polygon: pts, height: sc.buildings!.defaultHeight });
      });
      this.toast(`已添加建筑物（高 ${s.buildings!.defaultHeight} m，${s.buildings!.mode === 'block' ? '阻水块' : '高糙率'}）`, 'ok');
    } else if (this.tool === 'structure') {
      const kind = this.structureKind;
      const zs: number[] = [];
      const step = Math.min(t.dx, t.dy);
      for (let k = 0; k + 1 < pts.length; k++) {
        const [x1, y1] = pts[k];
        const [x2, y2] = pts[k + 1];
        const m = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
        for (let q = 0; q <= m; q++) zs.push(this.bedAt(x1 + ((x2 - x1) * q) / m, y1 + ((y2 - y1) * q) / m));
      }
      const zMaxL = Math.max(...zs);
      const zMinL = Math.min(...zs);
      const r1 = (v: number): number => Math.round(v * 10) / 10;
      const id = uid('w');
      const names = { levee: '堤防', weir: '堰', gate: '闸门', breach: '溃口' };
      const n = s.structures!.filter((x) => x.kind === kind).length + 1;
      const base = { id, name: `${names[kind]} ${n}`, kind, points: pts, width: 0 };
      const dur = s.simulation.duration;
      const item =
        kind === 'levee'
          ? { ...base, crest: r1(zMaxL + 1) }
          : kind === 'weir'
            ? { ...base, crest: r1(zMinL + 0.5) }
            : kind === 'gate'
              ? { ...base, crest: r1(zMaxL + 0.5), bottom: r1(zMinL), t1: Math.round(dur * 0.3), t2: 0, ramp: 60 }
              : { ...base, crest: r1(zMaxL), bottom: r1(zMinL), t1: Math.round(dur * 0.2), ramp: Math.round(Math.min(1800, dur * 0.1)) };
      this.update('bed', (sc) => sc.structures!.push(item));
      this.select(id);
      this.toast(`已添加${names[kind]}（顶高 ${item.crest} m，可在"③ 建筑物与水工结构"中修改）`, 'ok');
    }
  }

  private addLink(x1: number, y1: number, x2: number, y2: number): void {
    const s = this.scenario!;
    const kind = this.linkKind;
    const id = uid('l');
    const n = s.links!.filter((l) => l.kind === kind).length + 1;
    const name = kind === 'culvert' ? `涵洞 ${n}` : `泵站 ${n}`;
    const Q = +Math.max(0.5, this.pourRate * 0.2).toPrecision(2);
    this.update('links', (sc) => sc.links!.push({ id, name, kind, x1, y1, x2, y2, diameter: 1, count: 1, cd: 0.6, series: [[0, Q]] }));
    this.select(id);
    this.toast(kind === 'culvert' ? `已添加${name}（直径 1 m，按孔口公式双向过流）` : `已添加${name}（${Q} m³/s，从起点抽至终点）`, 'ok');
  }

  finishRegion(): void {
    const t = this.terrain;
    if (!t || this.draft.length < 3) {
      if (this.draft.length) this.toast('多边形至少需要 3 个顶点', 'info');
      return;
    }
    const poly = this.draft.slice();
    // default level: 5 m above the lowest terrain inside (approx. by vertices + centroid)
    let zmin = Infinity;
    const cx = poly.reduce((a, q) => a + q[0], 0) / poly.length;
    const cy = poly.reduce((a, q) => a + q[1], 0) / poly.length;
    for (const [x, y] of [...poly, [cx, cy] as [number, number]]) {
      const i = Math.min(t.nx - 1, Math.max(0, Math.floor(x / t.dx)));
      const j = Math.min(t.ny - 1, Math.max(0, Math.floor(y / t.dy)));
      zmin = Math.min(zmin, t.z[j * t.nx + i]);
    }
    const level = Math.round((zmin + 5) * 10) / 10;
    const n = (this.scenario?.initial.regions.length ?? 0) + 1;
    const id = uid('r');
    this.draft = [];
    this.markers.setDraft([], false);
    this.update('initial', (sc) => sc.initial.regions.push({ id, name: `水体 ${n}`, polygon: poly, level }));
    this.select(id);
    this.toast(`已添加初始水体（水位 ${level} m，可在"初始条件"中修改），模拟已重置`, 'ok');
  }

  // ---------------------------------------------------------------- terrain processing
  /** Priority-Flood depression filling seeded from non-wall boundaries; reloads the case with the new bed. */
  fillTerrain(maxDepth: number): void {
    const t = this.baseTerrain;
    const s = this.scenario;
    if (!t || !s) return;
    const B = s.boundaries;
    const outlets = { west: B.west.type !== 'wall', east: B.east.type !== 'wall', south: B.south.type !== 'wall', north: B.north.type !== 'wall' };
    const r = fillDepressions(t.z, t.nx, t.ny, t.dx * t.dy, maxDepth, 1e-4, outlets);
    if (r.filledCells === 0) {
      this.toast('未发现需要填充的洼地', 'info');
      return;
    }
    this.baseTerrain = { ...t, z: r.z, name: t.name.includes('已填洼') ? t.name : `${t.name}（已填洼）` };
    this.rebuildBed();
    this.toast(
      `填洼完成：抬高 ${r.filledCells} 个网格，最大 ${r.maxFill.toFixed(2)} m，填充体积 ${(r.volume / 1e6).toFixed(3)} 百万 m³（模拟已重置）`,
      'ok',
    );
  }

  // ---------------------------------------------------------------- misc
  terrainStats(): { zMin: number; zMax: number } {
    const f = this.viewer.frame;
    return { zMin: f?.zMin ?? 0, zMax: f?.zMax ?? 0 };
  }
}

export function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  const n = m <= 1 ? 1 : m <= 1.5 ? 1.5 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 3 ? 3 : m <= 4 ? 4 : m <= 5 ? 5 : m <= 6 ? 6 : m <= 8 ? 8 : 10;
  return n * p;
}

/** Manning n range of the roughness overlay (log scale). */
export const ROUGH_RANGE: [number, number] = [0.01, 0.3];

/** Colour ramp for Manning n (log scale, smooth -> rough). */
export function roughColor(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [49, 130, 189]],
    [0.3, [102, 194, 164]],
    [0.55, [230, 220, 110]],
    [0.8, [216, 120, 50]],
    [1, [140, 40, 40]],
  ];
  t = Math.min(1, Math.max(0, t));
  for (let k = 0; k < stops.length - 1; k++) {
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [Math.round(c0[0] + (c1[0] - c0[0]) * f), Math.round(c0[1] + (c1[1] - c0[1]) * f), Math.round(c0[2] + (c1[2] - c0[2]) * f)];
    }
  }
  return stops[stops.length - 1][1];
}

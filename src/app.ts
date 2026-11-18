/** Application controller: scenario state, simulation worker, 3D layers, tools and result stores. */
import * as THREE from 'three';
import type { SolverParams } from './core/solver';
import { initialDepth, sectionCells } from './core/geometry';
import { fillDepressions } from './core/hydro';
import { BASEMAPS, loadBasemap } from './data/basemap';
import { DEFAULT_PRESET, PRESETS, defaultView, genericScenario } from './data/presets';
import { FrameStore, SeriesStore, type ResultFrame } from './results';
import type { ColorMode, LoadedCase, Scenario, Terrain, ViewSettings } from './types';
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

export type Tool = 'navigate' | 'probe' | 'section' | 'source' | 'region' | 'pour';

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

export type ChangeKind = 'params' | 'initial' | 'observers' | 'markers' | 'settings';

export class App {
  readonly viewer: Viewer;
  readonly terrainLayer: TerrainLayer;
  readonly waterLayer: WaterLayer;
  readonly particles: ParticleLayer;
  readonly markers: MarkerLayer;
  readonly sim: SimClient;
  readonly series = new SeriesStore();
  readonly frames = new FrameStore(400);

  terrain: Terrain | null = null;
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
    this.terrain = c.terrain;
    this.scenario = c.scenario;
    this.initialOverride = c.initialDepth ?? null;
    if (!keepView) this.view = { ...defaultView(), ...(c.scenario.view ?? {}) };
    const t = c.terrain;
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
    this.terrainLayer.setTexture(null);
    this.basemapCanvas = null;
    this.waterLayer.build(t, frame, index, this.viewer.geo);
    this.viewer.setFrame(frame);
    this.particles.setFrame(frame, t.z);
    this.particles.setCount(this.view.particles ? this.view.particleCount : 0);
    this.particles.speedFactor = this.view.particleSpeed;
    this.particles.showDepth = this.view.showDepth;
    this.markers.setTerrain(t);
    this.current = null;
    this.envelopes = null;
    this.stats = null;
    this.series.clear();
    this.frames.clear();
    this.playbackIndex = null;
    this.selected = null;
    this.draft = [];
    this.finished = false;
    this.running = false;
    const L = Math.max(t.nx * t.dx, t.ny * t.dy);
    this.pourRate = +Math.max(0.1, (L * L * 3e-4) / 60).toPrecision(2);
    this.attribution = [];
    if (t.attribution) this.attribution.push(t.attribution);
    this.initWorker();
    this.refreshMarkers();
    this.applyStyle(true);
    if (this.view.basemap !== 'none') void this.loadBasemapTexture(this.view.basemap);
    this.emit('case');
    this.emit('scenario');
    this.emit('view');
    this.emit('simstate');
    this.emit('playback');
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
    return initialDepth(t, s.initial.baseLevel, s.initial.regions);
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
    this.sim.init({
      grid: { nx: t.nx, ny: t.ny, dx: t.dx, dy: t.dy },
      z: t.z.slice(),
      h0: this.computeInitialDepth(),
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
      this.sim.setDepth(this.computeInitialDepth());
      this.finished = false;
      this.running = false;
      this.emit('simstate');
    } else if (kind === 'observers') {
      const o = this.observerSpecs();
      this.sim.setObservers(o.probes, o.sections);
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
      this.particles.setField(s.h, s.u, s.v, Math.max(0.5, (this.stats?.maxV ?? 1) * 0.6));
    }
    const now = performance.now();
    if (this.view.autoRange && now - this.lastRangeUpdate > 800) {
      this.lastRangeUpdate = now;
      this.computeAutoRange();
      this.applyStyle(false);
    }
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
      if (this.tool === 'region') this.finishRegion();
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
      if (e.key === 'Enter' && this.tool === 'region') this.finishRegion();
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
    if ((this.tool === 'region' || this.tool === 'section') && this.draft.length) {
      this.markers.setDraft(this.draft, this.tool === 'region', [p.x, p.y]);
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
        this.draft.push([p.x, p.y]);
        this.markers.setDraft(this.draft, true);
        break;
      default:
        break;
    }
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
    const t = this.terrain;
    const s = this.scenario;
    if (!t || !s) return;
    const B = s.boundaries;
    const outlets = { west: B.west.type !== 'wall', east: B.east.type !== 'wall', south: B.south.type !== 'wall', north: B.north.type !== 'wall' };
    const r = fillDepressions(t.z, t.nx, t.ny, t.dx * t.dy, maxDepth, 1e-4, outlets);
    if (r.filledCells === 0) {
      this.toast('未发现需要填充的洼地', 'info');
      return;
    }
    const terrain: Terrain = { ...t, z: r.z, name: t.name.includes('已填洼') ? t.name : `${t.name}（已填洼）` };
    this.loadCase({ terrain, scenario: s, initialDepth: this.initialOverride ?? undefined }, true);
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

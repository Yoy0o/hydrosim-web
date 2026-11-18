/** Exports (CSV, ESRI ASCII grids, PNG) and project save/load. */
import type { App } from './app';
import { ascToTerrain, parseAsc, writeAsc } from './data/asciigrid';
import { lat2my, lon2mx, cosLatOf } from './data/geo';
import type { Scenario, Terrain, ViewSettings } from './types';
import { download } from './ui/dom';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function baseName(app: App): string {
  return (app.scenario?.name ?? 'hydrosim').replace(/[\\/:*?"<>|\s]+/g, '_');
}

export function exportScreenshot(app: App): void {
  const url = app.viewer.screenshot();
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName(app)}_${stamp()}.png`;
  a.click();
}

function csvTime(app: App, t: number): string {
  const st = app.scenario?.startTime;
  if (st) return new Date(Date.parse(st) + t * 1000).toISOString();
  return t.toFixed(3);
}

export function exportProbesCsv(app: App): void {
  const s = app.scenario;
  if (!s || !app.series.rows.length) return app.toast('暂无观测点数据', 'info');
  const head = ['time' + (s.startTime ? '_utc' : '_s')];
  for (const p of s.probes) head.push(`${p.name}_depth_m`, `${p.name}_wse_m`, `${p.name}_speed_ms`);
  const lines = [head.join(',')];
  for (const r of app.series.rows) {
    const cols = [csvTime(app, r.t)];
    for (const p of s.probes) {
      const v = r.probes.get(p.id);
      cols.push(v ? v[0].toFixed(4) : '', v ? v[1].toFixed(4) : '', v ? v[2].toFixed(4) : '');
    }
    lines.push(cols.join(','));
  }
  download(`${baseName(app)}_probes_${stamp()}.csv`, '﻿' + lines.join('\n'), 'text/csv');
}

export function exportSectionsCsv(app: App): void {
  const s = app.scenario;
  if (!s || !app.series.rows.length || !s.sections.length) return app.toast('暂无断面数据', 'info');
  const lines = [['time' + (s.startTime ? '_utc' : '_s'), ...s.sections.map((q) => `${q.name}_Q_m3s`)].join(',')];
  for (const r of app.series.rows) {
    lines.push([csvTime(app, r.t), ...s.sections.map((q) => (r.sections.has(q.id) ? r.sections.get(q.id)!.toFixed(4) : ''))].join(','));
  }
  download(`${baseName(app)}_sections_${stamp()}.csv`, '﻿' + lines.join('\n'), 'text/csv');
}

export function exportBalanceCsv(app: App): void {
  if (!app.series.rows.length) return app.toast('暂无数据', 'info');
  const lines = ['time_s,volume_m3,rain_m3,inflow_m3,boundary_in_m3,boundary_out_m3,infiltration_m3,mass_error_m3,wet_area_m2'];
  for (const r of app.series.rows) {
    lines.push(
      [r.t, r.volume, r.rain, r.inflow, r.boundaryIn, r.boundaryOut, r.infiltration, r.massError, r.wetArea].map((v) => (+v.toPrecision(10)).toString()).join(','),
    );
  }
  download(`${baseName(app)}_mass_balance_${stamp()}.csv`, lines.join('\n'), 'text/csv');
}

export type GridExport = 'terrain' | 'depth' | 'wse' | 'speed' | 'maxDepth' | 'maxSpeed' | 'maxHazard' | 'arrival';

export const GRID_EXPORTS: [GridExport, string][] = [
  ['depth', '当前水深 (m)'],
  ['wse', '当前水位 (m)'],
  ['speed', '当前流速 (m/s)'],
  ['maxDepth', '最大水深包络 (m)'],
  ['maxSpeed', '最大流速包络 (m/s)'],
  ['maxHazard', '最大危险度 h(V+0.5)'],
  ['arrival', '淹没到达时间 (min)'],
  ['terrain', '地形高程 (m)'],
];

export function exportGrid(app: App, what: GridExport): void {
  const t = app.terrain;
  if (!t) return;
  const s = app.displayed();
  const e = app.envelopes;
  const thr = app.view.showDepth;
  const n = t.nx * t.ny;
  let vals: Float32Array;
  let valid: (v: number, k: number) => boolean = () => true;
  if (what === 'terrain') vals = t.z;
  else if (what === 'depth' || what === 'wse' || what === 'speed') {
    if (!s) return app.toast('暂无结果', 'info');
    vals = new Float32Array(n);
    for (let k = 0; k < n; k++) vals[k] = what === 'depth' ? s.h[k] : what === 'wse' ? s.h[k] + t.z[k] : Math.hypot(s.u[k], s.v[k]);
    valid = (_, k) => s.h[k] >= thr;
  } else {
    if (!e) {
      app.sim.requestEnvelopes();
      return app.toast('包络数据尚未就绪，请稍后重试', 'info');
    }
    if (what === 'arrival') {
      vals = new Float32Array(n);
      for (let k = 0; k < n; k++) vals[k] = e.arrival[k] / 60;
      valid = (v) => v >= 0;
    } else {
      vals = what === 'maxDepth' ? e.maxH : what === 'maxSpeed' ? e.maxV : e.maxHaz;
      valid = (_, k) => e.maxH[k] >= thr;
    }
  }
  let xll = 0;
  let yll = 0;
  let cs = t.dx;
  let crs = 'local';
  if (t.georef.kind === 'projected') {
    xll = t.georef.xll;
    yll = t.georef.yll;
  } else if (t.georef.kind === 'mercator') {
    const c = cosLatOf(t.georef);
    xll = lon2mx(t.georef.west);
    yll = lat2my(t.georef.south);
    cs = t.dx / c;
    crs = 'EPSG3857';
  }
  const txt = writeAsc(t.nx, t.ny, +cs.toFixed(6), +xll.toFixed(3), +yll.toFixed(3), vals, valid, 3);
  download(`${baseName(app)}_${what}_${crs}_${stamp()}.asc`, txt);
}

// ------------------------------------------------------------------ project files
function f32ToB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  const chunk = 0x8000;
  for (let k = 0; k < bytes.length; k += chunk) s += String.fromCharCode(...bytes.subarray(k, k + chunk));
  return btoa(s);
}

function b64ToF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return new Float32Array(bytes.buffer);
}

interface ProjectFile {
  format: 'hydrosim-web-project';
  version: 1;
  presetId: string | null;
  presetGroup: string | null;
  scenario: Scenario;
  view: ViewSettings;
  terrain: Omit<Terrain, 'z'> & { z: string };
}

export function saveProject(app: App): void {
  const t = app.terrain;
  const s = app.scenario;
  if (!t || !s) return;
  const p: ProjectFile = {
    format: 'hydrosim-web-project',
    version: 1,
    presetId: app.presetId,
    presetGroup: app.presetGroup,
    scenario: s,
    view: app.view,
    terrain: { ...t, z: f32ToB64(t.z) },
  };
  download(`${baseName(app)}_${stamp()}.hydrosim.json`, JSON.stringify(p), 'application/json');
}

export async function openProject(app: App, file: File): Promise<void> {
  const p = JSON.parse(await file.text()) as ProjectFile;
  if (p.format !== 'hydrosim-web-project') throw new Error('不是 HydroSim Web 工程文件');
  const terrain: Terrain = { ...p.terrain, z: b64ToF32(p.terrain.z) };
  app.presetId = p.presetId;
  app.presetGroup = p.presetGroup;
  app.view = { ...app.view, ...p.view };
  app.loadCase({ terrain, scenario: p.scenario }, true);
}

export async function importAsc(app: App, file: File, maxCells: number): Promise<void> {
  app.setBusy(`读取 ${file.name}…`, 0.1);
  try {
    const text = await file.text();
    app.setBusy('解析 ESRI ASCII Grid…', 0.4);
    await new Promise((r) => setTimeout(r, 20));
    const g = parseAsc(text);
    const terrain = ascToTerrain(g, maxCells, file.name.replace(/\.[^.]+$/, ''));
    app.loadTerrain(terrain);
    app.toast(`已导入 ${g.ncols}×${g.nrows} 栅格 → 计算网格 ${terrain.nx}×${terrain.ny}（${terrain.dx.toFixed(2)} m）`, 'ok');
  } finally {
    app.setBusy(null);
  }
}

/** Built-in scenarios: benchmarks, synthetic demos and real-terrain cases (bundled open data). */
import type { Side } from '../core/solver';
import { thackerPeriod, thackerSurface } from '../core/analytic';
import { triangularHydrograph } from '../core/timeseries';
import { cellOf, rasterizeLine } from '../core/raster';
import { buildingRasterFromPolygons } from '../model';
import type { LinkDef, LoadedCase, Scenario, StructureLine, Terrain, ViewSettings } from '../types';
import { uid } from '../types';
import { cosLatOf, lonLatToLocal } from './geo';
import { dischargeSeriesFromDaily, rainSeriesFromHourly, type DailyDischarge, type HourlyRain } from './openmeteo';
import {
  VALLEY_TOWN,
  OCEAN_FEATURES,
  coastLine,
  coastalTerrain,
  oceanTerrain,
  partialDamBreakTerrain,
  riverValleyTerrain,
  thackerTerrain,
  threeHumpsTerrain,
  valleyCenter,
  valleyTownBlocks,
} from './synthetic';
import { loadBundledDEM } from './terrarium';
import { fillDepressions } from '../core/hydro';

export function defaultView(): ViewSettings {
  return {
    exaggeration: 1.5,
    colorMode: 'realistic',
    colormap: 'blues',
    autoRange: true,
    rangeMin: 0,
    rangeMax: 5,
    showDepth: 0.02,
    particles: true,
    particleCount: 12000,
    particleSpeed: 1,
    contours: false,
    contourInterval: 10,
    basemap: 'none',
    showBoundaries: true,
    waterOpacity: 0.85,
    terrainOverlay: 'none',
  };
}

const allWalls = (): Scenario['boundaries'] => ({ west: { type: 'wall' }, east: { type: 'wall' }, south: { type: 'wall' }, north: { type: 'wall' } });

export function genericScenario(terrain: Terrain, name = terrain.name): Scenario {
  const L = Math.max(terrain.nx * terrain.dx, terrain.ny * terrain.dy);
  return {
    name,
    description: '自定义地形：请在左侧设置边界条件、入流点、降雨或初始水体，然后点击"运行"。',
    manning: 0.035,
    boundaries: { west: { type: 'open' }, east: { type: 'open' }, south: { type: 'open' }, north: { type: 'open' } },
    initial: { baseLevel: null, regions: [] },
    sources: [],
    rainfall: { enabled: false, series: [[0, 50], [3600, 50], [3600.001, 0]], stepwise: false, infiltration: 0 },
    simulation: { duration: 3 * 3600, cfl: 0.5, order: 1, outputInterval: 120, maxDt: 10, hDry: 1e-6, arrivalDepth: 0.05 },
    probes: [],
    sections: [],
    view: { exaggeration: L > 20000 ? 1.5 : 2 },
  };
}

/** Snap a point to the lowest cell centre within `radius` metres (keeps sources/probes in channels). */
export function snapLowest(t: Terrain, x: number, y: number, radius: number): [number, number] {
  const i0 = Math.floor(x / t.dx);
  const j0 = Math.floor(y / t.dy);
  const ri = Math.ceil(radius / t.dx);
  const rj = Math.ceil(radius / t.dy);
  let best = Infinity;
  let bi = Math.min(t.nx - 1, Math.max(0, i0));
  let bj = Math.min(t.ny - 1, Math.max(0, j0));
  for (let j = j0 - rj; j <= j0 + rj; j++) {
    for (let i = i0 - ri; i <= i0 + ri; i++) {
      if (i < 0 || j < 0 || i >= t.nx || j >= t.ny) continue;
      if (((i - i0) * t.dx) ** 2 + ((j - j0) * t.dy) ** 2 > radius * radius) continue;
      const v = t.z[j * t.nx + i];
      if (v < best) {
        best = v;
        bi = i;
        bj = j;
      }
    }
  }
  return [(bi + 0.5) * t.dx, (bj + 0.5) * t.dy];
}

function llLocal(t: Terrain, lon: number, lat: number): [number, number] {
  if (t.georef.kind !== 'mercator') throw new Error('terrain is not geo-referenced');
  return lonLatToLocal(lon, lat, t.georef, cosLatOf(t.georef));
}

/** Lower sea cells (z <= threshold, connected to the given edge) to a uniform depth: DEMs carry no bathymetry. */
function conditionSea(t: Terrain, edge: Side, threshold: number, depth: number): number {
  const { nx, ny, z } = t;
  const seen = new Uint8Array(nx * ny);
  const stack: number[] = [];
  const push = (i: number, j: number): void => {
    const c = j * nx + i;
    if (!seen[c] && z[c] <= threshold) {
      seen[c] = 1;
      stack.push(c);
    }
  };
  if (edge === 'south') for (let i = 0; i < nx; i++) push(i, 0);
  if (edge === 'north') for (let i = 0; i < nx; i++) push(i, ny - 1);
  if (edge === 'west') for (let j = 0; j < ny; j++) push(0, j);
  if (edge === 'east') for (let j = 0; j < ny; j++) push(nx - 1, j);
  let n = 0;
  while (stack.length) {
    const c = stack.pop()!;
    const i = c % nx;
    const j = (c - i) / nx;
    z[c] = Math.min(z[c], -depth);
    n++;
    if (i > 0) push(i - 1, j);
    if (i < nx - 1) push(i + 1, j);
    if (j > 0) push(i, j - 1);
    if (j < ny - 1) push(i, j + 1);
  }
  return n;
}

const dataUrl = (file: string): string => `${import.meta.env.BASE_URL}data/${file}`;

export interface PresetInfo {
  id: string;
  group: '基准验证' | '合成场景' | '真实地形';
  name: string;
  description: string;
  load: (onProgress?: (msg: string, frac: number) => void) => Promise<LoadedCase>;
}

export const PRESETS: PresetInfo[] = [
  {
    id: 'partial-dam-break',
    group: '基准验证',
    name: '非对称局部溃坝',
    description:
      'Fennema & Chaudhry (1990) 经典二维溃坝算例：200 m × 200 m 水池，坝体局部溃口宽 75 m，上游水深 10 m、下游 5 m，无摩阻。用于检验激波捕捉与二维波系结构（推荐二阶格式）。',
    load: async () => {
      const terrain = partialDamBreakTerrain();
      const scenario: Scenario = {
        name: '非对称局部溃坝',
        description: PRESETS[0].description,
        manning: 0,
        boundaries: { ...allWalls(), east: { type: 'open' } },
        initial: {
          baseLevel: null,
          regions: [
            { id: uid('r'), name: '上游水库', polygon: [[0, 0], [95, 0], [95, 200], [0, 200]], level: 10 },
            { id: uid('r'), name: '下游水体', polygon: [[105, 0], [200, 0], [200, 200], [105, 200]], level: 5 },
          ],
        },
        sources: [],
        rainfall: { enabled: false, series: [[0, 0]], stepwise: false, infiltration: 0 },
        simulation: { duration: 7.2, cfl: 0.45, order: 2, outputInterval: 0.1, maxDt: 1, hDry: 1e-6, arrivalDepth: 0.05 },
        probes: [
          { id: uid('p'), name: 'P1 溃口上游', x: 80, y: 130 },
          { id: uid('p'), name: 'P2 溃口下游', x: 125, y: 130 },
          { id: uid('p'), name: 'P3 下游角区', x: 160, y: 40 },
        ],
        sections: [{ id: uid('s'), name: '溃口断面', x1: 100, y1: 90, x2: 100, y2: 175 }],
        view: { exaggeration: 3, colorMode: 'depth', colormap: 'turbo', particleCount: 8000, showDepth: 0.005 },
      };
      return { terrain, scenario };
    },
  },
  {
    id: 'three-humps',
    group: '基准验证',
    name: '三驼峰溃坝（干湿边界）',
    description:
      'Kawahara & Umetsu (1986) / Brufau 等 (2002) 算例：75 m × 30 m 封闭槽，x = 16 m 处瞬时溃坝，上游水深 1.875 m，下游为干底并分布三个驼峰，曼宁 n = 0.018。检验干湿前沿与淹没/露出过程。',
    load: async () => {
      const terrain = threeHumpsTerrain();
      const scenario: Scenario = {
        name: '三驼峰溃坝',
        description: PRESETS[1].description,
        manning: 0.018,
        boundaries: allWalls(),
        initial: { baseLevel: null, regions: [{ id: uid('r'), name: '坝前水体', polygon: [[0, 0], [16, 0], [16, 30], [0, 30]], level: 1.875 }] },
        sources: [],
        rainfall: { enabled: false, series: [[0, 0]], stepwise: false, infiltration: 0 },
        simulation: { duration: 40, cfl: 0.45, order: 2, outputInterval: 0.25, maxDt: 1, hDry: 1e-6, arrivalDepth: 0.02 },
        probes: [
          { id: uid('p'), name: 'P1 坝前', x: 10, y: 15 },
          { id: uid('p'), name: 'P2 小驼峰间', x: 30, y: 15 },
          { id: uid('p'), name: 'P3 大驼峰后', x: 62, y: 15 },
        ],
        sections: [],
        view: { exaggeration: 2.5, colorMode: 'realistic', particleCount: 8000, showDepth: 0.003 },
      };
      return { terrain, scenario };
    },
  },
  {
    id: 'thacker',
    group: '基准验证',
    name: 'Thacker 抛物面盆地振荡',
    description:
      'Thacker (1981) 解析解：抛物面盆地 z = -D0(1 - r²/a²)（D0 = 10 m, a = 1000 m）内的倾斜平面水面周期振荡，无摩阻。岸线随时间往复移动，检验干湿边界处理与质量守恒（周期 T ≈ 449 s）。',
    load: async () => {
      const D0 = 10;
      const a = 1000;
      const eta0 = 500;
      const L = 4000;
      const n = 200;
      const terrain = thackerTerrain(D0, a, L, n);
      const init = new Float32Array(n * n);
      const dx = L / n;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = (i + 0.5) * dx - L / 2;
          init[j * n + i] = Math.max(0, thackerSurface(x, 0, D0, a, eta0) - terrain.z[j * n + i]);
        }
      }
      const T = thackerPeriod(D0, a);
      const scenario: Scenario = {
        name: 'Thacker 抛物面盆地',
        description: PRESETS[2].description,
        manning: 0,
        boundaries: allWalls(),
        initial: { baseLevel: null, regions: [] },
        sources: [],
        rainfall: { enabled: false, series: [[0, 0]], stepwise: false, infiltration: 0 },
        simulation: { duration: 3 * T, cfl: 0.45, order: 2, outputInterval: T / 40, maxDt: 20, hDry: 1e-6, arrivalDepth: 0.05 },
        probes: [
          { id: uid('p'), name: 'P1 盆地中心', x: L / 2, y: L / 2 },
          { id: uid('p'), name: 'P2 东侧 (x=+600 m)', x: L / 2 + 600, y: L / 2 },
        ],
        sections: [{ id: uid('s'), name: '中心断面', x1: L / 2, y1: L / 2 - 1200, x2: L / 2, y2: L / 2 + 1200 }],
        view: { exaggeration: 25, colorMode: 'speed', colormap: 'turbo', particleCount: 10000 },
      };
      return { terrain, scenario, initialDepth: init };
    },
  },
  {
    id: 'river-valley',
    group: '合成场景',
    name: '河谷洪水演进（城镇与堤防）',
    description:
      '6 km × 4 km 合成蜿蜒河谷：上游点源输入三角形洪水过程线（基流 40 m³/s → 峰值 900 m³/s @1.5 h），超过主槽过流能力后漫滩，城镇前有 2.6 m 堤防。下游自由出流，曼宁 n = 0.035。',
    load: async () => {
      const terrain = riverValleyTerrain(20);
      const sx = 40;
      const scenario: Scenario = {
        name: '河谷洪水演进',
        description: PRESETS[3].description,
        manning: 0.035,
        boundaries: { west: { type: 'wall' }, east: { type: 'open' }, south: { type: 'wall' }, north: { type: 'wall' } },
        initial: { baseLevel: null, regions: [] },
        sources: [
          {
            id: uid('q'),
            name: '上游来流',
            x: sx,
            y: valleyCenter(sx),
            radius: 30,
            series: triangularHydrograph(40, 900, 1.5 * 3600, 5 * 3600).concat([[8 * 3600, 40]]),
            origin: '设计洪水过程线（三角形）',
          },
        ],
        rainfall: { enabled: false, series: [[0, 20], [3600, 20], [3600.001, 0]], stepwise: false, infiltration: 0 },
        simulation: { duration: 6 * 3600, cfl: 0.5, order: 1, outputInterval: 120, maxDt: 10, hDry: 1e-6, arrivalDepth: 0.05 },
        probes: [
          { id: uid('p'), name: 'P1 上游河道', x: 1000, y: valleyCenter(1000) },
          { id: uid('p'), name: 'P2 城镇中心', x: (VALLEY_TOWN.x0 + VALLEY_TOWN.x1) / 2 + 20, y: (VALLEY_TOWN.y0 + VALLEY_TOWN.y1) / 2 + 20 },
          { id: uid('p'), name: 'P3 下游河道', x: 5500, y: valleyCenter(5500) },
        ],
        sections: [{ id: uid('s'), name: 'S1 城镇上游断面', x1: 2800, y1: valleyCenter(2800) - 700, x2: 2800, y2: valleyCenter(2800) + 700 }],
        view: { exaggeration: 3, colorMode: 'realistic', particleCount: 14000 },
      };
      return { terrain, scenario };
    },
  },
  {
    id: 'flood-defense',
    group: '合成场景',
    name: '城镇圩区防洪调度（建筑物 · 溃口 · 闸 · 泵）',
    description:
      '在合成河谷上演示糙率分区、建筑物与水工结构：城镇由沿河堤防与两道横堤围成圩区，136 栋街区建筑按阻水块（高 7 m）处理；糙率分区为主槽 0.03、滩地 0.045、街道 0.025、下游林地 0.1。洪水上涨时穿堤涵洞（2 孔 Φ1.5 m，无拍门）倒灌；2.0 h 城镇上游段堤防溃决（宽 80 m，20 min 冲至滩面）；2.5 h 起排涝泵站以 15 m³/s 抽排入河；3.5 h 下游排涝闸开启，圩内积水回排。',
    load: async () => {
      const terrain = riverValleyTerrain(20, { townBlocks: false });
      const g = { nx: terrain.nx, ny: terrain.ny, dx: terrain.dx, dy: terrain.dy };
      const T = VALLEY_TOWN;
      const buildings = buildingRasterFromPolygons(g, valleyTownBlocks().map((polygon) => ({ polygon, height: 7 })), '合成城镇街区（40 m 方块，高 7 m）');
      const r1 = (v: number): number => Math.round(v * 10) / 10;
      const zAt = (x: number, y: number): number => terrain.z[cellOf(g, x, y)];
      /** Point at distance d north of the channel centre line. */
      const bank = (x: number, d: number): [number, number] => [x, valleyCenter(x) + d];
      const along = (xa: number, xb: number, d: number, step = 50): [number, number][] => {
        const n = Math.max(1, Math.round((xb - xa) / step));
        return Array.from({ length: n + 1 }, (_, k) => bank(xa + ((xb - xa) * k) / n, d));
      };
      /** Highest floodplain ground behind the levee along a reach. */
      const floodplain = (xa: number, xb: number): number => {
        let m = -Infinity;
        for (let x = xa; x <= xb; x += 20) m = Math.max(m, zAt(x, valleyCenter(x) + 70));
        return m;
      };
      const lineGround = (pts: [number, number][], w: number): number => Math.min(...rasterizeLine(g, pts, w).map((c) => terrain.z[c]));
      // polder: river levee in four reaches with stepped crests + cross levees tying into the valley side
      const reaches: [number, number][] = [[3000, 3400], [3400, 3800], [3800, 4200], [4200, 4600]];
      const crest = reaches.map(([a, b]) => r1(floodplain(a, b) + 2.4));
      const structures: StructureLine[] = reaches.map(([a, b], k) => ({ id: uid('w'), name: `沿河堤防 ${k + 1}`, kind: 'levee', points: along(a, b, 43), crest: crest[k], width: 0 }));
      const cross = (x: number, name: string, c: number): StructureLine => ({ id: uid('w'), name, kind: 'levee', points: [bank(x, 43), bank(x, 1200)], crest: c, width: 0 });
      structures.push(cross(3000, '上游横堤', r1(floodplain(2900, 3000) + 3)), cross(4600, '下游横堤', crest[3]));
      const breachPts = along(3660, 3740, 43, 20);
      structures.push({ id: uid('w'), name: '城镇段溃口', kind: 'breach', points: breachPts, crest: crest[1], width: 24, bottom: r1(lineGround(breachPts, 24)), t1: 2 * 3600, ramp: 1200 });
      const gatePts = along(4480, 4540, 43, 20);
      structures.push({ id: uid('w'), name: '排涝闸', kind: 'gate', points: gatePts, crest: crest[3], width: 24, bottom: r1(lineGround(gatePts, 24)), t1: 3.5 * 3600, t2: 0, ramp: 600 });
      // culvert through the levee (no flap gate) and a drainage pumping station at the low end of the polder
      const [px, py] = snapLowest(terrain, 4420, valleyCenter(4420) + 85, 30); // inside the polder, behind the levee
      const links: LinkDef[] = [
        { id: uid('l'), name: '穿堤涵洞', kind: 'culvert', x1: 3200, y1: valleyCenter(3200) + 90, x2: 3200, y2: valleyCenter(3200), diameter: 1.5, count: 2, cd: 0.6, series: [[0, 0]] },
        { id: uid('l'), name: '排涝泵站', kind: 'pump', x1: px, y1: py, x2: 4420, y2: valleyCenter(4420), diameter: 1, count: 1, cd: 0.6, series: [[0, 0], [9000, 0], [9300, 15], [21600, 15]] },
      ];
      // roughness zones: channel band, town streets, riparian forest downstream
      const north = along(0, 6000, 30, 100);
      const south = along(0, 6000, -30, 100).reverse();
      const forest: [number, number][] = [...along(4700, 5900, 60, 100), ...along(4700, 5900, 450, 100).reverse()];
      const sx = 40;
      const scenario: Scenario = {
        name: '城镇圩区防洪调度',
        description: PRESETS.find((p) => p.id === 'flood-defense')!.description,
        manning: 0.045,
        boundaries: { west: { type: 'wall' }, east: { type: 'open' }, south: { type: 'wall' }, north: { type: 'wall' } },
        initial: { baseLevel: null, regions: [] },
        sources: [
          {
            id: uid('q'),
            name: '上游来流',
            x: sx,
            y: valleyCenter(sx),
            radius: 30,
            series: triangularHydrograph(40, 900, 1.5 * 3600, 5 * 3600).concat([[8 * 3600, 40]]),
            origin: '设计洪水过程线（三角形）',
          },
        ],
        rainfall: { enabled: false, series: [[0, 20], [3600, 20], [3600.001, 0]], stepwise: false, infiltration: 0 },
        simulation: { duration: 6 * 3600, cfl: 0.5, order: 1, outputInterval: 120, maxDt: 10, hDry: 1e-6, arrivalDepth: 0.05 },
        probes: [
          { id: uid('p'), name: 'P1 上游河道', x: 1000, y: valleyCenter(1000) },
          { id: uid('p'), name: 'P2 溃口内侧', x: 3700, y: valleyCenter(3700) + 110 },
          { id: uid('p'), name: 'P3 城镇中心', x: (T.x0 + T.x1) / 2 + 50, y: (T.y0 + T.y1) / 2 + 20 },
          { id: uid('p'), name: 'P4 泵站前池', x: px, y: py },
          { id: uid('p'), name: 'P5 下游河道', x: 5500, y: valleyCenter(5500) },
        ],
        sections: [
          { id: uid('s'), name: 'S1 溃口进水', x1: 3790, y1: valleyCenter(3790) + 75, x2: 3610, y2: valleyCenter(3610) + 75 },
          { id: uid('s'), name: 'S2 城镇下游河道', x1: 4800, y1: valleyCenter(4800) - 250, x2: 4800, y2: valleyCenter(4800) + 30 },
        ],
        view: { exaggeration: 3, colorMode: 'realistic', particleCount: 14000 },
        roughness: {
          useLandcover: true,
          table: {},
          zones: [
            { id: uid('z'), name: '主河槽', polygon: [...north, ...south], n: 0.03 },
            { id: uid('z'), name: '城镇街道', polygon: [[T.x0, T.y0], [T.x1, T.y0], [T.x1, T.y1], [T.x0, T.y1]], n: 0.025 },
            { id: uid('z'), name: '下游河岸林', polygon: forest, n: 0.1 },
          ],
        },
        buildings: { mode: 'block', defaultHeight: 7, n: 0.3, useOsm: true, items: [] },
        structures,
        links,
      };
      return { terrain, scenario, buildings };
    },
  },
  {
    id: 'ocean-currents',
    group: '合成场景',
    name: '海底地形中的洋流（海山 · 岛屿 · 海脊）',
    description:
      '80 km × 50 km 合成海域（水深 300 m）：东向外海流 0.4 m/s 依次经过海山（顶部水深 30 m）、岛屿和带鞍部的海脊。北纬 30° 科氏力（f = 7.3×10⁻⁵ s⁻¹），初始流场与水面处于地转平衡；东西两侧为外海开边界（特征型、无反射），南北为闭边界，海水密度 1025 kg/m³，二阶格式。可观察海山上方的地形绕流（泰勒柱效应）、岛屿尾流涡街、海脊鞍部的流量集中，用"底床剪切应力"着色查看海底冲刷强度。',
    load: async () => {
      const terrain = oceanTerrain(400);
      const F = OCEAN_FEATURES;
      const U = 0.4;
      const ocean = { type: 'ocean', mean: 0, amplitude: 0, period: 12.42 * 3600, phase: 0, u: U, v: 0 } as const;
      const scenario: Scenario = {
        name: '海底地形中的洋流',
        description: PRESETS.find((p) => p.id === 'ocean-currents')!.description,
        manning: 0.022,
        boundaries: { west: { ...ocean }, east: { ...ocean }, south: { type: 'wall' }, north: { type: 'wall' } },
        initial: { baseLevel: 0, regions: [], velocity: { u: U, v: 0 } },
        sources: [],
        rainfall: { enabled: false, series: [[0, 0]], stepwise: false, infiltration: 0 },
        simulation: { duration: 48 * 3600, cfl: 0.45, order: 2, outputInterval: 1800, maxDt: 30, hDry: 1e-6, arrivalDepth: 0.05 },
        probes: [
          { id: uid('p'), name: 'P1 上游外海', x: 8000, y: 25000 },
          { id: uid('p'), name: 'P2 海山顶', x: F.seamount.x, y: F.seamount.y },
          { id: uid('p'), name: 'P3 岛屿尾流', x: F.island.x + 8000, y: F.island.y },
          { id: uid('p'), name: 'P4 海脊鞍部', x: F.ridge.x, y: F.ridge.saddleY },
          { id: uid('p'), name: 'P5 海脊顶', x: F.ridge.x, y: 42000 },
        ],
        sections: [
          { id: uid('s'), name: 'S1 入口断面', x1: 4000, y1: 200, x2: 4000, y2: 49800 },
          { id: uid('s'), name: 'S2 海脊鞍部', x1: F.ridge.x, y1: F.ridge.saddleY - 6000, x2: F.ridge.x, y2: F.ridge.saddleY + 6000 },
        ],
        physics: { coriolis: true, latitude: 30, wind: { enabled: false, speed: [[0, 10]], direction: 270 }, waterDensity: 1025 },
        view: { exaggeration: 20, colorMode: 'speed', colormap: 'turbo', particleCount: 16000, showDepth: 0.05, waterOpacity: 0.8 },
      };
      return { terrain, scenario };
    },
  },
  {
    id: 'coastal-surge',
    group: '合成场景',
    name: '风暴潮漫滩（沙丘缺口）',
    description:
      '5 km × 4 km 合成海岸：南边界施加风暴潮水位过程（0.5 m → 3.8 m → 0.8 m，3 h），海水经沙丘缺口与潮沟侵入低洼腹地与村庄。演示水位边界条件。',
    load: async () => {
      const terrain = coastalTerrain(20);
      const surge: [number, number][] = [[0, 0.5], [1800, 0.9], [3600, 2.0], [5400, 3.4], [6300, 3.8], [7200, 3.3], [9000, 1.6], [10800, 0.8]];
      const scenario: Scenario = {
        name: '风暴潮漫滩',
        description: PRESETS[4].description,
        manning: 0.03,
        boundaries: { west: { type: 'wall' }, east: { type: 'wall' }, south: { type: 'level', series: surge }, north: { type: 'wall' } },
        initial: { baseLevel: 0.5, regions: [] },
        sources: [],
        rainfall: { enabled: false, series: [[0, 30], [3600, 30], [3600.001, 0]], stepwise: false, infiltration: 0 },
        simulation: { duration: 3 * 3600, cfl: 0.5, order: 1, outputInterval: 90, maxDt: 10, hDry: 1e-6, arrivalDepth: 0.05 },
        probes: [
          { id: uid('p'), name: 'P1 近海', x: 2500, y: 500 },
          { id: uid('p'), name: 'P2 沙丘缺口', x: 2425, y: coastLine(2425) + 110 },
          { id: uid('p'), name: 'P3 村庄', x: 3160, y: coastLine(3160) + 530 },
          { id: uid('p'), name: 'P4 西部腹地', x: 1500, y: coastLine(1500) + 600 },
        ],
        sections: [{ id: uid('s'), name: 'S1 缺口进潮断面', x1: 2550, y1: coastLine(2425) + 110, x2: 2300, y2: coastLine(2425) + 110 }], // drawn east->west so landward flow is positive
        view: { exaggeration: 6, colorMode: 'realistic', particleCount: 12000 },
      };
      return { terrain, scenario };
    },
  },
  {
    id: 'malpasset',
    group: '真实地形',
    name: 'Malpasset 溃坝（法国 1959）',
    description:
      '1959 年 12 月 2 日法国 Malpasset 拱坝溃决，约 5000 万 m³ 库水冲向 Fréjus。地形取自开放 DEM（AWS Terrain Tiles，约 46 m 网格），水库按 100 m 水位多边形初始化，南边界为海（DEM 无水深，海域以 -2.5 m 近似）。曼宁 n = 0.033。',
    load: async (onProgress) => {
      onProgress?.('加载内置 DEM…', 0.2);
      const terrain = await loadBundledDEM(dataUrl('malpasset.json'));
      conditionSea(terrain, 'south', 0.5, 2.5);
      const L = (lon: number, lat: number): [number, number] => llLocal(terrain, lon, lat);
      const reservoir = [[6.733, 43.5125], [6.786, 43.5125], [6.786, 43.553], [6.733, 43.553]].map(([lo, la]) => L(lo, la));
      const probe = (name: string, lon: number, lat: number) => {
        const [x, y] = L(lon, lat);
        const [sx, sy] = snapLowest(terrain, x, y, 120);
        return { id: uid('p'), name, x: sx, y: sy };
      };
      const [s1x1, s1y1] = L(6.736, 43.4944);
      const [s1x2, s1y2] = L(6.770, 43.4944);
      const scenario: Scenario = {
        name: 'Malpasset 溃坝',
        description: PRESETS[5].description,
        manning: 0.033,
        boundaries: { west: { type: 'open' }, east: { type: 'open' }, south: { type: 'level', series: [[0, 0]] }, north: { type: 'wall' } },
        initial: { baseLevel: 0, regions: [{ id: uid('r'), name: 'Malpasset 水库', polygon: reservoir, level: 100 }] },
        sources: [],
        rainfall: { enabled: false, series: [[0, 0]], stepwise: false, infiltration: 0 },
        simulation: { duration: 4000, cfl: 0.5, order: 1, outputInterval: 40, maxDt: 5, hDry: 1e-6, arrivalDepth: 0.1 },
        probes: [
          probe('P1 坝下 0.7 km', 6.75575, 43.50567),
          probe('P2 峡谷段', 6.7523, 43.49442),
          probe('P3 A8 高速附近', 6.74541, 43.47942),
          probe('P4 平原上游', 6.73852, 43.464),
          probe('P5 Fréjus 北', 6.73565, 43.44233),
          probe('P6 Fréjus 城区', 6.74024, 43.43107),
        ],
        sections: [{ id: uid('s'), name: 'S1 峡谷断面', x1: s1x1, y1: s1y1, x2: s1x2, y2: s1y2 }],
        view: { exaggeration: 2, colorMode: 'realistic', particleCount: 15000, basemap: 'satellite' },
      };
      return { terrain, scenario, basemap: 'satellite' };
    },
  },
  {
    id: 'ahr-2021',
    group: '真实地形',
    name: 'Ahr 河谷洪水（德国 2021-07）',
    description:
      '2021 年 7 月西欧特大暴雨中的 Ahr 河谷（Altenahr → Bad Neuenahr）。开放数据驱动：DEM（AWS Terrain Tiles，约 52 m 网格）+ ERA5 逐时降雨（Open-Meteo）+ GloFAS 逐日流量作为上游入流。注意：再分析降雨与日均流量会显著低估实际峰值（实测洪峰约 1000 m³/s），本算例用于演示数据链路。DEM 已做填洼预处理（≤12 m）以消除窄谷中的 SRTM 伪坝。',
    load: async (onProgress) => {
      onProgress?.('加载内置 DEM 与气象水文数据…', 0.2);
      const terrain = await loadBundledDEM(dataUrl('ahr.json'));
      // SRTM artefacts (bridges / canopy) block the narrow valley: fill pits up to 12 m draining to the outlet
      const filled = fillDepressions(terrain.z, terrain.nx, terrain.ny, terrain.dx * terrain.dy, 12, 1e-4, { west: false, east: true, south: false, north: false });
      terrain.z = filled.z;
      terrain.name += '（已填洼 ≤12 m）';
      const res = await fetch(dataUrl('ahr2021_forcing.json'));
      const forcing = (await res.json()) as { rain: HourlyRain; discharge: DailyDischarge };
      const t0 = '2021-07-14T00:00:00Z';
      const L = (lon: number, lat: number): [number, number] => llLocal(terrain, lon, lat);
      const probe = (name: string, lon: number, lat: number) => {
        const [x, y] = L(lon, lat);
        const [sx, sy] = snapLowest(terrain, x, y, 200);
        return { id: uid('p'), name, x: sx, y: sy };
      };
      const [qx, qy] = L(6.9730, 50.4868);
      const [sqx, sqy] = snapLowest(terrain, qx, qy, 150);
      const [a1, b1] = L(7.0450, 50.5260);
      const [a2, b2] = L(7.0450, 50.5420);
      const duration = 36 * 3600;
      const scenario: Scenario = {
        name: 'Ahr 河谷洪水 2021',
        description: PRESETS[6].description,
        manning: 0.04,
        boundaries: { west: { type: 'wall' }, east: { type: 'open' }, south: { type: 'wall' }, north: { type: 'wall' } },
        initial: { baseLevel: null, regions: [] },
        sources: [
          {
            id: uid('q'),
            name: 'Ahr 上游来流 (GloFAS)',
            x: sqx,
            y: sqy,
            radius: 60,
            series: dischargeSeriesFromDaily(forcing.discharge, t0),
            origin: `Open-Meteo Flood API · GloFAS v4 日均流量 @${forcing.discharge.latitude.toFixed(3)}, ${forcing.discharge.longitude.toFixed(3)}`,
          },
        ],
        rainfall: {
          enabled: true,
          series: rainSeriesFromHourly(forcing.rain, t0, duration),
          stepwise: true,
          infiltration: 1,
          origin: `Open-Meteo ERA5 逐时降水 @${forcing.rain.latitude.toFixed(3)}, ${forcing.rain.longitude.toFixed(3)}`,
        },
        simulation: { duration, cfl: 0.5, order: 1, outputInterval: 600, maxDt: 10, hDry: 1e-6, arrivalDepth: 0.1 },
        probes: [
          probe('P1 Altenahr', 6.9917, 50.5136),
          probe('P2 Mayschoß', 7.0170, 50.5180),
          probe('P3 Dernau', 7.0450, 50.5330),
          probe('P4 Ahrweiler', 7.0950, 50.5400),
          probe('P5 Bad Neuenahr', 7.1200, 50.5450),
        ],
        sections: [{ id: uid('s'), name: 'S1 Dernau 断面', x1: a1, y1: b1, x2: a2, y2: b2 }],
        startTime: t0,
        view: { exaggeration: 2, colorMode: 'realistic', particleCount: 12000, basemap: 'satellite', showDepth: 0.05 },
      };
      return { terrain, scenario, basemap: 'satellite' };
    },
  },
];

export const DEFAULT_PRESET = 'river-valley';

/**
 * Verification suite: each case checks one algorithm of the solver against an analytical solution or an
 * exact invariant, with explicit pass thresholds. The same cases run
 *  - in the browser (算法核验 dialog, src/verify/verify.worker.ts) so results can be checked while using the app,
 *  - in Vitest (tests/verify.test.ts) so the thresholds are enforced on every change.
 * Algorithms and thresholds are described in docs/ALGORITHMS.md §15.
 */
import { ritter, stoker, thackerPeriod, thackerSurface } from '../core/analytic';
import {
  SWESolver,
  culvertDischarge,
  defaultSolverParams,
  geostrophicTilt,
  windStress,
  type BoundarySpec,
  type GridSpec,
  type SolverParams,
} from '../core/solver';

export interface VerifyMetric {
  label: string;
  value: number;
  /** Threshold: value <= limit for 'max', value >= limit for 'min'. */
  limit: number;
  kind: 'max' | 'min';
  unit?: string;
}

export interface PlotSeries {
  name: string;
  x: number[];
  y: number[];
  /** Reference (analytical) curves are drawn dashed. */
  ref?: boolean;
}

export interface VerifyPlot {
  title: string;
  xLabel: string;
  yLabel: string;
  series: PlotSeries[];
}

export interface VerifyResult {
  id: string;
  pass: boolean;
  skipped?: boolean;
  metrics: VerifyMetric[];
  ms: number;
  detail?: string;
  plot?: VerifyPlot;
}

export interface VerifyCase {
  id: string;
  title: string;
  /** Algorithm under test (short). */
  algorithm: string;
  /** Section id in docs/ALGORITHMS.md (e.g. "s4" for §4, "s8-4" for §8.4). */
  doc: string;
  description: string;
  /** GPU cases need WebGPU (browser only). */
  gpu?: boolean;
  run: () => Promise<Omit<VerifyResult, 'id' | 'pass' | 'ms'>>;
}

// ------------------------------------------------------------------ helpers
const walls = (): Record<'west' | 'east' | 'south' | 'north', BoundarySpec> => ({
  west: { type: 'wall' },
  east: { type: 'wall' },
  south: { type: 'wall' },
  north: { type: 'wall' },
});

function params(over: Partial<SolverParams> = {}): SolverParams {
  return { ...defaultSolverParams(), manning: 0, ...over };
}

function runUntil(s: SWESolver, tEnd: number, onStep?: (s: SWESolver) => void): void {
  let guard = 0;
  while (s.t < tEnd - 1e-9 && guard++ < 2e6) {
    s.step(tEnd - s.t);
    onStep?.(s);
  }
}

const m = (label: string, value: number, limit: number, kind: 'max' | 'min' = 'max', unit?: string): VerifyMetric => ({ label, value, limit, kind, unit });

/** Thin the points of a curve for plotting. */
function thin(x: number[], y: number[], n = 160): { x: number[]; y: number[] } {
  const step = Math.max(1, Math.floor(x.length / n));
  const ox: number[] = [];
  const oy: number[] = [];
  for (let k = 0; k < x.length; k += step) {
    ox.push(x[k]);
    oy.push(y[k]);
  }
  return { x: ox, y: oy };
}

function solver(grid: GridSpec, z: ArrayLike<number>, p: SolverParams, h: ArrayLike<number>, hu?: ArrayLike<number>, hv?: ArrayLike<number>): SWESolver {
  const s = new SWESolver(grid, z, p);
  s.setState(h, hu, hv);
  return s;
}

// ------------------------------------------------------------------ cases
function damBreak(order: 1 | 2, h1: number): { l1: number; mass: number; x: number[]; hNum: number[]; hEx: number[] } {
  const nx = 400;
  const ny = 3;
  const dx = 1;
  const x0 = 200;
  const h0 = 1;
  const z = new Float64Array(nx * ny);
  const h = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = (i + 0.5) * dx < x0 ? h0 : h1;
  const s = solver(
    { nx, ny, dx, dy: dx },
    z,
    params({ order, cfl: order === 1 ? 0.5 : 0.45, boundaries: { ...walls(), west: { type: 'open' }, east: { type: 'open' } } }),
    h,
  );
  runUntil(s, 20);
  let err = 0;
  let ref = 0;
  const xs: number[] = [];
  const hn: number[] = [];
  const he: number[] = [];
  for (let i = 0; i < nx; i++) {
    const x = (i + 0.5) * dx;
    const [e] = h1 > 0 ? stoker(x, s.t, x0, h0, h1) : ritter(x, s.t, x0, h0);
    const v = s.h[s.idx(i, 1)];
    err += Math.abs(v - e);
    ref += e;
    xs.push(x);
    hn.push(v);
    he.push(e);
  }
  return { l1: err / ref, mass: Math.abs(s.massBalance().error), x: xs, hNum: hn, hEx: he };
}

function damBreakCase(id: string, h1: number, title: string): VerifyCase {
  return {
    id,
    title,
    algorithm: 'HLL 黎曼求解器 + 静水重构，一阶/二阶',
    doc: 's3',
    description:
      h1 > 0
        ? 'Stoker 湿底溃坝（h1/h0 = 0.1）：激波 + 稀疏波，t = 20 s 与解析解比较水深 L1 相对误差。'
        : 'Ritter 干底溃坝：稀疏波伸入干底，检验干底波速与干湿前沿，t = 20 s 与解析解比较水深 L1 相对误差。',
    run: async () => {
      const a = damBreak(1, h1);
      const b = damBreak(2, h1);
      const p1 = thin(a.x, a.hNum);
      const p2 = thin(b.x, b.hNum);
      const pe = thin(a.x, a.hEx);
      return {
        metrics: [m('L1 相对误差（一阶）', a.l1, 0.03), m('L1 相对误差（二阶）', b.l1, 0.015), m('质量误差（一阶）', a.mass, 1e-9, 'max', 'm³')],
        plot: {
          title: `${title}：t = 20 s 水深剖面`,
          xLabel: 'x (m)',
          yLabel: 'h (m)',
          series: [
            { name: '解析解', ...pe, ref: true },
            { name: '一阶', ...p1 },
            { name: '二阶', ...p2 },
          ],
        },
      };
    },
  };
}

export const CASES: VerifyCase[] = [
  {
    id: 'lake-at-rest',
    title: '静水和谐（Lake at rest）',
    algorithm: 'Chen–Noelle 静水重构 + 子单元底坡源项',
    doc: 's4',
    description: '起伏、带岛屿与干湿边界的地形上静水（η = 1 m），一阶/二阶各推进 300 步：流量与水深变化应保持在舍入误差量级。',
    run: async () => {
      const nx = 60;
      const ny = 50;
      const dx = 10;
      const z = new Float64Array(nx * ny);
      const h = new Float64Array(nx * ny);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x = (i + 0.5) * dx;
          const y = (j + 0.5) * dx;
          const zz = 0.8 * Math.sin(x / 50) * Math.cos(y / 70) + 1.6 * Math.exp(-((x - 300) ** 2 + (y - 250) ** 2) / 80 ** 2) - 0.4 + 0.3 * Math.sin(i * 1.7 + j * 0.9);
          z[j * nx + i] = zz;
          h[j * nx + i] = Math.max(0, 1 - zz);
        }
      }
      const metrics: VerifyMetric[] = [];
      for (const order of [1, 2] as const) {
        const s = solver({ nx, ny, dx, dy: dx }, z, params({ order, manning: 0.03 }), h);
        for (let k = 0; k < 300; k++) s.step();
        let maxQ = 0;
        let maxDh = 0;
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const p = s.idx(i, j);
            maxQ = Math.max(maxQ, Math.abs(s.hu[p]), Math.abs(s.hv[p]));
            maxDh = Math.max(maxDh, Math.abs(s.h[p] - h[j * nx + i]));
          }
        }
        const o = order === 1 ? '一阶' : '二阶';
        metrics.push(m(`max |hu|,|hv|（${o}）`, maxQ, 1e-10, 'max', 'm²/s'), m(`max |Δh|（${o}）`, maxDh, 1e-10, 'max', 'm'));
      }
      return { metrics };
    },
  },
  damBreakCase('ritter', 0, 'Ritter 干底溃坝'),
  damBreakCase('stoker', 0.1, 'Stoker 湿底溃坝'),
  {
    id: 'mass-closed',
    title: '闭合域质量守恒与非负性',
    algorithm: '守恒更新、负水深截断统计',
    doc: 's11',
    description: '封闭水池中的溃坝与干湿往复（曼宁 n = 0.02），一阶/二阶各 400 步：总水量相对误差、最小水深与截断量。',
    run: async () => {
      const nx = 80;
      const ny = 60;
      const dx = 5;
      const z = new Float64Array(nx * ny);
      const h = new Float64Array(nx * ny);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x = (i + 0.5) * dx;
          const y = (j + 0.5) * dx;
          z[j * nx + i] = 2 * Math.sin(x / 40) * Math.sin(y / 30) + 0.01 * x;
          h[j * nx + i] = x < 120 && y > 100 ? Math.max(0, 6 - z[j * nx + i]) : 0;
        }
      }
      const metrics: VerifyMetric[] = [];
      for (const order of [1, 2] as const) {
        const s = solver({ nx, ny, dx, dy: dx }, z, params({ order, manning: 0.02 }), h);
        let minH = Infinity;
        for (let k = 0; k < 400; k++) {
          s.step();
          for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) minH = Math.min(minH, s.h[s.idx(i, j)]);
        }
        const mb = s.massBalance();
        const o = order === 1 ? '一阶' : '二阶';
        metrics.push(m(`质量相对误差（${o}）`, Math.abs(mb.error) / mb.volume0, 1e-11), m(`最小水深（${o}）`, minH, 0, 'min', 'm'), m(`截断量/初始水量（${o}）`, mb.clipped / mb.volume0, 1e-6));
      }
      return { metrics };
    },
  },
  {
    id: 'rain-runoff',
    title: '斜坡降雨产流平衡',
    algorithm: '降雨源项精确积分、自由出流边界、薄层流',
    doc: 's9',
    description: '1 km 长、坡度 1% 的平面上 100 mm/h 恒定降雨，曼宁 n = 0.03：平衡后出口流量应等于降雨量，坡中水深与运动波解 h = (i x n / √S)^0.6 比较。',
    run: async () => {
      const nx = 200;
      const ny = 2;
      const dx = 5;
      const dy = 25;
      const L = nx * dx;
      const S0 = 0.01;
      const rain = 100;
      const z = new Float64Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = S0 * (L - (i + 0.5) * dx);
      const s = solver(
        { nx, ny, dx, dy },
        z,
        params({ manning: 0.03, rainfall: { enabled: true, series: [[0, rain]], stepwise: false, infiltration: 0 }, boundaries: { ...walls(), east: { type: 'open' } } }),
        new Float64Array(nx * ny),
      );
      runUntil(s, 9000);
      const out0 = s.bndOut;
      const t0 = s.t;
      runUntil(s, 10000);
      const qOut = (s.bndOut - out0) / (s.t - t0);
      const qRain = (rain / 3.6e6) * L * ny * dy;
      const iMid = nx / 2;
      const xMid = (iMid + 0.5) * dx;
      const hKin = Math.pow(((rain / 3.6e6) * xMid * 0.03) / Math.sqrt(S0), 0.6);
      const xs: number[] = [];
      const hn: number[] = [];
      const hk: number[] = [];
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) * dx;
        xs.push(x);
        hn.push(s.h[s.idx(i, 0)] * 1000);
        hk.push(Math.pow(((rain / 3.6e6) * x * 0.03) / Math.sqrt(S0), 0.6) * 1000);
      }
      return {
        metrics: [
          m('|Q出 / Q雨 − 1|', Math.abs(qOut / qRain - 1), 0.02),
          m('质量相对误差', Math.abs(s.massBalance().error) / s.rainVol, 1e-9),
          m('|h坡中 / h运动波 − 1|', Math.abs(s.h[s.idx(iMid, 0)] / hKin - 1), 0.25),
        ],
        detail: '粗网格上的薄层坡面流（水深小于单个网格的床面高差）与运动波解相差约 15%，属于空间分辨率误差。',
        plot: { title: '平衡水深沿程分布', xLabel: 'x (m)', yLabel: 'h (mm)', series: [{ name: '运动波解', x: xs, y: hk, ref: true }, { name: '数值解', x: xs, y: hn }] },
      };
    },
  },
  {
    id: 'manning-normal',
    title: '曼宁均匀流（正常水深）',
    algorithm: '隐式曼宁摩阻 + 底坡源项 + 自由出流边界',
    doc: 's6',
    description:
      '2 km 长、坡度 0.1% 的矩形渠道，单宽流量 1 m²/s，n = 0.03，下游为自由出流：渠道应在全程保持正常水深 hn = (n q / √S)^(3/5) ≈ 0.969 m（同时检验出流边界不产生壅水）。',
    run: async () => {
      const nx = 100;
      const ny = 3;
      const dx = 20;
      const dy = 20;
      const L = nx * dx;
      const S0 = 1e-3;
      const n = 0.03;
      const q = 1;
      const z = new Float64Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = S0 * (L - (i + 0.5) * dx);
      const hn = Math.pow((n * q) / Math.sqrt(S0), 0.6);
      const metrics: VerifyMetric[] = [];
      const series: PlotSeries[] = [];
      const xs: number[] = [];
      for (let i = 0; i < nx; i++) xs.push((i + 0.5) * dx);
      series.push({ name: '正常水深', x: xs, y: xs.map(() => hn), ref: true });
      let detail = `正常水深 hn = ${hn.toFixed(4)} m。`;
      for (const order of [1, 2] as const) {
        const s = solver(
          { nx, ny, dx, dy },
          z,
          params({ order, manning: n, sources: [{ x: 0.5 * dx, y: 0.5 * ny * dy, radius: 31, series: [[0, q * ny * dy]] }], boundaries: { ...walls(), east: { type: 'open' } } }),
          new Float64Array(nx * ny),
        );
        runUntil(s, 7200);
        let hm = 0;
        let qm = 0;
        let hOut = 0;
        let cnt = 0;
        for (let i = Math.floor(0.3 * nx); i < nx; i++) {
          hm += s.h[s.idx(i, 1)];
          qm += s.hu[s.idx(i, 1)];
          cnt++;
          hOut = s.h[s.idx(i, 1)];
        }
        hm /= cnt;
        qm /= cnt;
        const o = order === 1 ? '一阶' : '二阶';
        const lim = order === 1 ? [0.02, 0.03] : [0.005, 0.005];
        metrics.push(
          m(`|h / hn − 1|（${o}）`, Math.abs(hm / hn - 1), lim[0]),
          m(`|q单元 / q − 1|（${o}）`, Math.abs(qm / q - 1), lim[1]),
          m(`|h出口 / hn − 1|（${o}）`, Math.abs(hOut / hn - 1), lim[0]),
        );
        series.push({ name: o, x: xs, y: xs.map((_, i) => s.h[s.idx(i, 1)]) });
        detail += ` ${o}：下游 70% 河段平均水深 ${hm.toFixed(4)} m、单元单宽流量 ${qm.toFixed(4)} m²/s。`;
      }
      detail += ' 一阶的单元流量偏低约 2%：静水重构在坡面上使界面水深差 δ = S·Δx，界面通量比单元流量大 δ(c−u)/2（界面通量严格等于 1），随网格加密收敛。';
      return { metrics, detail, plot: { title: '渠道水深沿程分布（t = 2 h，入口为无动量点源）', xLabel: 'x (m)', yLabel: 'h (m)', series } };
    },
  },
  {
    id: 'thacker',
    title: 'Thacker 抛物面盆地振荡',
    algorithm: '干湿前沿处理（移动岸线）、二阶格式',
    doc: 's10',
    description: 'Thacker (1981) 平面水面在抛物面盆地中周期振荡（D0 = 1 m，a = 1 km，无摩阻）：二阶格式推进一个周期后与解析水深比较。',
    run: async () => {
      const D0 = 1;
      const a = 1000;
      const eta0 = 500;
      const n = 100;
      const L = 4000;
      const dx = L / n;
      const z = new Float64Array(n * n);
      const h = new Float64Array(n * n);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = (i + 0.5) * dx - L / 2;
          const y = (j + 0.5) * dx - L / 2;
          const zb = -D0 * (1 - (x * x + y * y) / (a * a));
          z[j * n + i] = zb;
          h[j * n + i] = Math.max(0, thackerSurface(x, 0, D0, a, eta0) - zb);
        }
      }
      const s = solver({ nx: n, ny: n, dx, dy: dx }, z, params({ order: 2, cfl: 0.45, maxDt: 50 }), h);
      const T = thackerPeriod(D0, a);
      runUntil(s, T);
      let err = 0;
      let cnt = 0;
      const j = n / 2;
      const xs: number[] = [];
      const wn: number[] = [];
      const we: number[] = [];
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * dx - L / 2;
        const y = (j + 0.5) * dx - L / 2;
        const zb = -D0 * (1 - (x * x + y * y) / (a * a));
        const ex = thackerSurface(x, s.t, D0, a, eta0);
        const he = Math.max(0, ex - zb);
        const hv = s.h[s.idx(i, j)];
        if (Math.abs(x) <= 0.5 * a) {
          err += Math.abs(hv - he);
          cnt++;
        }
        if (Math.abs(x) <= 1.3 * a) {
          xs.push(x);
          wn.push(hv > 1e-4 ? zb + hv : NaN);
          we.push(he > 0 ? ex : NaN);
        }
      }
      return {
        metrics: [m('核心区平均 |Δh|', err / cnt, 0.05, 'max', 'm'), m('质量相对误差', Math.abs(s.massBalance().error) / s.volume0, 1e-10)],
        plot: { title: '一个周期后中心断面水面', xLabel: 'x (m)', yLabel: 'η (m)', series: [{ name: '解析解', x: xs, y: we, ref: true }, { name: '二阶数值解', x: xs, y: wn }] },
      };
    },
  },
  {
    id: 'coriolis-inertial',
    title: '科氏力：惯性振荡',
    algorithm: '科氏力精确旋转（f 平面）',
    doc: 's7-1',
    description: '平底水域中均匀初始流 u0 = 0.1 m/s，f = 1e-3 s⁻¹（惯性周期 6283 s）：远离边界的流速应按 u = u0 cos ft、v = −u0 sin ft 旋转，一个周期后回到初值。',
    run: async () => {
      // 100 x 100 cells of 4 km: one period takes 32 steps and an explicit 3-point stencil spreads one
      // cell per step, so the centre (50 cells from every wall) is provably untouched by the boundaries
      const nx = 100;
      const dx = 4000;
      const h0 = 10;
      const f = 1e-3;
      const u0 = 0.1;
      const N = nx * nx;
      const z = new Float64Array(N).fill(-h0);
      const h = new Float64Array(N).fill(h0);
      const hu = new Float64Array(N).fill(h0 * u0);
      const s = solver({ nx, ny: nx, dx, dy: dx }, z, params({ coriolis: f, maxDt: 200 }), h, hu, new Float64Array(N));
      const c = s.idx(nx / 2, nx / 2);
      const ts: number[] = [];
      const us: number[] = [];
      const vs: number[] = [];
      const T = (2 * Math.PI) / f;
      runUntil(s, T, (sv) => {
        ts.push(sv.t);
        us.push(sv.hu[c] / sv.h[c]);
        vs.push(sv.hv[c] / sv.h[c]);
      });
      let err = 0;
      const ue: number[] = [];
      const ve: number[] = [];
      for (let k = 0; k < ts.length; k++) {
        const eu = u0 * Math.cos(f * ts[k]);
        const ev = -u0 * Math.sin(f * ts[k]);
        ue.push(eu);
        ve.push(ev);
        err = Math.max(err, Math.hypot(us[k] - eu, vs[k] - ev) / u0);
      }
      return {
        metrics: [m('max |V − V解析| / u0（中心）', err, 1e-6)],
        plot: {
          title: '中心点流速分量',
          xLabel: 't (s)',
          yLabel: 'm/s',
          series: [
            { name: 'u 解析', x: ts, y: ue, ref: true },
            { name: 'v 解析', x: ts, y: ve, ref: true },
            { name: 'u 数值', x: ts, y: us },
            { name: 'v 数值', x: ts, y: vs },
          ],
        },
      };
    },
  },
  {
    id: 'geostrophic',
    title: '科氏力 + 外海边界：地转平衡',
    algorithm: '科氏力分裂、外海边界地转倾斜',
    doc: 's7-2',
    description: '100 km × 50 km 平底海峡（水深 50 m，f = 1e-4 s⁻¹，无摩阻），东西为外海边界（东向流 0.5 m/s），初始处于地转平衡 g∂η/∂y = −f u：模拟 1 天后流场应保持不变。',
    run: async () => {
      const nx = 50;
      const ny = 25;
      const dx = 2000;
      const h0 = 50;
      const f = 1e-4;
      const U = 0.5;
      const g = 9.81;
      const Lx = nx * dx;
      const Ly = ny * dx;
      const N = nx * ny;
      const z = new Float64Array(N).fill(-h0);
      const h = new Float64Array(N);
      const hu = new Float64Array(N);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const eta = geostrophicTilt(f, g, U, 0, (i + 0.5) * dx, (j + 0.5) * dx, Lx / 2, Ly / 2);
          h[j * nx + i] = h0 + eta;
          hu[j * nx + i] = (h0 + eta) * U;
        }
      }
      const ocean: BoundarySpec = { type: 'ocean', mean: 0, amplitude: 0, period: 0, phase: 0, u: U, v: 0 };
      const s = solver({ nx, ny, dx, dy: dx }, z, params({ coriolis: f, maxDt: 120, boundaries: { ...walls(), west: ocean, east: ocean } }), h, hu, new Float64Array(N));
      runUntil(s, 86400);
      let du = 0;
      let dv = 0;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const p = s.idx(i, j);
          du = Math.max(du, Math.abs(s.hu[p] / s.h[p] - U));
          dv = Math.max(dv, Math.abs(s.hv[p] / s.h[p]));
        }
      }
      // cross-channel surface slope in the middle column vs -f U / g
      const i = nx / 2;
      const slope = (s.h[s.idx(i, ny - 2)] - s.h[s.idx(i, 1)]) / ((ny - 3) * dx);
      const geo = (-f * U) / g;
      return {
        metrics: [m('max |u − U| / U', du / U, 0.01), m('max |v| / U', dv / U, 0.01), m('|横向水面坡度 / (−fU/g) − 1|', Math.abs(slope / geo - 1), 0.01)],
        detail: `地转坡度 −fU/g = ${geo.toExponential(3)}，数值 ${slope.toExponential(3)}；分裂误差约为 f·Δt/2 量级。`,
      };
    },
  },
  {
    id: 'wind-setup',
    title: '风应力：封闭水域风壅水',
    algorithm: '风应力（Wu 1982 拖曳系数）',
    doc: 's7-3',
    description: '10 km 长、水深 5 m 的封闭水域，西风在 2 h 内增至 20 m/s：稳态水面坡度应满足 g h ∂η/∂x = τ/ρ（取最后两个假潮周期的平均）。',
    run: async () => {
      const nx = 100;
      const ny = 3;
      const dx = 100;
      const h0 = 5;
      const N = nx * ny;
      const wind = { speed: [[0, 0], [7200, 20], [1e9, 20]] as [number, number][], direction: 270, densityRatio: 1.225 / 1000 };
      const s = solver({ nx, ny, dx, dy: dx }, new Float64Array(N).fill(-h0), params({ manning: 0.025, wind }), new Float64Array(N).fill(h0));
      const tEnd = 6 * 3600;
      const seiche = (2 * nx * dx) / Math.sqrt(9.81 * h0);
      const tAvg = tEnd - 2 * seiche;
      const i0 = Math.floor(0.25 * nx);
      const i1 = Math.floor(0.75 * nx);
      let sum = 0;
      let wsum = 0;
      runUntil(s, tEnd, (sv) => {
        if (sv.t <= tAvg) return;
        const sl = (sv.h[sv.idx(i1, 1)] - sv.h[sv.idx(i0, 1)]) / ((i1 - i0) * dx);
        sum += sl * sv.lastDt;
        wsum += sv.lastDt;
      });
      const slope = sum / wsum;
      const [tx] = windStress(wind, tEnd);
      const theory = tx / (9.81 * h0);
      const xs: number[] = [];
      const es: number[] = [];
      const et: number[] = [];
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) * dx;
        xs.push(x);
        es.push(s.h[s.idx(i, 1)] - h0);
        et.push(theory * (x - 0.5 * nx * dx));
      }
      return {
        metrics: [m('|坡度 / 理论坡度 − 1|', Math.abs(slope / theory - 1), 0.03), m('质量相对误差', Math.abs(s.massBalance().error) / s.volume0, 1e-12)],
        detail: `τ/ρ = ${tx.toExponential(3)} m²/s²，理论坡度 ${theory.toExponential(3)}，数值 ${slope.toExponential(3)}，两端水位差约 ${(slope * nx * dx).toFixed(3)} m。`,
        plot: { title: '稳态水面（t = 6 h）', xLabel: 'x (m)', yLabel: 'η (m)', series: [{ name: '线性理论', x: xs, y: et, ref: true }, { name: '数值解', x: xs, y: es }] },
      };
    },
  },
  {
    id: 'ocean-radiation',
    title: '外海边界：无反射出流',
    algorithm: '外海开边界（特征 / Flather 型）',
    doc: 's8-4',
    description: '20 km 长、水深 10 m 的水道中央初始水丘（0.1 m），两端为外海边界（静水、无流）：两列波离开计算域后残余扰动应很小；对照"水位过程"边界会产生明显反射。',
    run: async () => {
      const run = (bc: BoundarySpec): { resid: number; x: number[]; eta: number[] } => {
        const nx = 200;
        const ny = 3;
        const dx = 100;
        const h0 = 10;
        const N = nx * ny;
        const h = new Float64Array(N);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = h0 + 0.1 * Math.exp(-(((i + 0.5) * dx - 10000) ** 2) / (2 * 1000 ** 2));
        const s = solver({ nx, ny, dx, dy: dx }, new Float64Array(N).fill(-h0), params({ boundaries: { ...walls(), west: bc, east: bc } }), h);
        runUntil(s, 2500);
        let r = 0;
        const xs: number[] = [];
        const es: number[] = [];
        for (let i = 0; i < nx; i++) {
          const e = s.h[s.idx(i, 1)] - h0;
          r = Math.max(r, Math.abs(e));
          xs.push((i + 0.5) * dx);
          es.push(e);
        }
        return { resid: r / 0.1, x: xs, eta: es };
      };
      const ocean = run({ type: 'ocean', mean: 0, amplitude: 0, period: 0, phase: 0, u: 0, v: 0 });
      const level = run({ type: 'level', series: [[0, 0]] });
      return {
        metrics: [m('残余 max |η| / 初始振幅（外海边界）', ocean.resid, 0.02)],
        detail: `对照：同一算例使用"水位过程"边界时残余 ${(100 * level.resid).toFixed(1)}%（反射波），外海边界 ${(100 * ocean.resid).toFixed(2)}%。`,
        plot: {
          title: 't = 2500 s 水面扰动（波已离开计算域）',
          xLabel: 'x (m)',
          yLabel: 'η (m)',
          series: [
            { name: '水位过程边界', x: level.x, y: level.eta, ref: true },
            { name: '外海边界', x: ocean.x, y: ocean.eta },
          ],
        },
      };
    },
  },
  {
    id: 'ocean-inflow',
    title: '外海边界：入流与流速保持',
    algorithm: '外海开边界（特征 / Flather 型）',
    doc: 's8-4',
    description: '静止水道两端施加外海流速 0.5 m/s（无摩阻）：两端进入的特征波相遇后全域应为均匀 0.5 m/s、水位不变（"自由出流"边界无法入流）。',
    run: async () => {
      const nx = 100;
      const ny = 3;
      const dx = 100;
      const h0 = 10;
      const N = nx * ny;
      const ocean: BoundarySpec = { type: 'ocean', mean: 0, amplitude: 0, period: 0, phase: 0, u: 0.5, v: 0 };
      const s = solver({ nx, ny, dx, dy: dx }, new Float64Array(N).fill(-h0), params({ boundaries: { ...walls(), west: ocean, east: ocean } }), new Float64Array(N).fill(h0));
      runUntil(s, 3600);
      let du = 0;
      let de = 0;
      for (let i = 0; i < nx; i++) {
        const p = s.idx(i, 1);
        du = Math.max(du, Math.abs(s.hu[p] / s.h[p] - 0.5));
        de = Math.max(de, Math.abs(s.h[p] - h0));
      }
      return { metrics: [m('max |u − 0.5| / 0.5', du / 0.5, 0.02), m('max |Δη|', de, 0.01, 'max', 'm')] };
    },
  },
  {
    id: 'culvert',
    title: '涵洞孔口公式与质量守恒',
    algorithm: '涵洞（孔口公式）连接两个网格',
    doc: 's13',
    description: '两个以墙隔开的水池（水位 3 m / 1 m）由 Φ1 m 涵洞连通：首步流量应等于 Cd·A·√(2gΔH)，最终两侧水位一致且总水量守恒。',
    run: async () => {
      const nx = 20;
      const ny = 10;
      const dx = 10;
      const N = nx * ny;
      const z = new Float64Array(N);
      const h = new Float64Array(N);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          if (i === 10) z[k] = 10; // dividing wall
          else h[k] = i < 10 ? 3 : 1;
        }
      }
      const area = Math.PI * 0.25;
      const a = 5 * nx + 5;
      const b = 5 * nx + 15;
      const s = solver({ nx, ny, dx, dy: dx }, z, params({ manning: 0.03, links: [{ kind: 'culvert', a, b, area, cd: 0.6, series: [] }] }), h);
      const q0 = culvertDischarge(9.81, 1e-6, 0, 3, 0, 1, area, 0.6);
      s.step();
      const qSim = s.linkVolLast[0] / s.lastDt;
      runUntil(s, 36000);
      const la = s.h[s.idx(5, 5)];
      const lb = s.h[s.idx(15, 5)];
      return {
        metrics: [
          m('|Q首步 / (Cd A √(2gΔH)) − 1|', Math.abs(qSim / q0 - 1), 1e-12),
          m('10 h 后两侧水位差', Math.abs(la - lb), 0.01, 'max', 'm'),
          m('质量相对误差', Math.abs(s.massBalance().error) / s.volume0, 1e-12),
        ],
        detail: `孔口公式 Q = ${q0.toFixed(4)} m³/s；最终水位 ${la.toFixed(3)} / ${lb.toFixed(3)} m（体积守恒的平衡水位 ${((10 * 3 + 9 * 1) / 19).toFixed(3)} m）。`,
      };
    },
  },
  {
    id: 'gpu-parity',
    title: 'GPU 引擎一致性（科氏力 + 风 + 外海边界 + 海山）',
    algorithm: 'WebGPU 计算着色器 vs CPU 双精度',
    doc: 's12',
    gpu: true,
    description: '含海山地形、科氏力、风应力、外海边界与初始地转流的小算例，在 GPU（单精度）与 CPU（双精度）上各算 3 h，比较水深、流速与水量。',
    run: async () => {
      const nav = (globalThis as { navigator?: Navigator }).navigator;
      if (!nav?.gpu) return { metrics: [], skipped: true, detail: '当前环境不支持 WebGPU，跳过。' };
      const { GpuEngine } = await import('../gpu/gpuEngine');
      const { CpuEngine } = await import('../worker/engine');
      const nx = 64;
      const ny = 48;
      const dx = 500;
      const f = 8e-5;
      const U = 0.4;
      const N = nx * ny;
      const z = new Float32Array(N);
      const h = new Float32Array(N);
      const hu = new Float32Array(N);
      const hv = new Float32Array(N);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x = (i + 0.5) * dx;
          const y = (j + 0.5) * dx;
          const k = j * nx + i;
          z[k] = -120 + 100 * Math.exp(-((x - 12000) ** 2 + (y - 12000) ** 2) / (2 * 3000 ** 2));
          const eta = geostrophicTilt(f, 9.81, U, 0, x, y, (nx * dx) / 2, (ny * dx) / 2);
          h[k] = Math.max(0, eta - z[k]);
          hu[k] = h[k] * U;
        }
      }
      const ocean: BoundarySpec = { type: 'ocean', mean: 0, amplitude: 0.3, period: 12.42 * 3600, phase: 0, u: U, v: 0 };
      const T = 3 * 3600;
      const metrics: VerifyMetric[] = [];
      const notes: string[] = [];
      let label = '';
      // both orders: the Heun stages carry their own implicit friction (§6.2), first order applies it after the step
      for (const order of [1, 2] as const) {
        const p: SolverParams = {
          ...defaultSolverParams(),
          order,
          cfl: order === 1 ? 0.5 : 0.45,
          manning: 0.025,
          coriolis: f,
          wind: { speed: [[0, 5], [10800, 15]], direction: 225, densityRatio: 1.225 / 1025 },
          boundaries: { ...walls(), west: ocean, east: { type: 'open' } },
        };
        const init = { grid: { nx, ny, dx, dy: dx }, z, h0: h, hu0: hu, hv0: hv, params: p, recordInterval: 600, probes: [], sections: [] };
        const cpu = new CpuEngine(init);
        const gpu = await GpuEngine.create(init);
        label = gpu.label;
        try {
          while (cpu.t < T - 1e-9) await cpu.advance(T, 1e9, false);
          while (gpu.t < T - 1e-9) await gpu.advance(T, 50, false);
          const a = await cpu.fields();
          const b = await gpu.fields();
          let dh = 0;
          let dvel = 0;
          for (let k = 0; k < N; k++) {
            dh = Math.max(dh, Math.abs(a.h[k] - b.h[k]));
            dvel = Math.max(dvel, Math.hypot(a.u[k] - b.u[k], a.v[k] - b.v[k]));
          }
          const sc = cpu.stats();
          const sg = gpu.stats();
          const o = order === 1 ? '一阶' : '二阶';
          metrics.push(
            m(`max |h_GPU − h_CPU|（${o}）`, dh, 0.005, 'max', 'm'),
            m(`max |V_GPU − V_CPU|（${o}）`, dvel, 0.005, 'max', 'm/s'),
            m(`|步数差| / 步数（${o}）`, Math.abs(sc.step - sg.step) / sc.step, 0.01),
            m(`GPU 质量相对误差（${o}）`, Math.abs(sg.massError) / Math.max(sg.volume, sg.volume0), 1e-4),
          );
          notes.push(`${o}：CPU ${sc.step} 步 / GPU ${sg.step} 步`);
        } finally {
          gpu.dispose();
        }
      }
      return { metrics, detail: `${notes.join('；')}；西边界外海流 + 潮汐、东边界自由出流；${label}` };
    },
  },
];

/** Run one case, timing it and applying the thresholds. */
export async function runCase(c: VerifyCase): Promise<VerifyResult> {
  const t0 = performance.now();
  try {
    const r = await c.run();
    const pass = r.skipped ? true : r.metrics.every((x) => (x.kind === 'max' ? x.value <= x.limit : x.value >= x.limit));
    return { id: c.id, pass, ms: performance.now() - t0, ...r };
  } catch (err) {
    return { id: c.id, pass: false, ms: performance.now() - t0, metrics: [], detail: `运行出错：${(err as Error)?.message ?? err}` };
  }
}

import { describe, expect, it } from 'vitest';
import { SWESolver, defaultSolverParams, type SolverParams } from '../src/core/solver';
import { ritter, stoker, thackerPeriod, thackerSurface } from '../src/core/analytic';

function params(over: Partial<SolverParams> = {}): SolverParams {
  return { ...defaultSolverParams(), manning: 0, ...over };
}

function runUntil(s: SWESolver, tEnd: number, onStep?: (s: SWESolver) => void): void {
  let guard = 0;
  while (s.t < tEnd - 1e-12 && guard++ < 1e7) {
    s.step(tEnd - s.t);
    onStep?.(s);
  }
}

function minDepth(s: SWESolver): number {
  let m = Infinity;
  for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) m = Math.min(m, s.h[s.idx(i, j)]);
  return m;
}

describe('well-balanced lake at rest (with islands / wet-dry fronts)', () => {
  for (const order of [1, 2] as const) {
    it(`order ${order}`, () => {
      const nx = 60;
      const ny = 50;
      const dx = 10;
      const z = new Float64Array(nx * ny);
      const h = new Float64Array(nx * ny);
      const eta = 1.0;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x = (i + 0.5) * dx;
          const y = (j + 0.5) * dx;
          const zz =
            0.8 * Math.sin(x / 50) * Math.cos(y / 70) +
            1.6 * Math.exp(-((x - 300) ** 2 + (y - 250) ** 2) / 80 ** 2) -
            0.4 +
            0.3 * Math.sin(i * 1.7 + j * 0.9); // rough, discontinuous-looking bed
          z[j * nx + i] = zz;
          h[j * nx + i] = Math.max(0, eta - zz);
        }
      }
      const s = new SWESolver({ nx, ny, dx, dy: dx }, z, params({ order, manning: 0.03 }));
      s.setState(h);
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
      expect(maxQ).toBeLessThan(1e-10);
      expect(maxDh).toBeLessThan(1e-10);
    });
  }
});

function damBreak1D(order: 1 | 2, h1: number): { l1: number; mass: number } {
  const nx = 400;
  const ny = 3;
  const dx = 1;
  const x0 = 200;
  const h0 = 1;
  const tEnd = 20;
  const z = new Float64Array(nx * ny);
  const h = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = (i + 0.5) * dx < x0 ? h0 : h1;
  const s = new SWESolver(
    { nx, ny, dx, dy: dx },
    z,
    params({ order, cfl: order === 1 ? 0.5 : 0.45, boundaries: { west: { type: 'open' }, east: { type: 'open' }, south: { type: 'wall' }, north: { type: 'wall' } } }),
  );
  s.setState(h);
  runUntil(s, tEnd);
  let err = 0;
  let ref = 0;
  for (let i = 0; i < nx; i++) {
    const x = (i + 0.5) * dx;
    const [he] = h1 > 0 ? stoker(x, s.t, x0, h0, h1) : ritter(x, s.t, x0, h0);
    err += Math.abs(s.h[s.idx(i, 1)] - he);
    ref += he;
  }
  return { l1: err / ref, mass: Math.abs(s.massBalance().error) };
}

describe('1D dam break vs analytical solutions', () => {
  it('Ritter (dry bed), order 1', () => {
    const r = damBreak1D(1, 0);
    expect(r.l1).toBeLessThan(0.03);
    expect(r.mass).toBeLessThan(1e-9);
  });
  it('Ritter (dry bed), order 2', () => {
    const r = damBreak1D(2, 0);
    expect(r.l1).toBeLessThan(0.015);
  });
  it('Stoker (wet bed), order 1', () => {
    const r = damBreak1D(1, 0.1);
    expect(r.l1).toBeLessThan(0.03);
  });
  it('Stoker (wet bed), order 2', () => {
    const r = damBreak1D(2, 0.1);
    expect(r.l1).toBeLessThan(0.015);
  });
});

describe('mass conservation and positivity in a closed basin', () => {
  for (const order of [1, 2] as const) {
    it(`order ${order}`, () => {
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
      const s = new SWESolver({ nx, ny, dx, dy: dx }, z, params({ order, manning: 0.02 }));
      s.setState(h);
      let minH = Infinity;
      for (let k = 0; k < 400; k++) {
        s.step();
        minH = Math.min(minH, minDepth(s));
      }
      const mb = s.massBalance();
      expect(minH).toBeGreaterThanOrEqual(0);
      expect(Math.abs(mb.error) / mb.volume0).toBeLessThan(1e-11);
      expect(mb.clipped / mb.volume0).toBeLessThan(1e-6);
    });
  }
});

describe('mass sources', () => {
  it('uniform rainfall on a closed flat basin', () => {
    const nx = 20;
    const dx = 10;
    const s = new SWESolver({ nx, ny: nx, dx, dy: dx }, new Float64Array(nx * nx), params({
      rainfall: { enabled: true, series: [[0, 36]], stepwise: false, infiltration: 0 },
    }));
    s.setState(new Float64Array(nx * nx));
    runUntil(s, 1000);
    const expected = (36 / 3.6e6) * 1000 * nx * nx * dx * dx;
    expect(s.volume).toBeCloseTo(expected, 6);
    expect(Math.abs(s.massBalance().error)).toBeLessThan(1e-8);
  });

  it('rainfall with infiltration', () => {
    const nx = 10;
    const s = new SWESolver({ nx, ny: nx, dx: 1, dy: 1 }, new Float64Array(nx * nx), params({
      rainfall: { enabled: true, series: [[0, 30]], stepwise: false, infiltration: 10 },
    }));
    s.setState(new Float64Array(nx * nx));
    runUntil(s, 3600);
    expect(s.volume / (nx * nx)).toBeCloseTo(0.02, 6);
    expect(Math.abs(s.massBalance().error)).toBeLessThan(1e-9);
  });

  it('point inflow hydrograph', () => {
    const nx = 30;
    const dx = 10;
    const s = new SWESolver({ nx, ny: nx, dx, dy: dx }, new Float64Array(nx * nx), params({
      sources: [{ x: 150, y: 150, radius: 15, series: [[0, 5], [200, 5], [200.0001, 0]] }],
    }));
    s.setState(new Float64Array(nx * nx));
    runUntil(s, 300);
    expect(s.volume).toBeCloseTo(1000, 0);
    expect(Math.abs(s.massBalance().error)).toBeLessThan(1e-8);
  });
});

describe('boundary conditions', () => {
  it('water level boundary fills a basin to the imposed level', () => {
    const nx = 40;
    const ny = 10;
    const dx = 10;
    const s = new SWESolver({ nx, ny, dx, dy: dx }, new Float64Array(nx * ny), params({
      manning: 0.03,
      boundaries: { west: { type: 'level', series: [[0, 1]] }, east: { type: 'wall' }, south: { type: 'wall' }, north: { type: 'wall' } },
    }));
    s.setState(new Float64Array(nx * ny));
    // the filling excites a lightly damped seiche (T ~ 4L/sqrt(gh) ~ 510 s); it decays towards the imposed level
    runUntil(s, 20000);
    const mean = s.volume / (nx * ny * dx * dx);
    expect(mean).toBeGreaterThan(0.997);
    expect(mean).toBeLessThan(1.003);
    expect(Math.abs(s.massBalance().error)).toBeLessThan(1e-8);
  });

  it('free-outflow boundaries never feed water into the domain', () => {
    // V-shaped valley draining east; rain everywhere; all four boundaries "open"
    const nx = 40;
    const ny = 30;
    const dx = 10;
    const z = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) z[j * nx + i] = 0.05 * Math.abs((j + 0.5) * dx - 150) + 0.01 * (400 - (i + 0.5) * dx);
    }
    const open = { type: 'open' } as const;
    const s = new SWESolver({ nx, ny, dx, dy: dx }, z, params({
      manning: 0.03,
      rainfall: { enabled: true, series: [[0, 50]], stepwise: false, infiltration: 0 },
      boundaries: { west: open, east: open, south: open, north: open },
    }));
    s.setState(new Float64Array(nx * ny));
    runUntil(s, 3600);
    expect(s.bndIn).toBeLessThan(1e-9 * s.rainVol);
    expect(s.bndOut).toBeGreaterThan(0.1 * s.rainVol);
    expect(Math.abs(s.massBalance().error) / s.rainVol).toBeLessThan(1e-10);
  });

  it('rainfall-runoff on an inclined plane reaches equilibrium (open outlet)', () => {
    const nx = 200;
    const ny = 2;
    const dx = 5;
    const dy = 25;
    const L = nx * dx;
    const S0 = 0.01;
    const z = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = S0 * (L - (i + 0.5) * dx);
    const rain = 100; // mm/h
    for (const order of [1, 2] as const) {
      const s = new SWESolver({ nx, ny, dx, dy }, z, params({
        order,
        manning: 0.03,
        rainfall: { enabled: true, series: [[0, rain]], stepwise: false, infiltration: 0 },
        boundaries: { west: { type: 'wall' }, east: { type: 'open' }, south: { type: 'wall' }, north: { type: 'wall' } },
      }));
      s.setState(new Float64Array(nx * ny));
      runUntil(s, 9000);
      const out0 = s.bndOut;
      const t0 = s.t;
      runUntil(s, 10000);
      const qOut = (s.bndOut - out0) / (s.t - t0);
      const qRain = (rain / 3.6e6) * L * ny * dy;
      // depth at mid-plane vs kinematic-wave equilibrium h(x) = (i x n / sqrt(S))^(3/5)
      const iMid = nx / 2;
      const xMid = (iMid + 0.5) * dx;
      const hMid = s.h[s.idx(iMid, 0)];
      const hKin = Math.pow(((rain / 3.6e6) * xMid * 0.03) / Math.sqrt(S0), 0.6);
      // eslint-disable-next-line no-console
      console.log(`inclined plane order ${order}: Qout/Qrain=${(qOut / qRain).toFixed(4)} hMid=${hMid.toFixed(4)} kinematic=${hKin.toFixed(4)}`);
      expect(Math.abs(qOut / qRain - 1)).toBeLessThan(0.02);
      expect(Math.abs(s.massBalance().error) / s.rainVol).toBeLessThan(1e-9);
      // thin sheet flow (h < bed step per cell) on a coarse grid: within ~25% of the kinematic solution
      expect(hMid / hKin).toBeGreaterThan(0.75);
      expect(hMid / hKin).toBeLessThan(1.25);
    }
  });
});

describe('Thacker planar surface in a paraboloid (wet/dry oscillation)', () => {
  it('order 2 tracks the analytical free surface after one period', () => {
    const D0 = 1;
    const a = 1000;
    const eta0 = 0.5 * 1000; // horizontal excursion of the shoreline (m), = a/2
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
    const s = new SWESolver({ nx: n, ny: n, dx, dy: dx }, z, params({ order: 2, cfl: 0.45, maxDt: 50 }));
    s.setState(h);
    const T = thackerPeriod(D0, a);
    runUntil(s, T);
    // compare along the centre line inside the always-wet core
    let err = 0;
    let cnt = 0;
    const j = n / 2;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * dx - L / 2;
      if (Math.abs(x) > 0.5 * a) continue;
      const y = (j + 0.5) * dx - L / 2;
      const zb = -D0 * (1 - (x * x + y * y) / (a * a));
      const he = Math.max(0, thackerSurface(x, s.t, D0, a, eta0) - zb);
      err += Math.abs(s.h[s.idx(i, j)] - he);
      cnt++;
    }
    const meanErr = err / cnt;
    // eslint-disable-next-line no-console
    console.log(`Thacker mean |dh| after one period: ${meanErr.toFixed(4)} m (D0=${D0} m)`);
    expect(meanErr).toBeLessThan(0.05);
  });
});

describe('performance smoke test', () => {
  it('256x256 first-order steps', () => {
    const n = 256;
    const dx = 10;
    const z = new Float64Array(n * n);
    const h = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        z[j * n + i] = 0.002 * i + Math.sin(j / 10);
        h[j * n + i] = i < n / 3 ? 3 : 0.0;
      }
    }
    for (const order of [1, 2] as const) {
      const s = new SWESolver({ nx: n, ny: n, dx, dy: dx }, z, params({ order, manning: 0.03 }));
      s.setState(h);
      for (let k = 0; k < 5; k++) s.step();
      const t0 = performance.now();
      const steps = 40;
      for (let k = 0; k < steps; k++) s.step();
      const ms = (performance.now() - t0) / steps;
      // eslint-disable-next-line no-console
      console.log(`256x256 order ${order}: ${ms.toFixed(2)} ms/step`);
      expect(ms).toBeLessThan(200);
    }
  });
});

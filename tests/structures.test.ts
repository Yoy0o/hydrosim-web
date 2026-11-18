import { describe, expect, it } from 'vitest';
import { SWESolver, defaultSolverParams, type SolverParams } from '../src/core/solver';
import { polygonCells, rasterizeLine, rasterizeRings } from '../src/core/raster';

const params = (over: Partial<SolverParams> = {}): SolverParams => ({ ...defaultSolverParams(), manning: 0.03, ...over });

function runUntil(s: SWESolver, tEnd: number): void {
  let guard = 0;
  while (s.t < tEnd - 1e-9 && guard++ < 1e6) s.step(tEnd - s.t);
}

/** Total water volume in cells selected by a predicate. */
function volumeWhere(s: SWESolver, pred: (i: number, j: number) => boolean): number {
  let v = 0;
  for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) if (pred(i, j)) v += s.h[s.idx(i, j)];
  return v * s.dx * s.dy;
}

describe('rasterisation', () => {
  const g = { nx: 50, ny: 40, dx: 2, dy: 2 };

  it('lines are 4-connected (no corner leaks)', () => {
    const cells = new Set(rasterizeLine(g, [[1, 1], [97, 79], [10, 70]]));
    const start = 0 * g.nx + 0;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const c = queue.pop()!;
      const i = c % g.nx;
      const j = (c - i) / g.nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = (j + dj) * g.nx + (i + di);
        if (i + di >= 0 && i + di < g.nx && j + dj >= 0 && j + dj < g.ny && cells.has(n) && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect(seen.size).toBe(cells.size);
  });

  it('wide lines include every cell centre within half the width', () => {
    const cells = rasterizeLine(g, [[10, 40], [90, 40]], 10);
    const rows = new Set(cells.map((c) => Math.floor(c / g.nx)));
    expect([...rows].sort((a, b) => a - b)).toEqual([17, 18, 19, 20, 21, 22]);
  });

  it('polygon coverage counts sub-samples and respects holes', () => {
    const counts = new Uint8Array(g.nx * g.ny);
    const outer: [number, number][] = [[10, 10], [50, 10], [50, 50], [10, 50]];
    const hole: [number, number][] = [[20, 20], [40, 20], [40, 40], [20, 40]];
    rasterizeRings(g, [outer, hole], 4, (c) => counts[c]++);
    let full = 0;
    for (const v of counts) if (v === 16) full++;
    // 40x40 m square minus 20x20 m hole = 1200 m^2 = 300 cells of 4 m^2
    expect(full).toBe(300);
    expect(counts[15 * g.nx + 15]).toBe(0); // inside the hole
    expect(polygonCells(g, outer).length).toBe(400);
  });
});

describe('static and dynamic structure lines', () => {
  const nx = 40;
  const ny = 40;
  const dx = 5;
  const setup = (): { z: Float64Array; h: Float64Array; line: number[] } => {
    const z = new Float64Array(nx * ny);
    const h = new Float64Array(nx * ny);
    const line = rasterizeLine({ nx, ny, dx, dy: dx }, [[0, 0], [nx * dx, ny * dx]]);
    const onLine = new Set(line);
    for (const c of line) z[c] = 2;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (j > i && !onLine.has(j * nx + i)) h[j * nx + i] = 1;
    return { z, h, line };
  };

  it('a diagonal levee keeps the protected side dry', () => {
    const { z, h, line } = setup();
    const s = new SWESolver({ nx, ny, dx, dy: dx }, z, params());
    s.setState(h);
    runUntil(s, 1500);
    const onLine = new Set(line);
    const leaked = volumeWhere(s, (i, j) => j < i && !onLine.has(j * nx + i));
    expect(leaked).toBeLessThan(1e-9);
    expect(Math.abs(s.massBalance().error)).toBeLessThan(1e-8);
  });

  it('a breach lowers the crest over time and lets water through', () => {
    const { z, h, line } = setup();
    const zGround = line.map(() => 2); // the levee is part of the bed; the breach erodes it to 0
    const s = new SWESolver({ nx, ny, dx, dy: dx }, z, params({ lines: [{ cells: line, zGround, series: [[0, 2], [100, 2], [200, 0]], mode: 'lower' }] }));
    s.setState(h);
    runUntil(s, 99);
    const onLine = new Set(line);
    const before = volumeWhere(s, (i, j) => j < i && !onLine.has(j * nx + i));
    runUntil(s, 3000);
    const after = volumeWhere(s, (i, j) => j < i && !onLine.has(j * nx + i));
    const total = s.volume;
    expect(before).toBeLessThan(1e-9);
    expect(after).toBeGreaterThan(0.35 * total);
    expect(Math.abs(s.massBalance().error) / total).toBeLessThan(1e-10);
  });
});

describe('culverts and pumps', () => {
  // two basins separated by a high wall column at i = 20
  const nx = 41;
  const ny = 10;
  const dx = 5;
  const mk = (): { z: Float64Array; h: Float64Array } => {
    const z = new Float64Array(nx * ny);
    const h = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      z[j * nx + 20] = 5;
      for (let i = 0; i < 20; i++) h[j * nx + i] = 1;
    }
    return { z, h };
  };
  const leftVol = (s: SWESolver): number => volumeWhere(s, (i) => i < 20);
  const rightVol = (s: SWESolver): number => volumeWhere(s, (i) => i > 20);

  it('a culvert equalises the two levels and conserves mass', () => {
    const { z, h } = mk();
    const s = new SWESolver({ nx, ny, dx, dy: dx }, z, params({
      links: [{ kind: 'culvert', a: 5 * nx + 15, b: 5 * nx + 25, area: Math.PI * 0.25 * 0.25, cd: 0.6, series: [] }],
    }));
    s.setState(h);
    const v0 = leftVol(s);
    runUntil(s, 600);
    expect(rightVol(s)).toBeGreaterThan(0); // flowed from high to low
    expect(s.linkVolLast[0]).toBeGreaterThanOrEqual(0);
    runUntil(s, 40000);
    const l = leftVol(s);
    const r = rightVol(s);
    expect(Math.abs(l - r) / v0).toBeLessThan(0.02);
    expect(Math.abs(s.massBalance().error) / v0).toBeLessThan(1e-10);
  });

  it('a pump moves exactly the pumped volume', () => {
    const { z, h } = mk();
    const s = new SWESolver({ nx, ny, dx, dy: dx }, z, params({
      links: [{ kind: 'pump', a: 5 * nx + 15, b: 5 * nx + 25, area: 0, cd: 0, series: [[0, 2], [100, 2], [100.001, 0]] }],
    }));
    s.setState(h);
    runUntil(s, 400);
    // 2 m3/s for 100 s plus the 1 ms linear ramp-down
    expect(rightVol(s)).toBeCloseTo(200.001, 6);
  });
});

describe('spatially varying roughness', () => {
  const nx = 200;
  const ny = 3;
  const dx = 1;
  const z = new Float64Array(nx * ny);
  const h = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = i < 50 ? 1 : 0.0;
  const bc = { west: { type: 'wall' }, east: { type: 'open' }, south: { type: 'wall' }, north: { type: 'wall' } } as SolverParams['boundaries'];

  it('a uniform field reproduces the scalar Manning coefficient exactly', () => {
    const a = new SWESolver({ nx, ny, dx, dy: dx }, z, params({ manning: 0.04, boundaries: bc }));
    const b = new SWESolver({ nx, ny, dx, dy: dx }, z, params({ manning: 0.01, manningField: new Float32Array(nx * ny).fill(0.04), boundaries: bc }));
    a.setState(h);
    b.setState(h);
    runUntil(a, 20);
    runUntil(b, 20);
    let maxd = 0;
    for (let k = 0; k < a.h.length; k++) maxd = Math.max(maxd, Math.abs(a.h[k] - b.h[k]));
    expect(maxd).toBeLessThan(1e-6);
  });

  it('a rough zone slows the advancing front', () => {
    const front = (field: Float32Array | null): number => {
      const s = new SWESolver({ nx, ny, dx, dy: dx }, z, params({ manning: 0.02, manningField: field, boundaries: bc }));
      s.setState(h);
      runUntil(s, 25);
      let f = 0;
      for (let i = 0; i < nx; i++) if (s.h[s.idx(i, 1)] > 0.01) f = i;
      return f;
    };
    const rough = new Float32Array(nx * ny).fill(0.02);
    for (let j = 0; j < ny; j++) for (let i = 60; i < nx; i++) rough[j * nx + i] = 0.15;
    expect(front(rough)).toBeLessThan(front(null) - 10);
  });
});

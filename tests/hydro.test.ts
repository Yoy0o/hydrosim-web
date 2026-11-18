import { describe, expect, it } from 'vitest';
import { fillDepressions } from '../src/core/hydro';
import { initialDepth, sectionCells } from '../src/core/geometry';
import { parseAsc, writeAsc } from '../src/data/asciigrid';
import { integrateSeries, sampleSeries } from '../src/core/timeseries';
import { rainSeriesFromHourly } from '../src/data/openmeteo';

describe('depression filling (Priority-Flood)', () => {
  const nx = 20;
  const ny = 10;
  // plane sloping down towards the east with a 3 m deep pit and a 2 m "dam" across the slope
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let v = 0.5 * (nx - i);
      if (i === 5 && j === 5) v -= 3;
      if (i === 12) v += 2;
      z[j * nx + i] = v;
    }
  }
  it('fills pits and dams so every cell drains to the outlet', () => {
    const r = fillDepressions(z, nx, ny, 1, Infinity, 1e-4, { west: false, east: true, south: false, north: false });
    // every cell drains to the east edge: rows are non-ascending up to the epsilon gradients of filled flats
    for (let j = 0; j < ny; j++) {
      for (let i = 1; i < nx; i++) expect(r.z[j * nx + i]).toBeLessThanOrEqual(r.z[j * nx + i - 1] + 2e-3);
    }
    // the 3 m pit (z = 4.5) spills over its eastern neighbour (z = 7.0)
    expect(r.z[5 * nx + 5]).toBeGreaterThanOrEqual(7.0);
    expect(r.z[5 * nx + 5]).toBeLessThan(7.01);
    expect(r.filledCells).toBeGreaterThan(0);
  });
  it('respects the maximum fill depth', () => {
    const r = fillDepressions(z, nx, ny, 1, 1, 1e-4, { west: false, east: true, south: false, north: false });
    for (let k = 0; k < z.length; k++) expect(r.z[k] - z[k]).toBeLessThanOrEqual(1 + 1e-6);
    expect(r.maxFill).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe('geometry helpers', () => {
  it('initial depth from base level and polygon', () => {
    const g = { nx: 10, ny: 10, dx: 1, dy: 1, z: new Float32Array(100).map((_, k) => k % 10) };
    const h = initialDepth(g, 2, [{ polygon: [[0, 0], [5, 0], [5, 10], [0, 10]], level: 6 }]);
    expect(h[0]).toBeCloseTo(6); // inside polygon, z=0
    expect(h[7]).toBeCloseTo(0); // outside, z=7 > base level 2
    expect(h[9 * 10 + 1]).toBeCloseTo(5);
    expect(h[8]).toBeCloseTo(0);
    expect(h[5 * 10 + 6]).toBeCloseTo(0);
    expect(h[5 * 10 + 1]).toBeCloseTo(5);
  });
  it('section cells cover the line length', () => {
    const s = sectionCells({ nx: 50, ny: 50, dx: 2, dy: 2 }, 10, 10, 70, 50);
    const sum = s.weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(Math.hypot(60, 40), 6);
    expect(Math.hypot(s.nx, s.ny)).toBeCloseTo(1, 9);
  });
});

describe('ESRI ASCII grid', () => {
  it('round-trips through write/parse (south-first arrays)', () => {
    const v = new Float32Array([1, 2, 3, 4, 5, 6]);
    const txt = writeAsc(3, 2, 10, 100, 200, v, (x) => x !== 5);
    const g = parseAsc(txt);
    expect(g.ncols).toBe(3);
    expect(g.nrows).toBe(2);
    expect(g.xll).toBe(100);
    expect(g.cellsize).toBe(10);
    expect(Array.from(g.data)).toEqual([1, 2, 3, 4, -9999, 6]);
  });
});

describe('time series', () => {
  it('stepwise integration of hourly rainfall', () => {
    const r = rainSeriesFromHourly(
      { latitude: 0, longitude: 0, time: ['2021-07-14T00:00', '2021-07-14T01:00', '2021-07-14T02:00', '2021-07-14T03:00'], precipitation: [9, 2, 4, 1] },
      '2021-07-14T00:00:00Z',
    );
    // record at 01:00 covers [0,1h) with 2 mm, 02:00 -> 4 mm, 03:00 -> 1 mm
    expect(sampleSeries(r, 1800, true)).toBe(2);
    expect(integrateSeries(r, 0, 3 * 3600, true) / 3600).toBeCloseTo(7, 9);
    expect(integrateSeries(r, 0, 10 * 3600, true) / 3600).toBeCloseTo(7, 9);
  });
});

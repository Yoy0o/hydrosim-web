import { describe, expect, it } from 'vitest';
import { cellOf } from '../src/core/raster';
import { lineBed } from '../src/core/solver';
import { sampleSeries } from '../src/core/timeseries';
import { LANDCOVER_INDEX, buildModelInputs, buildingRasterFromPolygons, ensureScenarioDefaults, structureSeries, type LandCoverRaster } from '../src/model';
import type { Scenario, StructureLine, Terrain } from '../src/types';

const nx = 40;
const ny = 30;
const dx = 10;
const g = { nx, ny, dx, dy: dx };

function flatTerrain(z0 = 100): Terrain {
  return { name: 'flat', nx, ny, dx, dy: dx, z: new Float32Array(nx * ny).fill(z0), georef: { kind: 'local' }, source: 'synthetic' };
}

function scenario(over: Partial<Scenario> = {}): Scenario {
  return ensureScenarioDefaults({
    name: 't',
    description: '',
    manning: 0.04,
    boundaries: { west: { type: 'wall' }, east: { type: 'wall' }, south: { type: 'wall' }, north: { type: 'wall' } },
    initial: { baseLevel: null, regions: [] },
    sources: [],
    rainfall: { enabled: false, series: [[0, 0]], stepwise: false, infiltration: 0 },
    simulation: { duration: 3600, cfl: 0.5, order: 1, outputInterval: 60, maxDt: 10, hDry: 1e-6, arrivalDepth: 0.05 },
    probes: [],
    sections: [],
    ...over,
  });
}

const square = (x0: number, y0: number, s: number): [number, number][] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

describe('model inputs', () => {
  it('without zones, land cover or buildings the Manning field stays uniform (null)', () => {
    const m = buildModelInputs(flatTerrain(), scenario(), { buildings: null, landcover: null });
    expect(m.manning).toBeNull();
    expect(m.lines).toHaveLength(0);
    expect(Array.from(m.bed).every((v) => v === 100)).toBe(true);
  });

  it('building rasters count covered sub-samples and keep the tallest height', () => {
    const b = buildingRasterFromPolygons(g, [{ polygon: square(100, 100, 20), height: 12 }, { polygon: square(105, 105, 10), height: 30 }], 'test');
    expect(b.count).toBe(2);
    expect(b.cover[cellOf(g, 105, 105)]).toBe(16); // fully covered cell
    expect(b.cover[cellOf(g, 125, 105)]).toBe(0);
    expect(b.height[cellOf(g, 112, 112)]).toBe(30);
    expect(b.height[cellOf(g, 102, 102)]).toBe(30); // cell (10,10) is partly covered by the tall block
  });

  it('block mode raises cells covered at least half; resistance mode blends n by coverage', () => {
    const t = flatTerrain();
    // 15 m x 10 m footprint: cell (10,10) fully covered, cell (11,10) half covered, cell (12,10) not
    const items = [{ id: 'b', polygon: [[100, 100], [115, 100], [115, 110], [100, 110]] as [number, number][], height: 6 }];
    const sb = scenario({ buildings: { mode: 'block', defaultHeight: 10, n: 0.3, useOsm: false, items } });
    const mb = buildModelInputs(t, sb, { buildings: null, landcover: null });
    expect(mb.bed[cellOf(g, 105, 105)]).toBe(106);
    expect(mb.bed[cellOf(g, 112, 105)]).toBe(106); // 8/16 covered -> blocked
    expect(mb.bed[cellOf(g, 125, 105)]).toBe(100);
    expect(mb.buildingCells).toBe(2);
    const sr = scenario({ buildings: { mode: 'resistance', defaultHeight: 10, n: 0.3, useOsm: false, items } });
    const mr = buildModelInputs(t, sr, { buildings: null, landcover: null });
    expect(mr.bed[cellOf(g, 105, 105)]).toBe(100);
    expect(mr.manning![cellOf(g, 105, 105)]).toBeCloseTo(0.3, 6);
    expect(mr.manning![cellOf(g, 112, 105)]).toBeCloseTo(0.5 * 0.04 + 0.5 * 0.3, 6);
    expect(mr.manning![cellOf(g, 125, 105)]).toBeCloseTo(0.04, 6);
  });

  it('roughness priority: zone > land cover > base value', () => {
    const lc: LandCoverRaster = { cls: new Uint8Array(nx * ny), source: 'test' };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx / 2; i++) lc.cls[j * nx + i] = LANDCOVER_INDEX.wood;
    const sc = scenario();
    sc.roughness!.table.wood = 0.12;
    sc.roughness!.zones.push({ id: 'z', name: 'z', polygon: square(0, 0, 100), n: 0.02 });
    const m = buildModelInputs(flatTerrain(), sc, { buildings: null, landcover: lc });
    expect(m.manning![cellOf(g, 55, 55)]).toBeCloseTo(0.02, 6); // inside the zone (and the wood)
    expect(m.manning![cellOf(g, 150, 250)]).toBeCloseTo(0.12, 6); // wood
    expect(m.manning![cellOf(g, 350, 250)]).toBeCloseTo(0.04, 6); // no class -> base
    sc.roughness!.useLandcover = false;
    const m2 = buildModelInputs(flatTerrain(), sc, { buildings: null, landcover: lc });
    expect(m2.manning![cellOf(g, 150, 250)]).toBeCloseTo(0.04, 6);
  });

  it('levees raise, weirs set; gates and breaches become dynamic lines', () => {
    const t = flatTerrain();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) t.z[j * nx + i] = 100 + (i === 20 ? 3 : 0); // a DEM levee at column 20
    const line = (id: string, kind: StructureLine['kind'], x: number, extra: Partial<StructureLine> = {}): StructureLine => ({
      id,
      name: id,
      kind,
      points: [[x, 5], [x, 295]],
      crest: 102,
      width: 0,
      ...extra,
    });
    const sc = scenario({
      structures: [
        line('levee', 'levee', 55),
        line('weir', 'weir', 105, { crest: 99.5 }),
        line('gate', 'gate', 155, { crest: 104, bottom: 99, t1: 600, ramp: 60, t2: 1800 }),
        line('breach', 'breach', 205, { crest: 103, bottom: 98, t1: 300, ramp: 120 }),
      ],
    });
    const m = buildModelInputs(t, sc, { buildings: null, landcover: null });
    expect(m.bed[cellOf(g, 55, 100)]).toBe(102);
    expect(m.bed[cellOf(g, 105, 100)]).toBe(99.5);
    expect(m.lines).toHaveLength(2);
    const gate = m.lines.find((L) => L.mode === 'set')!;
    const breach = m.lines.find((L) => L.mode === 'lower')!;
    // closed gate at t = 0, open (sill) after the ramp, closed again after t2 + ramp
    expect(m.bed[cellOf(g, 155, 100)]).toBe(104);
    expect(sampleSeries(gate.series, 700)).toBe(99);
    expect(sampleSeries(gate.series, 1900)).toBe(104);
    // breach erodes the DEM levee (zGround 103 at column 20) only once its crest drops below it
    const c = cellOf(g, 205, 100);
    const k = breach.cells.indexOf(c);
    expect(breach.zGround[k]).toBe(103);
    expect(m.bed[c]).toBe(103);
    expect(lineBed('lower', breach.zGround[k], sampleSeries(breach.series, 300 + 60))).toBeCloseTo(100.5, 6);
    expect(lineBed('lower', breach.zGround[k], sampleSeries(breach.series, 1000))).toBe(98);
  });

  it('structure series defaults the bottom to the lowest ground along the line', () => {
    const s: StructureLine = { id: 'b', name: 'b', kind: 'breach', points: [], crest: 10, width: 0, t1: 0, ramp: 100 };
    expect(structureSeries(s, 4)).toEqual([[0, 10], [100, 4]]);
    const gate: StructureLine = { id: 'g', name: 'g', kind: 'gate', points: [], crest: 10, width: 0, t1: 0 };
    expect(structureSeries(gate, 3)).toEqual([[0, 3]]); // t1 = 0: open from the start
  });

  it('links convert diameter and barrels to an area', () => {
    const sc = scenario({ links: [{ id: 'l', name: 'c', kind: 'culvert', x1: 15, y1: 15, x2: 385, y2: 285, diameter: 2, count: 3, cd: 0.6, series: [[0, 0]] }] });
    const m = buildModelInputs(flatTerrain(), sc, { buildings: null, landcover: null });
    expect(m.links[0].area).toBeCloseTo(3 * Math.PI, 9);
    expect(m.links[0].a).toBe(cellOf(g, 15, 15));
    expect(m.links[0].b).toBe(cellOf(g, 385, 285));
  });
});

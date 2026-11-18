/**
 * Dev page (gpu-test.html): validates the WebGPU engine against the double-precision CPU engine and the
 * analytical solutions, and benchmarks both. Results are written to the page and to window.__gpuTest.
 */
import { defaultSolverParams, type SolverParams } from '../core/solver';
import { initialDepth, sectionCells } from '../core/geometry';
import { ritter } from '../core/analytic';
import { PRESETS } from '../data/presets';
import { CpuEngine, type Engine, type EngineInit } from '../worker/engine';
import type { Scenario, Terrain } from '../types';

// loaded dynamically (as in the worker) so the engine stays a separate chunk
const { GpuEngine } = await import('../gpu/gpuEngine');
const out = document.getElementById('out') as HTMLPreElement;
const results: Record<string, unknown>[] = [];
(window as unknown as { __gpuTest: unknown }).__gpuTest = { results, done: false };

function log(s: string): void {
  out.textContent += s + '\n';
}

function paramsFrom(sc: Scenario): SolverParams {
  return {
    ...defaultSolverParams(),
    cfl: sc.simulation.cfl,
    order: sc.simulation.order,
    hDry: sc.simulation.hDry,
    maxDt: sc.simulation.maxDt,
    manning: sc.manning,
    boundaries: structuredClone(sc.boundaries),
    sources: sc.sources.map((q) => ({ x: q.x, y: q.y, radius: q.radius, series: q.series })),
    rainfall: sc.rainfall.enabled ? { ...sc.rainfall } : null,
    arrivalDepth: sc.simulation.arrivalDepth,
  };
}

function initFor(t: Terrain, sc: Scenario, h0: Float32Array, params: SolverParams): EngineInit {
  const probes = sc.probes.map((p) => {
    const i = Math.min(t.nx - 1, Math.max(0, Math.floor(p.x / t.dx)));
    const j = Math.min(t.ny - 1, Math.max(0, Math.floor(p.y / t.dy)));
    return { id: p.id, cell: j * t.nx + i };
  });
  const sections = sc.sections.map((q) => {
    const s = sectionCells(t, q.x1, q.y1, q.x2, q.y2);
    return { id: q.id, cells: s.cells, weights: s.weights, nx: s.nx, ny: s.ny };
  });
  return { grid: { nx: t.nx, ny: t.ny, dx: t.dx, dy: t.dy }, z: t.z, h0, params, recordInterval: sc.simulation.duration / 200, probes, sections };
}

async function runTo(e: Engine, T: number): Promise<number> {
  const t0 = performance.now();
  let guard = 0;
  while (e.t < T - 1e-9 && guard++ < 1e6) await e.advance(T, 40, false);
  return performance.now() - t0;
}

function compare(a: Float32Array, b: Float32Array, thr = 0.01): { maxDiff: number; meanDiff: number; wetA: number; wetB: number; wetMismatch: number } {
  let maxDiff = 0;
  let sum = 0;
  let wetA = 0;
  let wetB = 0;
  let mism = 0;
  for (let k = 0; k < a.length; k++) {
    const d = Math.abs(a[k] - b[k]);
    if (d > maxDiff) maxDiff = d;
    sum += d;
    const wa = a[k] >= thr;
    const wb = b[k] >= thr;
    if (wa) wetA++;
    if (wb) wetB++;
    if (wa !== wb) mism++;
  }
  return { maxDiff, meanDiff: sum / a.length, wetA, wetB, wetMismatch: mism };
}

async function presetCase(id: string, T: number, overrides: Partial<SolverParams> = {}): Promise<void> {
  const p = PRESETS.find((x) => x.id === id)!;
  const c = await p.load();
  const t = c.terrain;
  const sc = c.scenario;
  const h0 = c.initialDepth ?? initialDepth(t, sc.initial.baseLevel, sc.initial.regions);
  const params = { ...paramsFrom(sc), ...overrides };
  const cpu = new CpuEngine(initFor(t, sc, h0, params));
  const gpu = await GpuEngine.create(initFor(t, sc, h0, params));
  const msC = await runTo(cpu, T);
  const msG = await runTo(gpu, T);
  const fc = await cpu.fields();
  const fg = await gpu.fields();
  const cmp = compare(fc.h, fg.h);
  const sc1 = cpu.stats();
  const sg = gpu.stats();
  const relErrG = Math.abs(sg.massError) / Math.max(sg.volume, sg.volume0, sg.rain + sg.inflow + sg.boundaryIn);
  const relErrC = Math.abs(sc1.massError) / Math.max(sc1.volume, sc1.volume0, sc1.rain + sc1.inflow + sc1.boundaryIn);
  const hmax = Math.max(...Array.from(fc.h));
  const r = {
    case: `${id} (order ${params.order}, ${t.nx}x${t.ny}, T=${T}s)`,
    stepsCpu: sc1.step,
    stepsGpu: sg.step,
    msCpu: Math.round(msC),
    msGpu: Math.round(msG),
    speedup: +(msC / Math.max(1, msG)).toFixed(1),
    maxDiff: +cmp.maxDiff.toFixed(4),
    meanDiff: +cmp.meanDiff.toExponential(2),
    hmax: +hmax.toFixed(3),
    wetCpu: cmp.wetA,
    wetGpu: cmp.wetB,
    wetMismatch: cmp.wetMismatch,
    volCpu: Math.round(sc1.volume),
    volGpu: Math.round(sg.volume),
    massRelErrCpu: +relErrC.toExponential(1),
    massRelErrGpu: +relErrG.toExponential(1),
    bInGpu: Math.round(sg.boundaryIn),
    bOutCpu: Math.round(sc1.boundaryOut),
    bOutGpu: Math.round(sg.boundaryOut),
  };
  results.push(r);
  log(JSON.stringify(r));
  gpu.dispose();
}

async function lakeAtRest(order: 1 | 2): Promise<void> {
  const nx = 60;
  const ny = 50;
  const dx = 10;
  const z = new Float32Array(nx * ny);
  const h = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx;
      const y = (j + 0.5) * dx;
      const zz = 0.8 * Math.sin(x / 50) * Math.cos(y / 70) + 1.6 * Math.exp(-((x - 300) ** 2 + (y - 250) ** 2) / 6400) - 0.4 + 0.3 * Math.sin(i * 1.7 + j * 0.9) + 1000;
      z[j * nx + i] = zz;
      h[j * nx + i] = Math.max(0, 1001 - zz);
    }
  }
  const params: SolverParams = { ...defaultSolverParams(), order, manning: 0.03 };
  const gpu = await GpuEngine.create({ grid: { nx, ny, dx, dy: dx }, z, h0: h, params, recordInterval: 1e9, probes: [], sections: [] });
  for (let k = 0; k < 30; k++) await gpu.advance(Infinity, 50, false, 10);
  const f = await gpu.fields();
  let maxV = 0;
  let maxDh = 0;
  for (let k = 0; k < h.length; k++) {
    maxV = Math.max(maxV, Math.abs(f.u[k]), Math.abs(f.v[k]));
    maxDh = Math.max(maxDh, Math.abs(f.h[k] - h[k]));
  }
  const r = { case: `lake at rest, bed at +1000 m (order ${order})`, steps: gpu.stepCount, maxVelocity: +maxV.toExponential(2), maxDepthChange: +maxDh.toExponential(2) };
  results.push(r);
  log(JSON.stringify(r));
  gpu.dispose();
}

async function ritterCase(order: 1 | 2): Promise<void> {
  const nx = 400;
  const ny = 3;
  const dx = 1;
  const x0 = 200;
  const z = new Float32Array(nx * ny);
  const h = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = (i + 0.5) * dx < x0 ? 1 : 0;
  const params: SolverParams = {
    ...defaultSolverParams(),
    order,
    manning: 0,
    cfl: order === 1 ? 0.5 : 0.45,
    boundaries: { west: { type: 'open' }, east: { type: 'open' }, south: { type: 'wall' }, north: { type: 'wall' } },
  };
  const gpu = await GpuEngine.create({ grid: { nx, ny, dx, dy: dx }, z, h0: h, params, recordInterval: 1e9, probes: [], sections: [] });
  await runTo(gpu, 20);
  const f = await gpu.fields();
  let err = 0;
  let ref = 0;
  for (let i = 0; i < nx; i++) {
    const [he] = ritter((i + 0.5) * dx, gpu.t, x0, 1);
    err += Math.abs(f.h[nx + i] - he);
    ref += he;
  }
  const r = { case: `Ritter dam break GPU (order ${order})`, t: gpu.t, L1: +(err / ref).toFixed(4), massRelErr: +(Math.abs(gpu.stats().massError) / gpu.stats().volume0).toExponential(1) };
  results.push(r);
  log(JSON.stringify(r));
  gpu.dispose();
}

async function bench(n: number, order: 1 | 2, withCpu: boolean): Promise<void> {
  const dx = 10;
  const z = new Float32Array(n * n);
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      z[j * n + i] = 0.002 * i + Math.sin(j / 10);
      h[j * n + i] = i < n / 3 ? 3 : 0;
    }
  }
  const params: SolverParams = { ...defaultSolverParams(), order, manning: 0.03 };
  const init: EngineInit = { grid: { nx: n, ny: n, dx, dy: dx }, z, h0: h, params, recordInterval: 1e9, probes: [], sections: [] };
  const gpu = await GpuEngine.create(init);
  for (let k = 0; k < 5; k++) await gpu.advance(Infinity, 30, false); // warm-up / batch sizing
  const s0 = gpu.stepCount;
  const t0 = performance.now();
  while (performance.now() - t0 < 2500) await gpu.advance(Infinity, 30, false);
  const gpuSps = ((gpu.stepCount - s0) * 1000) / (performance.now() - t0);
  gpu.dispose();
  let cpuSps = NaN;
  if (withCpu) {
    const cpu = new CpuEngine(init);
    await cpu.advance(Infinity, 300, false);
    const c0 = cpu.stepCount;
    const t1 = performance.now();
    while (performance.now() - t1 < 2500) await cpu.advance(Infinity, 200, false);
    cpuSps = ((cpu.stepCount - c0) * 1000) / (performance.now() - t1);
  }
  const r = { case: `benchmark ${n}x${n} order ${order}`, gpuStepsPerSec: Math.round(gpuSps), cpuStepsPerSec: Math.round(cpuSps), speedup: +(gpuSps / cpuSps).toFixed(1), gpuMsPerStep: +(1000 / gpuSps).toFixed(3) };
  results.push(r);
  log(JSON.stringify(r));
}

async function main(): Promise<void> {
  const which = new URLSearchParams(location.search).get('run') ?? 'all';
  try {
    if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
    if (which === 'all' || which === 'basic') {
      await lakeAtRest(1);
      await lakeAtRest(2);
      await ritterCase(1);
      await ritterCase(2);
    }
    if (which === 'all' || which === 'parity') {
      await presetCase('partial-dam-break', 7.2);
      await presetCase('three-humps', 20);
      await presetCase('thacker', 300);
      await presetCase('river-valley', 3600);
      await presetCase('coastal-surge', 3600);
      await presetCase('malpasset', 1200);
      await presetCase('ahr-2021', 4 * 3600);
    }
    if (which === 'all' || which === 'bench') {
      await bench(256, 1, true);
      await bench(256, 2, true);
      await bench(512, 1, true);
      await bench(1024, 1, false);
      await bench(1024, 2, false);
    }
  } catch (err) {
    log(`ERROR: ${(err as Error).stack ?? err}`);
    results.push({ error: String((err as Error).message ?? err) });
  }
  (window as unknown as { __gpuTest: { done: boolean } }).__gpuTest.done = true;
  log('DONE');
}

void main();

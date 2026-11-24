/**
 * WGSL compute kernels of the WebGPU shallow-water engine.
 *
 * The scheme is a line-by-line port of src/core/solver.ts (HLL + Chen–Noelle hydrostatic reconstruction,
 * optional MUSCL/Heun, implicit Manning friction, ghost-cell boundaries, sources). Differences are only
 * numerical (f32): beds inside the reconstruction are taken relative to the left cell (differences of
 * neighbouring elevations are exact in f32), so thin films stay accurate on high-elevation terrain.
 *
 * Time stepping is fully GPU-resident: interface kernels reduce the maximum wave speed with atomics, a
 * one-thread "scalar" kernel computes dt, source integrals and boundary levels, and records are written
 * to a ring buffer through indirect dispatches. The CPU only encodes batches and reads results back.
 * Kernel-by-kernel mapping to the CPU solver: docs/ALGORITHMS.md §12.
 */

export const COMMON = /* wgsl */ `
struct Params {
  nx: u32, ny: u32, NX: u32, N: u32,
  nXI: u32, nYI: u32, nCells: u32, nBnd: u32,
  dx: f32, dy: f32, g: f32, cfl: f32,
  maxDt: f32, hDry: f32, n2g: f32, vcap: f32,
  arrDepth: f32, tBase: f32, tStopRel: f32, recInterval: f32,
  infRate: f32, rainOn: u32, cellArea: f32, nLinks: u32,
  bcType: vec4<u32>,
  stepsInBatch: u32, nProbes: u32, nSections: u32, recFloats: u32,
  nSources: u32, forceLast: u32, statsGroups: u32, nLines: u32,
  fcor: f32, windOn: u32, windDirX: f32, windDirY: f32,
  bcVelA: vec4<f32>,
  bcVelB: vec4<f32>,
  rhoRatio: f32, windMinH: f32, padA: f32, padB: f32,
}

struct Ctrl {
  maxAx: atomic<u32>,
  maxAy: atomic<u32>,
  stepIdx: u32,
  stepsDone: u32,
  recCount: u32,
  recFlag: u32,
  halted: u32,
  pad0: u32,
  dt: f32,
  tRel: f32,
  nextRecRel: f32,
  rainDepth: f32,
  infDepth: f32,
  rainAcc: f32,
  inflowAcc: f32,
  pad1: f32,
  levels: vec4<f32>,
  srcVol: array<f32, 64>,
  linkVol: array<f32, 16>,
  lineCrest: array<f32, 16>,
  wind: vec4<f32>,
}
`;

/** Byte size / offsets of Ctrl (must match the WGSL struct). */
export const CTRL_BYTES = 480;
export const CTRL_LEVELS_OFFSET = 64;
export const CTRL_LINECREST_OFFSET = 400;
export const MAX_LINKS = 16;
export const MAX_LINES = 16;
export const PARAMS_BYTES = 208;
export const MAX_SOURCES = 64;
export const REC_HEADER = 16;

/** Ghost cells for the four boundaries (one thread per boundary cell). */
export const BC = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> U: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> C: Ctrl;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  let nx = P.nx;
  let ny = P.ny;
  let NX = P.NX;
  if (k >= 2u * (nx + ny)) { return; }
  var side = 0u;
  var p0 = 0u;
  var p1 = 0u;
  var g1 = 0u;
  var g2 = 0u;
  var axisX = true;
  var sgn = 1.0;
  if (k < ny) {
    side = 0u; p0 = (k + 2u) * NX + 2u; p1 = p0 + 1u; g1 = p0 - 1u; g2 = p0 - 2u; sgn = -1.0;
  } else if (k < 2u * ny) {
    side = 1u; let j = k - ny; p0 = (j + 2u) * NX + nx + 1u; p1 = p0 - 1u; g1 = p0 + 1u; g2 = p0 + 2u; sgn = 1.0;
  } else if (k < 2u * ny + nx) {
    side = 2u; let i = k - 2u * ny; p0 = 2u * NX + i + 2u; p1 = select(p0 + NX, p0, ny == 1u); g1 = p0 - NX; g2 = p0 - 2u * NX; axisX = false; sgn = -1.0;
  } else {
    side = 3u; let i = k - 2u * ny - nx; p0 = (ny + 1u) * NX + i + 2u; p1 = select(p0 - NX, p0, ny == 1u); g1 = p0 + NX; g2 = p0 + 2u * NX; axisX = false; sgn = 1.0;
  }
  let a = U[p0];
  let b = U[p1];
  let cfg = P.bcType[side];
  // bed ghosts: walls mirror the bed, level/tide/open-sea boundaries copy the boundary cell, free outflow
  // continues a downhill bed (normal-depth assumption; a flat continuation acts as a pool at the outlet)
  var z1 = a.w;
  var z2 = select(a.w, b.w, cfg == 0u);
  if (cfg == 1u && p1 != p0) {
    let drop = max(0.0, b.w - a.w);
    z1 = a.w - drop;
    z2 = a.w - 2.0 * drop;
  }
  var code = cfg;
  // free outflow is outflow-only: reflective while the boundary cell flows inwards
  let qn = select(a.z, a.y, axisX);
  if (code == 1u && sgn * qn < 0.0) { code = 0u; }
  if (code == 0u) {
    var ga = a;
    var gb = b;
    if (axisX) { ga.y = -ga.y; gb.y = -gb.y; } else { ga.z = -ga.z; gb.z = -gb.z; }
    U[g1] = vec4<f32>(ga.xyz, z1);
    U[g2] = vec4<f32>(gb.xyz, z2);
    return;
  }
  if (code == 1u) {
    U[g1] = vec4<f32>(a.xyz, z1);
    U[g2] = vec4<f32>(a.xyz, z2);
    return;
  }
  if (code == 3u) {
    // open sea: far-field state (external level + geostrophic tilt, external current) of the boundary Riemann problem
    var vel = P.bcVelA.xy;
    if (side == 1u) { vel = P.bcVelA.zw; } else if (side == 2u) { vel = P.bcVelB.xy; } else if (side == 3u) { vel = P.bcVelB.zw; }
    let Lx = f32(nx) * P.dx;
    let Ly = f32(ny) * P.dy;
    var bx = 0.0;
    var by = 0.0;
    if (side == 0u) { by = (f32(k) + 0.5) * P.dy; }
    else if (side == 1u) { bx = Lx; by = (f32(k - ny) + 0.5) * P.dy; }
    else if (side == 2u) { bx = (f32(k - 2u * ny) + 0.5) * P.dx; }
    else { bx = (f32(k - 2u * ny - nx) + 0.5) * P.dx; by = Ly; }
    var lvl = C.levels[side];
    if (P.fcor != 0.0) { lvl = lvl + (P.fcor / P.g) * (vel.y * (bx - 0.5 * Lx) - vel.x * (by - 0.5 * Ly)); }
    var ho = lvl - z1;
    if (!(ho > P.hDry)) { ho = 0.0; }
    U[g1] = vec4<f32>(ho, ho * vel, z1);
    U[g2] = vec4<f32>(ho, ho * vel, z2);
    return;
  }
  // water level boundary: far-field reservoir, velocity extrapolated when the interior is wet
  let level = C.levels[side];
  var hb = level - z1;
  if (!(hb > 0.0)) { hb = 0.0; }
  if (hb <= P.hDry) {
    U[g1] = vec4<f32>(0.0, 0.0, 0.0, z1);
    U[g2] = vec4<f32>(0.0, 0.0, 0.0, z2);
    return;
  }
  var q = vec2<f32>(0.0, 0.0);
  if (a.x > P.hDry) { q = a.yz * (hb / a.x); }
  U[g1] = vec4<f32>(hb, q, z1);
  U[g2] = vec4<f32>(hb, q, z2);
}
`;

/** MUSCL half-slopes (minmod) of (eta, h, u, v): x-slopes at [0,N), y-slopes at [N,2N). */
export const SLOPES = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> U: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> SL: array<vec4<f32>>;

fn velh(s: vec4<f32>) -> vec2<f32> {
  if (s.x > P.hDry) { return s.yz / s.x; }
  return vec2<f32>(0.0, 0.0);
}
fn mmh(a: f32, b: f32) -> f32 {
  if (a > 0.0 && b > 0.0) { return 0.5 * min(a, b); }
  if (a < 0.0 && b < 0.0) { return 0.5 * max(a, b); }
  return 0.0;
}
fn slope(m: vec4<f32>, c: vec4<f32>, p: vec4<f32>) -> vec4<f32> {
  if (c.x <= P.hDry || m.x <= P.hDry || p.x <= P.hDry) { return vec4<f32>(0.0); }
  let um = velh(m);
  let uc = velh(c);
  let up = velh(p);
  return vec4<f32>(
    mmh((c.x - m.x) + (c.w - m.w), (p.x - c.x) + (p.w - c.w)),
    mmh(c.x - m.x, p.x - c.x),
    mmh(uc.x - um.x, up.x - uc.x),
    mmh(uc.y - um.y, up.y - uc.y));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  if (p >= P.N) { return; }
  let NX = P.NX;
  let i = i32(p % NX) - 2;
  let j = i32(p / NX) - 2;
  let nx = i32(P.nx);
  let ny = i32(P.ny);
  let c = U[p];
  if (j >= 0 && j < ny && i >= -1 && i <= nx) { SL[p] = slope(U[p - 1u], c, U[p + 1u]); }
  if (i >= 0 && i < nx && j >= -1 && j <= ny) { SL[P.N + p] = slope(U[p - NX], c, U[p + NX]); }
}
`;

/**
 * Interface fluxes (x interfaces at [0,nXI), y interfaces at [nXI, nXI+nYI)).
 * F = (mass, normal momentum, tangential momentum, |wave speed|), R = (h*L, h*R, z* relative to left bed, 0).
 */
export const FLUX = /* wgsl */ `
${COMMON}
override ORDER: u32 = 1u;
override TRACK: bool = true;
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> U: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> SL: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> F: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> R: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> C: Ctrl;

var<workgroup> smx: array<f32, 256>;
var<workgroup> smy: array<f32, 256>;

fn velh(s: vec4<f32>) -> vec2<f32> {
  if (s.x > P.hDry) { return s.yz / s.x; }
  return vec2<f32>(0.0, 0.0);
}

fn hll(hl: f32, hr: f32, unL: f32, utL: f32, unR: f32, utR: f32) -> vec4<f32> {
  let g = P.g;
  let cL = sqrt(g * hl);
  let cR = sqrt(g * hr);
  var sL: f32;
  var sR: f32;
  if (hl <= 0.0) {
    sL = unR - 2.0 * cR; sR = unR + cR;
  } else if (hr <= 0.0) {
    sL = unL - cL; sR = unL + 2.0 * cL;
  } else {
    let us = 0.5 * (unL + unR) + cL - cR;
    let cs = 0.5 * (cL + cR) + 0.25 * (unL - unR);
    sL = min(unL - cL, us - cs);
    sR = max(unR + cR, us + cs);
  }
  let qL = hl * unL;
  let qR = hr * unR;
  let hg = 0.5 * g;
  var f0: f32;
  var f1: f32;
  if (sL >= 0.0) {
    f0 = qL; f1 = qL * unL + hg * hl * hl;
  } else if (sR <= 0.0) {
    f0 = qR; f1 = qR * unR + hg * hr * hr;
  } else {
    let inv = 1.0 / (sR - sL);
    let ss = sL * sR;
    f0 = (sR * qL - sL * qR + ss * (hr - hl)) * inv;
    f1 = (sR * (qL * unL + hg * hl * hl) - sL * (qR * unR + hg * hr * hr) + ss * (qR - qL)) * inv;
  }
  let f2 = select(f0 * utR, f0 * utL, f0 >= 0.0);
  return vec4<f32>(f0, f1, f2, max(-sL, sR));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let k = gid.x;
  var sx = 0.0;
  var sy = 0.0;
  if (k < P.nXI + P.nYI) {
    var p: u32;
    var q: u32;
    var isX = true;
    if (k < P.nXI) {
      let row = k / (P.nx + 1u);
      let col = k % (P.nx + 1u);
      p = (row + 2u) * P.NX + col + 1u;
      q = p + 1u;
    } else {
      let kk = k - P.nXI;
      let row = kk / P.nx;
      let col = kk % P.nx;
      p = (row + 1u) * P.NX + col + 2u;
      q = p + P.NX;
      isX = false;
    }
    let a = U[p];
    let b = U[q];
    let va = velh(a);
    let vb = velh(b);
    var hL = a.x;
    var hR = b.x;
    var unL = select(va.y, va.x, isX);
    var utL = select(va.x, va.y, isX);
    var unR = select(vb.y, vb.x, isX);
    var utR = select(vb.x, vb.y, isX);
    // beds relative to the left cell
    var zLr = 0.0;
    var zRr = b.w - a.w;
    var wLr = hL;
    var wRr = zRr + hR;
    if (ORDER == 2u) {
      let off = select(P.N, 0u, isX);
      let sa = SL[off + p];
      let sb = SL[off + q];
      hL = a.x + sa.y;
      wLr = a.x + sa.x;
      zLr = wLr - hL;
      hR = b.x - sb.y;
      wRr = (b.w - a.w) + b.x - sb.x;
      zRr = wRr - hR;
      if (isX) {
        unL = unL + sa.z; utL = utL + sa.w; unR = unR - sb.z; utR = utR - sb.w;
      } else {
        unL = unL + sa.w; utL = utL + sa.z; unR = unR - sb.w; utR = utR - sb.z;
      }
    }
    // Chen–Noelle hydrostatic reconstruction
    var zs = max(zLr, zRr);
    let wmin = min(wLr, wRr);
    if (zs > wmin) { zs = wmin; }
    let hl = max(min(wLr - zs, hL), 0.0);
    let hr = max(min(wRr - zs, hR), 0.0);
    R[k] = vec4<f32>(hl, hr, zs, 0.0);
    var f = vec4<f32>(0.0);
    if (hl > 0.0 || hr > 0.0) { f = hll(hl, hr, unL, utL, unR, utR); }
    F[k] = f;
    if (isX) { sx = f.w; } else { sy = f.w; }
  }
  if (TRACK) {
    smx[li] = sx;
    smy[li] = sy;
    workgroupBarrier();
    for (var s = 128u; s > 0u; s = s >> 1u) {
      if (li < s) {
        smx[li] = max(smx[li], smx[li + s]);
        smy[li] = max(smy[li], smy[li + s]);
      }
      workgroupBarrier();
    }
    if (li == 0u) {
      if (smx[0] > 0.0) { atomicMax(&C.maxAx, bitcast<u32>(smx[0])); }
      if (smy[0] > 0.0) { atomicMax(&C.maxAy, bitcast<u32>(smy[0])); }
    }
  }
}
`;

/** One-thread kernel: time step, source integrals, boundary levels, record events, indirect args. */
export const SCALAR = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> C: Ctrl;
@group(0) @binding(2) var<storage, read> SER: array<f32>;
@group(0) @binding(3) var<storage, read_write> DTH: array<f32>;
@group(0) @binding(4) var<storage, read_write> IND: array<u32>;
@group(0) @binding(5) var<storage, read> U: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> SRCP: array<vec4<f32>>;

fn refOff(r: u32) -> u32 { return u32(SER[1u + 4u * r]); }
fn refN(r: u32) -> u32 { return u32(SER[2u + 4u * r]); }
fn refMode(r: u32) -> u32 { return u32(SER[3u + 4u * r]); }
fn sT(off: u32, k: u32) -> f32 { return SER[off + 2u * k]; }
fn sV(off: u32, k: u32) -> f32 { return SER[off + 2u * k + 1u]; }

fn sampleRef(r: u32, t: f32) -> f32 {
  let n = refN(r);
  let off = refOff(r);
  let mode = refMode(r);
  if (mode == 2u) {
    // sinusoidal tide: mean, amplitude, period, phase (deg)
    return SER[off] + SER[off + 1u] * sin(6.283185307179586 * t / SER[off + 2u] + SER[off + 3u] * 0.017453292519943295);
  }
  if (n == 0u) { return 0.0; }
  let stepwise = mode == 1u;
  if (t <= sT(off, 0u)) {
    if (stepwise && t < sT(off, 0u)) { return 0.0; }
    return sV(off, 0u);
  }
  if (t >= sT(off, n - 1u)) { return sV(off, n - 1u); }
  var lo = 0u;
  var hi = n - 1u;
  loop {
    if (hi - lo <= 1u) { break; }
    let mid = (lo + hi) / 2u;
    if (sT(off, mid) <= t) { lo = mid; } else { hi = mid; }
  }
  if (stepwise) { return sV(off, lo); }
  let t0 = sT(off, lo);
  let t1 = sT(off, hi);
  if (t1 > t0) { return sV(off, lo) + (sV(off, hi) - sV(off, lo)) * (t - t0) / (t1 - t0); }
  return sV(off, hi);
}

fn integrateRef(r: u32, a: f32, b: f32) -> f32 {
  let n = refN(r);
  let off = refOff(r);
  let mode = refMode(r);
  if (b <= a || n == 0u || mode == 2u) { return 0.0; }
  var lo = 0u;
  var hi = n;
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi) / 2u;
    if (sT(off, mid) <= a) { lo = mid + 1u; } else { hi = mid; }
  }
  var k = lo;
  var ta = a;
  var sum = 0.0;
  for (var it = 0u; it < n + 2u; it = it + 1u) {
    var tb = b;
    if (k < n && sT(off, k) < b) { tb = sT(off, k); }
    if (mode == 1u) {
      sum = sum + sampleRef(r, ta) * (tb - ta);
    } else {
      sum = sum + 0.5 * (sampleRef(r, ta) + sampleRef(r, tb)) * (tb - ta);
    }
    if (tb >= b) { break; }
    ta = tb;
    k = k + 1u;
  }
  return sum;
}

@compute @workgroup_size(1)
fn main() {
  let ax = bitcast<f32>(atomicLoad(&C.maxAx));
  let ay = bitcast<f32>(atomicLoad(&C.maxAy));
  atomicStore(&C.maxAx, 0u);
  atomicStore(&C.maxAy, 0u);
  var dt = P.maxDt;
  if (ax > 0.0) { dt = min(dt, P.cfl * P.dx / ax); }
  if (ay > 0.0) { dt = min(dt, P.cfl * P.dy / ay); }
  var halted = 0u;
  let remain = P.tStopRel - C.tRel;
  if (remain <= 1e-6 * max(1.0, abs(P.tStopRel))) {
    dt = 0.0;
    halted = 1u;
  } else if (dt > remain) {
    dt = remain;
  }
  if (!(dt > 0.0)) { dt = 0.0; halted = 1u; }
  let t0 = P.tBase + C.tRel;
  let t1 = t0 + dt;
  var rain = 0.0;
  var inf = 0.0;
  if (P.rainOn != 0u && dt > 0.0) {
    rain = max(0.0, integrateRef(0u, t0, t1)) / 3.6e6;
    inf = P.infRate * dt;
  }
  C.rainDepth = rain;
  C.infDepth = inf;
  C.rainAcc = C.rainAcc + rain * P.cellArea * f32(P.nCells);
  var inflow = 0.0;
  for (var s = 0u; s < P.nSources; s = s + 1u) {
    var v = 0.0;
    if (dt > 0.0) { v = max(0.0, integrateRef(5u + s, t0, t1)); }
    C.srcVol[s] = v;
    inflow = inflow + v;
  }
  C.inflowAcc = C.inflowAcc + inflow;
  // culverts (orifice, start-of-step heads) and pumps (series); at most 90 % of the source cell's water
  for (var k = 0u; k < P.nLinks; k = k + 1u) {
    let la = SRCP[2u * P.nSources + 2u * k];
    let lb = SRCP[2u * P.nSources + 2u * k + 1u];
    let ua = U[u32(la.z)];
    let ub = U[u32(la.w)];
    var v = 0.0;
    if (dt > 0.0) {
      if (lb.x > 0.5) {
        v = max(0.0, integrateRef(5u + P.nSources + k, t0, t1));
      } else {
        let dH = (ua.w + ua.x) - (ub.w + ub.x);
        var Q = 0.0;
        if (dH > 0.0 && ua.x > P.hDry) { Q = lb.z * lb.y * sqrt(2.0 * P.g * dH); }
        else if (dH < 0.0 && ub.x > P.hDry) { Q = -lb.z * lb.y * sqrt(-2.0 * P.g * dH); }
        v = Q * dt;
      }
      if (v > 0.0) { v = min(v, 0.9 * ua.x * P.cellArea); } else if (v < 0.0) { v = max(v, -0.9 * ub.x * P.cellArea); }
    }
    C.linkVol[k] = v;
  }
  // gate / breach crests at the end of the step (applied by the zline kernel at the next step start)
  for (var l = 0u; l < P.nLines; l = l + 1u) {
    C.lineCrest[l] = sampleRef(5u + P.nSources + P.nLinks + l, t1);
  }
  var lv = C.levels;
  for (var sd = 0u; sd < 4u; sd = sd + 1u) {
    if (P.bcType[sd] >= 2u) { lv[sd] = sampleRef(1u + sd, t1); }
  }
  C.levels = lv;
  // kinematic wind stress (Wu 1982 drag, capped) at mid-step; series ref after the lines
  var wnd = vec4<f32>(0.0);
  if (P.windOn != 0u && dt > 0.0) {
    let W = max(0.0, sampleRef(5u + P.nSources + P.nLinks + P.nLines, t0 + 0.5 * dt));
    let cd = min(2.5e-3, (0.8 + 0.065 * W) * 1e-3);
    let sw = P.rhoRatio * cd * W * W;
    wnd = vec4<f32>(sw * P.windDirX, sw * P.windDirY, W, cd);
  }
  C.wind = wnd;
  C.dt = dt;
  C.halted = halted;
  let tr = C.tRel + dt;
  C.tRel = tr;
  DTH[C.stepIdx] = dt;
  var flag = 0u;
  if (dt > 0.0 && tr >= C.nextRecRel - 1e-6 * max(1.0, abs(tr))) {
    flag = 1u;
    var nr = C.nextRecRel;
    for (var it = 0u; it < 64u; it = it + 1u) {
      nr = nr + P.recInterval;
      if (nr > tr) { break; }
    }
    C.nextRecRel = nr;
  }
  if (P.forceLast != 0u && C.stepIdx + 1u == P.stepsInBatch) { flag = flag | 2u; }
  C.recFlag = flag;
  IND[0] = select(0u, P.statsGroups, flag != 0u);
  IND[1] = 1u;
  IND[2] = 1u;
  IND[4] = select(0u, 1u, flag != 0u);
  IND[5] = 1u;
  IND[6] = 1u;
  C.stepIdx = C.stepIdx + 1u;
  if (dt > 0.0) { C.stepsDone = C.stepsDone + 1u; }
}
`;

/** Volume exchanged through the domain boundary during the step (per boundary interface). */
export const BFLUX = /* wgsl */ `
${COMMON}
override HALF: bool = false;
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> F: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> C: Ctrl;
@group(0) @binding(3) var<storage, read_write> BACC: array<vec2<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  let nx = P.nx;
  let ny = P.ny;
  if (k >= 2u * (nx + ny)) { return; }
  var f = 0.0;
  var inPositive = true;
  var len = P.dy;
  if (k < ny) {
    f = F[k * (nx + 1u)].x;
  } else if (k < 2u * ny) {
    f = F[(k - ny) * (nx + 1u) + nx].x; inPositive = false;
  } else if (k < 2u * ny + nx) {
    f = F[P.nXI + (k - 2u * ny)].x; len = P.dx;
  } else {
    f = F[P.nXI + ny * nx + (k - 2u * ny - nx)].x; inPositive = false; len = P.dx;
  }
  var dt = C.dt;
  if (HALF) { dt = 0.5 * dt; }
  let v = f * len * dt;
  let vin = select(-v, v, inPositive);
  var a = BACC[k];
  if (vin > 0.0) { a.x = a.x + vin; } else { a.y = a.y - vin; }
  BACC[k] = a;
}
`;

/**
 * Conservative update. STAGE 0: first-order full step; 1: Heun stage 1 (U += dt L); 2: Heun stage 2
 * (U = (U0 + U + dt L)/2). Final stages add point sources, links, rain, infiltration, wind stress, implicit
 * friction, velocity cap, Coriolis rotation, clipping accounting and the result envelopes.
 */
export const UPDATE = /* wgsl */ `
${COMMON}
override STAGE: u32 = 0u;
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> U: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> U0: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> F: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> R: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> C: Ctrl;
@group(0) @binding(6) var<storage, read_write> ENV: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> ACC: array<vec2<f32>>;
@group(0) @binding(8) var<storage, read> SRCP: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read> NMAN: array<f32>;

/** Implicit Manning friction over dt on a provisional state: momentum scale factor (1 = none). */
fn frictionScale(hh: f32, qx: f32, qy: f32, c: u32, dt: f32) -> f32 {
  if (!(hh > P.hDry)) { return 1.0; }
  let q = sqrt(qx * qx + qy * qy);
  if (!(q > 0.0)) { return 1.0; }
  let nm = NMAN[c];
  let n2g = P.g * nm * nm;
  if (!(n2g > 0.0)) { return 1.0; }
  let a = dt * n2g / (hh * hh * pow(hh, 1.0 / 3.0));
  return 2.0 / (1.0 + sqrt(1.0 + 4.0 * a * q));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= P.nCells) { return; }
  let nx = P.nx;
  let NX = P.NX;
  let i = c % nx;
  let j = c / nx;
  let p = (j + 2u) * NX + i + 2u;
  let kx = j * (nx + 1u) + i;
  let ky = P.nXI + j * nx + i;
  let Fl = F[kx];
  let Fr = F[kx + 1u];
  let Fb = F[ky];
  let Ft = F[ky + nx];
  let Rl = R[kx];
  let Rr = R[kx + 1u];
  let Rb = R[ky];
  let Rt = R[ky + nx];
  let u = U[p];
  let dzx = u.w - U[p - 1u].w;
  let dzy = u.w - U[p - NX].w;
  let rdx = 1.0 / P.dx;
  let rdy = 1.0 / P.dy;
  let hg = 0.5 * P.g;
  let dt = C.dt;
  let dh = -(Fr.x - Fl.x) * rdx - (Ft.x - Fb.x) * rdy;
  // sub-cell bed source: dz* across the cell = z*_right - z*_left (beds stored relative to left cells)
  let sbx = -hg * (Rr.x + Rl.y) * (Rr.z - Rl.z + dzx) * rdx;
  let sby = -hg * (Rt.x + Rb.y) * (Rt.z - Rb.z + dzy) * rdy;
  let dqx = -(Fr.y - Fl.y) * rdx - (Ft.z - Fb.z) * rdy + sbx;
  let dqy = -(Fr.z - Fl.z) * rdx - (Ft.y - Fb.y) * rdy + sby;
  var hn: f32;
  var qx: f32;
  var qy: f32;
  // Heun stages apply the implicit friction inside each stage (IMEX SSP-RK2, exact for uniform flow)
  if (STAGE == 2u) {
    let o = U0[p];
    let wh = u.x + dt * dh;
    var wx = u.y + dt * dqx;
    var wy = u.z + dt * dqy;
    let rf = frictionScale(wh, wx, wy, c, dt);
    wx = wx * rf;
    wy = wy * rf;
    hn = 0.5 * (o.x + wh);
    qx = 0.5 * (o.y + wx);
    qy = 0.5 * (o.z + wy);
  } else {
    hn = u.x + dt * dh;
    qx = u.y + dt * dqx;
    qy = u.z + dt * dqy;
    if (STAGE == 1u) {
      let rf = frictionScale(hn, qx, qy, c, dt);
      qx = qx * rf;
      qy = qy * rf;
    }
  }
  var acc = ACC[c];
  if (hn < 0.0) {
    acc.y = acc.y - hn;
    hn = 0.0; qx = 0.0; qy = 0.0;
  }
  if (STAGE == 1u) {
    U[p] = vec4<f32>(hn, qx, qy, u.w);
    ACC[c] = acc;
    return;
  }
  // point sources (cells whose centre lies in the source disk, or the fallback cell)
  let x = (f32(i) + 0.5) * P.dx;
  let y = (f32(j) + 0.5) * P.dy;
  for (var s = 0u; s < P.nSources; s = s + 1u) {
    let sa = SRCP[2u * s];
    let sb = SRCP[2u * s + 1u];
    let ddx = x - sa.x;
    let ddy = y - sa.y;
    var inside = ddx * ddx + ddy * ddy <= sa.z;
    if (sb.y > 0.5) { inside = c == u32(sb.x); }
    if (inside) { hn = hn + C.srcVol[s] * sa.w; }
  }
  // culverts / pumps: move the volume decided by the scalar kernel
  for (var k = 0u; k < P.nLinks; k = k + 1u) {
    let v = C.linkVol[k];
    if (v == 0.0) { continue; }
    let la = SRCP[2u * P.nSources + 2u * k];
    let a = u32(la.x);
    let b = u32(la.y);
    let fromC = select(b, a, v > 0.0);
    let toC = select(a, b, v > 0.0);
    let dhl = abs(v) / P.cellArea;
    if (c == fromC) {
      if (hn > 0.0) {
        let r = max(0.0, hn - dhl) / hn;
        qx = qx * r; qy = qy * r;
      }
      hn = hn - dhl;
    }
    if (c == toC) { hn = hn + dhl; }
  }
  hn = hn + C.rainDepth;
  let infD = C.infDepth;
  if (infD > 0.0 && hn > 0.0) {
    let loss = min(hn, infD);
    let r = (hn - loss) / hn;
    qx = qx * r; qy = qy * r;
    hn = hn - loss;
    acc.x = acc.x + loss;
  }
  if (hn <= P.hDry) {
    qx = 0.0; qy = 0.0;
    if (hn < 0.0) { acc.y = acc.y - hn; hn = 0.0; }
  } else {
    if (P.windOn != 0u && hn > P.windMinH) {
      qx = qx + dt * C.wind.x;
      qy = qy + dt * C.wind.y;
    }
    var q = sqrt(qx * qx + qy * qy);
    if (q > 0.0) {
      let nm = NMAN[c];
      let n2g = P.g * nm * nm;
      if (STAGE == 0u && n2g > 0.0) {
        let a = dt * n2g / (hn * hn * pow(hn, 1.0 / 3.0));
        let qn = 2.0 * q / (1.0 + sqrt(1.0 + 4.0 * a * q));
        let r = qn / q;
        qx = qx * r; qy = qy * r; q = qn;
      }
      if (P.vcap > 0.0 && q > P.vcap * hn) {
        let r = P.vcap * hn / q;
        qx = qx * r; qy = qy * r; q = P.vcap * hn;
      }
      if (P.fcor != 0.0) {
        // Coriolis: clockwise rotation by f dt (northern hemisphere); renormalised because cos(f dt)
        // rounds to 1 in f32 and the bare rotation would slowly inflate |q|
        let th = P.fcor * dt;
        let cs = cos(th);
        let sn = sin(th);
        let rx = cs * qx + sn * qy;
        let ry = cs * qy - sn * qx;
        let m = sqrt(rx * rx + ry * ry);
        if (m > 0.0) { qx = rx * (q / m); qy = ry * (q / m); }
      }
    }
    var e = ENV[c];
    if (hn > e.x) { e.x = hn; }
    if (hn >= P.arrDepth) {
      let spd = q / hn;
      if (spd > e.y) { e.y = spd; }
      let haz = hn * (spd + 0.5);
      if (haz > e.z) { e.z = haz; }
      if (e.w < 0.0) { e.w = P.tBase + C.tRel; }
    }
    ENV[c] = e;
  }
  U[p] = vec4<f32>(hn, qx, qy, u.w);
  ACC[c] = acc;
}
`;

/** Per-workgroup partial sums: (sum h, sum infiltration depth, sum clip depth, wet cells), (max h, max speed). */
export const STATS = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> U: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> ACC: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> PART: array<vec4<f32>>;

var<workgroup> s1: array<vec4<f32>, 256>;
var<workgroup> s2: array<vec2<f32>, 256>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wid: vec3<u32>) {
  let c = gid.x;
  var a = vec4<f32>(0.0);
  var m = vec2<f32>(0.0, 0.0);
  if (c < P.nCells) {
    let i = c % P.nx;
    let j = c / P.nx;
    let u = U[(j + 2u) * P.NX + i + 2u];
    let acc = ACC[c];
    a = vec4<f32>(u.x, acc.x, acc.y, 0.0);
    if (u.x > P.hDry) { m.x = u.x; }
    if (u.x >= P.arrDepth) {
      a.w = 1.0;
      m.y = sqrt(u.y * u.y + u.z * u.z) / u.x;
    }
  }
  s1[li] = a;
  s2[li] = m;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (li < s) {
      s1[li] = s1[li] + s1[li + s];
      s2[li] = max(s2[li], s2[li + s]);
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    PART[2u * wid.x] = s1[0];
    PART[2u * wid.x + 1u] = vec4<f32>(s2[0], 0.0, 0.0);
  }
}
`;

/** Assemble one record (global sums, boundary volumes, probes, sections) into the ring buffer. */
export const FINALIZE = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> U: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> C: Ctrl;
@group(0) @binding(3) var<storage, read> PART: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> BACC: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read> OBS: array<f32>;
@group(0) @binding(6) var<storage, read_write> REC: array<f32>;

var<workgroup> r1: array<vec4<f32>, 256>;
var<workgroup> r2: array<vec4<f32>, 256>;
var<workgroup> wslot: u32;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  if (li == 0u) { wslot = C.recCount; }
  var a = vec4<f32>(0.0);
  var b = vec4<f32>(0.0);
  for (var k = li; k < P.statsGroups; k = k + 256u) {
    a = a + PART[2u * k];
    let m = PART[2u * k + 1u];
    b.x = max(b.x, m.x);
    b.y = max(b.y, m.y);
  }
  let nb = 2u * (P.nx + P.ny);
  for (var k = li; k < nb; k = k + 256u) {
    let v = BACC[k];
    b.z = b.z + v.x;
    b.w = b.w + v.y;
  }
  r1[li] = a;
  r2[li] = b;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (li < s) {
      r1[li] = r1[li] + r1[li + s];
      let o = r2[li + s];
      let q = r2[li];
      r2[li] = vec4<f32>(max(q.x, o.x), max(q.y, o.y), q.z + o.z, q.w + o.w);
    }
    workgroupBarrier();
  }
  let base = wslot * P.recFloats;
  let hd = max(P.hDry, 1e-5);
  for (var q = li; q < P.nProbes; q = q + 256u) {
    let u = U[u32(OBS[q])];
    var spd = 0.0;
    if (u.x > hd) { spd = sqrt(u.y * u.y + u.z * u.z) / u.x; }
    REC[base + 16u + 3u * q] = u.x;
    REC[base + 17u + 3u * q] = u.w + u.x;
    REC[base + 18u + 3u * q] = spd;
  }
  for (var q = li; q < P.nSections; q = q + 256u) {
    let h0 = P.nProbes + 4u * q;
    let off = u32(OBS[h0]);
    let cnt = u32(OBS[h0 + 1u]);
    let nxs = OBS[h0 + 2u];
    let nys = OBS[h0 + 3u];
    var Q = 0.0;
    for (var m = 0u; m < cnt; m = m + 1u) {
      let u = U[u32(OBS[off + 2u * m])];
      Q = Q + (u.y * nxs + u.z * nys) * OBS[off + 2u * m + 1u];
    }
    REC[base + 16u + 3u * P.nProbes + q] = Q;
  }
  if (li == 0u) {
    let t = r1[0];
    let m = r2[0];
    REC[base + 0u] = f32(C.stepIdx - 1u);
    REC[base + 1u] = C.tRel;
    REC[base + 2u] = t.x;
    REC[base + 3u] = C.rainAcc;
    REC[base + 4u] = C.inflowAcc;
    REC[base + 5u] = t.y;
    REC[base + 6u] = t.z;
    REC[base + 7u] = m.z;
    REC[base + 8u] = m.w;
    REC[base + 9u] = t.w;
    REC[base + 10u] = m.x;
    REC[base + 11u] = m.y;
    REC[base + 12u] = f32(C.recFlag);
    C.recCount = wslot + 1u;
  }
}
`;

export const COPY_U0 = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> U: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> U0: array<vec4<f32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  if (p < P.N) { U0[p] = U[p]; }
}
`;

/** Interior depth and velocities packed as [h | u | v] for read-back. */
export const PACK = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> U: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> OUT: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= P.nCells) { return; }
  let i = c % P.nx;
  let j = c / P.nx;
  let u = U[(j + 2u) * P.NX + i + 2u];
  let hd = max(P.hDry, 1e-5);
  var vel = vec2<f32>(0.0, 0.0);
  if (u.x > hd) { vel = u.yz / u.x; }
  OUT[c] = u.x;
  OUT[P.nCells + c] = vel.x;
  OUT[2u * P.nCells + c] = vel.y;
}
`;

/** Gates / breaches: bed of each line cell from its line crest (raise / lower / set). Runs at the start of a step. */
export const ZLINE = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> U: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> C: Ctrl;
@group(0) @binding(3) var<storage, read> ZL: array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= arrayLength(&ZL)) { return; }
  let e = ZL[k];
  let p = u32(e.x);
  // (P must be referenced: with layout 'auto' an unused binding is dropped and the bind group is invalid)
  if (p >= P.N) { return; }
  let cr = C.lineCrest[u32(e.z)];
  var zb = cr;
  if (e.w < 0.5) { zb = max(e.y, cr); } else if (e.w < 1.5) { zb = min(e.y, cr); }
  var u = U[p];
  u.w = zb;
  U[p] = u;
}
`;

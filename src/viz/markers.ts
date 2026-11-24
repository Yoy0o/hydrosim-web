import * as THREE from 'three';
import type { BoundarySpec, Side } from '../core/solver';
import type { Scenario, Terrain } from '../types';
import { surfaceElevation } from './picking';
import type { Viewer } from './scene';

export const MARKER_COLORS = {
  probe: '#fbbf24',
  section: '#f472b6',
  source: '#22d3ee',
  region: '#60a5fa',
  draft: '#fde047',
  wall: '#9ca3af',
  open: '#34d399',
  level: '#3b82f6',
  tide: '#818cf8',
  ocean: '#38bdf8',
  rough: '#86efac',
  building: '#fb923c',
  levee: '#d6a26c',
  weir: '#fbbf24',
  gate: '#f87171',
  breach: '#c084fc',
  culvert: '#5eead4',
  pump: '#f472b6',
};

function labelSprite(text: string, color: string): THREE.Sprite {
  const pad = 10;
  const fontPx = 34;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `600 ${fontPx}px system-ui, "Microsoft YaHei", sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.font = `600 ${fontPx}px system-ui, "Microsoft YaHei", sans-serif`;
  g.fillStyle = 'rgba(10,16,26,0.78)';
  const r = 10;
  g.beginPath();
  g.roundRect(0, 0, w, h, r);
  g.fill();
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.stroke();
  g.fillStyle = '#f8fafc';
  g.textBaseline = 'middle';
  g.fillText(text, pad, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const s = new THREE.Sprite(mat);
  s.userData.aspect = w / h;
  s.renderOrder = 20;
  s.center.set(0.5, 0);
  return s;
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) {
      for (const x of Array.isArray(mat) ? mat : [mat]) {
        const mm = x as THREE.SpriteMaterial;
        if (mm.map) mm.map.dispose();
        x.dispose();
      }
    }
  });
}

export class MarkerLayer {
  readonly group = new THREE.Group();
  private readonly draft = new THREE.Group();
  private readonly cursor: THREE.LineLoop;
  private viewer: Viewer;
  private terrain: Terrain | null = null;
  labelScale = 1;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    viewer.overlay.add(this.group);
    viewer.overlay.add(this.draft);
    const ring = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 64 }, (_, k) => new THREE.Vector3(Math.cos((k / 64) * Math.PI * 2), 0, Math.sin((k / 64) * Math.PI * 2))),
    );
    this.cursor = new THREE.LineLoop(ring, new THREE.LineBasicMaterial({ color: '#fde047', depthTest: false, transparent: true }));
    this.cursor.renderOrder = 30;
    this.cursor.visible = false;
    viewer.overlay.add(this.cursor);
  }

  setTerrain(t: Terrain): void {
    this.terrain = t;
  }

  private elev(x: number, y: number, h?: ArrayLike<number> | null): number {
    return surfaceElevation(this.terrain!, x, y, h ?? null);
  }

  private world(x: number, y: number, lift = 0, h?: ArrayLike<number> | null): THREE.Vector3 {
    const v = this.viewer.toWorld(x, y, this.elev(x, y, h));
    v.y += lift;
    return v;
  }

  private draped(pts: [number, number][], closed: boolean, color: string, lift: number, width = 1, dashed = false): THREE.Line {
    const t = this.terrain!;
    const step = Math.min(t.dx, t.dy);
    const out: THREE.Vector3[] = [];
    const n = closed ? pts.length : pts.length - 1;
    for (let k = 0; k < n; k++) {
      const [x1, y1] = pts[k];
      const [x2, y2] = pts[(k + 1) % pts.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const m = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s < m; s++) {
        const f = s / m;
        out.push(this.world(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, lift));
      }
    }
    if (!closed && pts.length) out.push(this.world(pts[pts.length - 1][0], pts[pts.length - 1][1], lift));
    const geom = new THREE.BufferGeometry().setFromPoints(out);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: lift * 6, gapSize: lift * 4, transparent: true, opacity: 0.95, linewidth: width })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, linewidth: width });
    const line = closed ? new THREE.LineLoop(geom, mat) : new THREE.Line(geom, mat);
    if (dashed) line.computeLineDistances();
    line.renderOrder = 1;
    return line;
  }

  private label(text: string, color: string, pos: THREE.Vector3): THREE.Sprite {
    const s = labelSprite(text, color);
    // constant on-screen size (about 3.5 % of the viewport height) whatever the camera distance
    (s.material as THREE.SpriteMaterial).sizeAttenuation = false;
    const hgt = 0.03 * this.labelScale;
    s.scale.set(hgt * (s.userData.aspect as number), hgt, 1);
    s.position.copy(pos);
    return s;
  }

  rebuild(sc: Scenario, opts: { showBoundaries: boolean; selected?: string | null }): void {
    const t = this.terrain;
    const f = this.viewer.frame;
    disposeTree(this.group);
    this.group.clear();
    if (!t || !f) return;
    const L = f.L;
    const lift = 0.002 * L;
    // boundaries
    if (opts.showBoundaries) {
      const Lx = t.nx * t.dx;
      const Ly = t.ny * t.dy;
      const e = 1e-3 * Math.min(t.dx, t.dy);
      const edges: Record<Side, [number, number][]> = {
        south: [[e, e], [Lx - e, e]],
        east: [[Lx - e, e], [Lx - e, Ly - e]],
        north: [[Lx - e, Ly - e], [e, Ly - e]],
        west: [[e, Ly - e], [e, e]],
      };
      for (const side of ['south', 'east', 'north', 'west'] as Side[]) {
        const spec: BoundarySpec = sc.boundaries[side];
        const col = MARKER_COLORS[spec.type];
        this.group.add(this.draped(edges[side], false, col, lift * 1.5, 2, spec.type === 'open' || spec.type === 'ocean'));
      }
    }
    // initial-condition regions
    for (const r of sc.initial.regions) {
      if (r.polygon.length < 2) continue;
      this.group.add(this.draped(r.polygon, true, MARKER_COLORS.region, lift, 1, true));
      const cx = r.polygon.reduce((a, p) => a + p[0], 0) / r.polygon.length;
      const cy = r.polygon.reduce((a, p) => a + p[1], 0) / r.polygon.length;
      this.group.add(this.label(`${r.name} ▽${r.level.toFixed(1)} m`, MARKER_COLORS.region, this.world(cx, cy, lift * 6)));
    }
    // sections
    for (const s of sc.sections) {
      const sel = opts.selected === s.id;
      this.group.add(this.draped([[s.x1, s.y1], [s.x2, s.y2]], false, sel ? '#ffffff' : MARKER_COLORS.section, lift * 2, 2));
      const a = this.world(s.x1, s.y1, lift * 2);
      const b = this.world(s.x2, s.y2, lift * 2);
      const m = a.clone().lerp(b, 0.5);
      m.y = Math.max(a.y, b.y, m.y) + 0.01 * L;
      this.group.add(this.label(s.name, MARKER_COLORS.section, m));
    }
    // sources
    for (const q of sc.sources) {
      const base = this.world(q.x, q.y, lift);
      const hgt = 0.05 * L;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.01 * L, 0.03 * L, 16),
        new THREE.MeshBasicMaterial({ color: MARKER_COLORS.source, transparent: true, opacity: 0.9 }),
      );
      cone.rotation.x = Math.PI;
      cone.position.copy(base).add(new THREE.Vector3(0, 0.015 * L + 0.002 * L, 0));
      cone.renderOrder = 4;
      this.group.add(cone);
      const ringPts: [number, number][] = Array.from({ length: 40 }, (_, k) => [
        q.x + Math.cos((k / 40) * Math.PI * 2) * Math.max(q.radius, t.dx),
        q.y + Math.sin((k / 40) * Math.PI * 2) * Math.max(q.radius, t.dx),
      ]);
      this.group.add(this.draped(ringPts, true, MARKER_COLORS.source, lift));
      this.group.add(this.label(q.name, MARKER_COLORS.source, base.clone().add(new THREE.Vector3(0, hgt * 0.75, 0))));
    }
    // probes
    for (const p of sc.probes) {
      const sel = opts.selected === p.id;
      const base = this.world(p.x, p.y, 0);
      const hgt = 0.045 * L;
      const top = base.clone().add(new THREE.Vector3(0, hgt, 0));
      const g = new THREE.BufferGeometry().setFromPoints([base, top]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: sel ? '#ffffff' : MARKER_COLORS.probe }));
      line.renderOrder = 4;
      this.group.add(line);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.004 * L, 12, 8), new THREE.MeshBasicMaterial({ color: MARKER_COLORS.probe }));
      ball.position.copy(top);
      this.group.add(ball);
      this.group.add(this.label(p.name, MARKER_COLORS.probe, top.clone().add(new THREE.Vector3(0, 0.004 * L, 0))));
    }
    // roughness zones
    for (const z of sc.roughness?.zones ?? []) {
      if (z.polygon.length < 3) continue;
      const sel = opts.selected === z.id;
      this.group.add(this.draped(z.polygon, true, sel ? '#ffffff' : MARKER_COLORS.rough, lift, 1, true));
      const cx = z.polygon.reduce((a, p) => a + p[0], 0) / z.polygon.length;
      const cy = z.polygon.reduce((a, p) => a + p[1], 0) / z.polygon.length;
      this.group.add(this.label(`${z.name} n=${z.n}`, MARKER_COLORS.rough, this.world(cx, cy, lift * 4)));
    }
    // user-drawn building footprints
    for (const b of sc.buildings?.items ?? []) {
      if (b.polygon.length >= 3) this.group.add(this.draped(b.polygon, true, MARKER_COLORS.building, lift * 1.5, 1));
    }
    // structure lines (levee / weir / gate / breach)
    const names = { levee: '堤防', weir: '堰', gate: '闸门', breach: '溃口' };
    for (const s of sc.structures ?? []) {
      if (s.points.length < 2) continue;
      const sel = opts.selected === s.id;
      const col = sel ? '#ffffff' : MARKER_COLORS[s.kind];
      this.group.add(this.draped(s.points, false, col, lift * 3, 2));
      // static levees/weirs are often many segments: label them only when selected
      if (!sel && (s.kind === 'levee' || s.kind === 'weir')) continue;
      const mid = s.points[Math.floor((s.points.length - 1) / 2)];
      const nxt = s.points[Math.min(s.points.length - 1, Math.floor((s.points.length - 1) / 2) + 1)];
      const pos = this.world((mid[0] + nxt[0]) / 2, (mid[1] + nxt[1]) / 2, 0.012 * L);
      this.group.add(this.label(`${s.name || names[s.kind]} ▽${s.crest.toFixed(1)}`, MARKER_COLORS[s.kind], pos));
    }
    // culverts / pumps: arcs from inlet to outlet
    for (const l of sc.links ?? []) {
      const sel = opts.selected === l.id;
      const col = sel ? '#ffffff' : l.kind === 'culvert' ? MARKER_COLORS.culvert : MARKER_COLORS.pump;
      const a = this.world(l.x1, l.y1, lift * 2);
      const b = this.world(l.x2, l.y2, lift * 2);
      const peak = Math.max(0.01 * L, a.distanceTo(b) * 0.25);
      const ctrl = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, peak, 0));
      const curve = new THREE.QuadraticBezierCurve3(a, ctrl, b);
      const geom = new THREE.BufferGeometry().setFromPoints(curve.getPoints(32));
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.95 }));
      line.renderOrder = 4;
      this.group.add(line);
      for (const [p, r] of [[a, 0.004], [b, 0.003]] as [THREE.Vector3, number][]) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(r * L, 10, 8), new THREE.MeshBasicMaterial({ color: col }));
        m.position.copy(p);
        this.group.add(m);
      }
      this.group.add(this.label(l.name, col, curve.getPoint(0.5).add(new THREE.Vector3(0, 0.004 * L, 0))));
    }
  }

  /** Preview of a polygon/line being drawn. */
  setDraft(points: [number, number][], closed: boolean, hover?: [number, number] | null): void {
    disposeTree(this.draft);
    this.draft.clear();
    if (!this.terrain || !this.viewer.frame) return;
    const pts = hover ? [...points, hover] : points;
    if (pts.length === 0) return;
    const L = this.viewer.frame.L;
    if (pts.length >= 2) this.draft.add(this.draped(pts, closed && pts.length > 2, MARKER_COLORS.draft, 0.003 * L, 2));
    for (const [x, y] of points) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.004 * L, 10, 8), new THREE.MeshBasicMaterial({ color: MARKER_COLORS.draft, depthTest: false }));
      m.position.copy(this.world(x, y, 0.003 * L));
      m.renderOrder = 25;
      this.draft.add(m);
    }
  }

  setCursor(x: number | null, y = 0, radius = 0, h?: ArrayLike<number> | null): void {
    if (x === null || !this.terrain || !this.viewer.frame) {
      this.cursor.visible = false;
      return;
    }
    const p = this.world(x, y, 0.003 * this.viewer.frame.L, h);
    this.cursor.position.copy(p);
    this.cursor.scale.set(radius, 1, radius);
    this.cursor.visible = true;
  }
}

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

/**
 * Mapping between grid-local metres (x east, y north, origin at the south-west corner) and the scene:
 * scene X = x - Lx/2, scene Z = Ly/2 - y, scene Y = (elevation - zRef) * exaggeration.
 */
export class GridFrame {
  readonly Lx: number;
  readonly Ly: number;
  readonly L: number;
  constructor(
    readonly nx: number,
    readonly ny: number,
    readonly dx: number,
    readonly dy: number,
    readonly zMin: number,
    readonly zMax: number,
  ) {
    this.Lx = nx * dx;
    this.Ly = ny * dy;
    this.L = Math.max(this.Lx, this.Ly);
  }
  get zRef(): number {
    return this.zMin;
  }
  sceneX(x: number): number {
    return x - this.Lx / 2;
  }
  sceneZ(y: number): number {
    return this.Ly / 2 - y;
  }
  localX(X: number): number {
    return X + this.Lx / 2;
  }
  localY(Z: number): number {
    return this.Ly / 2 - Z;
  }
}

export interface SharedUniforms {
  uSunDirView: { value: THREE.Vector3 };
  uTime: { value: number };
  uSky: { value: THREE.Color };
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  /** Holds geometry with raw elevations; scaled vertically by the exaggeration. */
  readonly geo = new THREE.Group();
  /** Overlay objects positioned in world space (not scaled). */
  readonly overlay = new THREE.Group();
  readonly sunDir = new THREE.Vector3(-0.45, 0.75, 0.35).normalize();
  readonly uniforms: SharedUniforms = {
    uSunDirView: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uSky: { value: new THREE.Color('#9cc3e6') },
  };
  frame: GridFrame | null = null;
  exaggeration = 1;
  private readonly container: HTMLElement;
  private lastT = performance.now();
  private readonly callbacks: ((dt: number) => void)[] = [];
  private needsResize = true;
  fps = 0;
  private fpsAcc = 0;
  private fpsN = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('viewport-canvas');
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 1e6);
    this.camera.position.set(0, 500, 800);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false;
    this.scene.add(this.geo);
    this.scene.add(this.overlay);
    this.scene.background = this.makeSky();
    new ResizeObserver(() => (this.needsResize = true)).observe(container);
    this.renderer.setAnimationLoop(() => this.loop());
  }

  private makeSky(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#0b1626');
    grd.addColorStop(0.55, '#1b324d');
    grd.addColorStop(1, '#3b5a78');
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  onFrame(cb: (dt: number) => void): void {
    this.callbacks.push(cb);
  }

  setFrame(frame: GridFrame, resetCamera = true): void {
    this.frame = frame;
    this.applyExaggeration();
    if (resetCamera) this.resetCamera('3d');
  }

  setExaggeration(e: number): void {
    this.exaggeration = e;
    this.applyExaggeration();
  }

  private applyExaggeration(): void {
    const f = this.frame;
    this.geo.scale.set(1, this.exaggeration, 1);
    this.geo.position.y = f ? -f.zRef * this.exaggeration : 0;
    this.geo.updateMatrixWorld(true);
  }

  /** World (scene) position of a local point at a given elevation. */
  toWorld(x: number, y: number, elev: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = this.frame!;
    return out.set(f.sceneX(x), (elev - f.zRef) * this.exaggeration, f.sceneZ(y));
  }

  resetCamera(mode: '3d' | 'top'): void {
    const f = this.frame;
    if (!f) return;
    const relief = (f.zMax - f.zMin) * this.exaggeration;
    const cy = relief * 0.3;
    this.controls.target.set(0, cy, 0);
    const d = f.L * 1.05;
    if (mode === 'top') {
      this.camera.position.set(0, cy + d * 1.25, 0.001 * d);
    } else {
      this.camera.position.set(-0.35 * d, cy + 0.6 * d, 0.75 * d);
    }
    this.camera.near = Math.max(0.05, f.L / 20000);
    this.camera.far = f.L * 50;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = f.L / 500;
    this.controls.maxDistance = f.L * 6;
    this.controls.update();
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsResize = false;
  }

  private loop(): void {
    if (this.needsResize) this.resize();
    const nowT = performance.now();
    const dt = Math.min(0.1, (nowT - this.lastT) / 1000);
    this.lastT = nowT;
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    this.uniforms.uTime.value += dt;
    this.controls.update();
    for (const cb of this.callbacks) cb(dt);
    this.camera.updateMatrixWorld();
    this.uniforms.uSunDirView.value.copy(this.sunDir).transformDirection(this.camera.matrixWorldInverse);
    this.renderer.render(this.scene, this.camera);
  }

  /** Render immediately and return a PNG data URL of the viewport. */
  screenshot(): string {
    this.camera.updateMatrixWorld();
    this.uniforms.uSunDirView.value.copy(this.sunDir).transformDirection(this.camera.matrixWorldInverse);
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Normalised device coordinates of a pointer event. */
  ndc(ev: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  /** Project a world point to CSS pixels inside the viewport (null if behind the camera). */
  project(p: THREE.Vector3): { x: number; y: number } | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
  }
}

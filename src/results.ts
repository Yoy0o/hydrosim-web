/** Result stores on the main thread: time series records and playback frames (memory-budgeted). */
import type { RecordRow } from './worker/protocol';

export interface SeriesRow {
  t: number;
  probes: Map<string, [number, number, number]>;
  sections: Map<string, number>;
  volume: number;
  rain: number;
  inflow: number;
  infiltration: number;
  boundaryIn: number;
  boundaryOut: number;
  wetArea: number;
  massError: number;
}

export class SeriesStore {
  rows: SeriesRow[] = [];
  version = 0;

  clear(): void {
    this.rows = [];
    this.version++;
  }

  add(records: RecordRow[], probeIds: string[], sectionIds: string[]): void {
    for (const r of records) {
      // drop records that go back in time (after a reset race)
      if (this.rows.length && r.t < this.rows[this.rows.length - 1].t - 1e-9) continue;
      const pids = r.pids ?? probeIds;
      const sids = r.sids ?? sectionIds;
      const probes = new Map<string, [number, number, number]>();
      r.probes.forEach((v, k) => {
        if (pids[k]) probes.set(pids[k], v);
      });
      const sections = new Map<string, number>();
      r.sections.forEach((q, k) => {
        if (sids[k]) sections.set(sids[k], q);
      });
      this.rows.push({ ...r, probes, sections });
    }
    if (records.length) this.version++;
  }
}

export interface ResultFrame {
  t: number;
  h: Float32Array;
  u: Float32Array;
  v: Float32Array;
}

export class FrameStore {
  frames: ResultFrame[] = [];
  private keepEvery = 1;
  private received = 0;
  budgetBytes: number;
  version = 0;

  constructor(budgetMB = 400) {
    this.budgetBytes = budgetMB * 1024 * 1024;
  }

  clear(): void {
    this.frames = [];
    this.keepEvery = 1;
    this.received = 0;
    this.version++;
  }

  add(f: ResultFrame): void {
    if (this.frames.length && f.t <= this.frames[this.frames.length - 1].t + 1e-9) {
      // replace a frame at the same time (e.g. re-sent initial state)
      if (Math.abs(f.t - this.frames[this.frames.length - 1].t) < 1e-9) this.frames[this.frames.length - 1] = f;
      return;
    }
    const n = this.received++;
    if (n % this.keepEvery !== 0) return;
    this.frames.push(f);
    const bytes = this.frames.length * (f.h.byteLength * 3);
    if (bytes > this.budgetBytes && this.frames.length > 4) {
      this.frames = this.frames.filter((_, k) => k % 2 === 0);
      this.keepEvery *= 2;
    }
    this.version++;
  }

  get memoryMB(): number {
    if (!this.frames.length) return 0;
    return (this.frames.length * this.frames[0].h.byteLength * 3) / 1048576;
  }
}

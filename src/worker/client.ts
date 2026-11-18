import type { GridSpec, SolverParams } from '../core/solver';
import type { EnginePref, MainToWorker, ProbeSpec, SectionSpec, WorkerToMain } from './protocol';

/** Thin typed wrapper around the simulation Web Worker. */
export class SimClient {
  private worker: Worker;
  onMessage: (msg: WorkerToMain) => void = () => {};
  private epoch = 0;

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      // drop messages that belong to a previously loaded case
      if (e.data.epoch !== undefined && e.data.epoch !== this.epoch) return;
      this.onMessage(e.data);
    };
    this.worker.onerror = (e) => this.onMessage({ type: 'error', message: e.message || 'Worker 错误' });
  }

  private send(msg: MainToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  init(o: {
    grid: GridSpec;
    z: Float32Array;
    h0: Float32Array;
    params: SolverParams;
    duration: number;
    outputInterval: number;
    recordInterval: number;
    probes: ProbeSpec[];
    sections: SectionSpec[];
    engine: EnginePref;
  }): void {
    this.epoch++;
    this.send({ type: 'init', epoch: this.epoch, ...o }, [o.z.buffer, o.h0.buffer]);
  }
  run(): void {
    this.send({ type: 'run' });
  }
  pause(): void {
    this.send({ type: 'pause' });
  }
  step(count: number): void {
    this.send({ type: 'step', count });
  }
  reset(): void {
    this.send({ type: 'reset' });
  }
  setParams(params: Partial<SolverParams>, extra: { duration?: number; outputInterval?: number; recordInterval?: number } = {}): void {
    this.send({ type: 'params', params, ...extra });
  }
  setSpeed(simPerSec: number): void {
    this.send({ type: 'speed', simPerSec });
  }
  setObservers(probes: ProbeSpec[], sections: SectionSpec[]): void {
    this.send({ type: 'observers', probes, sections });
  }
  ack(): void {
    this.send({ type: 'ack' });
  }
  requestEnvelopes(): void {
    this.send({ type: 'envelopes' });
  }
  pour(x: number, y: number, radius: number, rate: number): void {
    this.send({ type: 'pour', x, y, radius, rate });
  }
  setEngine(pref: EnginePref): void {
    this.send({ type: 'engine', pref });
  }
  setDepth(h: Float32Array): void {
    this.send({ type: 'setDepth', h }, [h.buffer]);
  }
}

/**
 * Simulation worker: owns a solver engine (CPU double precision or WebGPU), advances it in batches,
 * streams field frames to the main thread (back-pressured by acks), result frames for playback,
 * time-series records and envelopes. All engine read-backs are serialised through `exclusive`.
 */
import { createEngine, type Engine, type Fields } from './engine';
import type { EngineInfo, EnginePref, InitMessage, MainToWorker, RecordRow, SimStats, WorkerToMain } from './protocol';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let engine: Engine | null = null;
let info: EngineInfo = { kind: 'cpu', label: '' };
let init: InitMessage | null = null;
let epoch = 0;
let duration = 0;
let outputInterval = 60;
let recordInterval = 10;
let running = false;
let finished = false;
let speed = 0; // simulated seconds per wall-clock second, 0 = as fast as possible
let wallRef = 0;
let simRef = 0;
let acked = true;
let pending: RecordRow[] = [];
let nextOutput = 0;
let lastFrameAt = 0;
let perfWall = 0;
let perfSteps = 0;
let perfSim = 0;
let stepsPerSec = 0;
let simPerSec = 0;
let wantEnvelopes = false;
let lastEnvelopeAt = 0;
let loop: Promise<void> | null = null;
let queue: Promise<void> = Promise.resolve();
let lock: Promise<unknown> = Promise.resolve();

/** Serialise engine operations that touch GPU read-back buffers. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = lock.then(fn, fn);
  lock = p.catch(() => undefined);
  return p;
}

const channel = new MessageChannel();
const yielders: (() => void)[] = [];
channel.port1.onmessage = () => yielders.shift()?.();
const yieldTask = (): Promise<void> =>
  new Promise<void>((r) => {
    yielders.push(r);
    channel.port2.postMessage(0);
  });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  scope.postMessage({ ...msg, epoch }, transfer);
}

function stats(): SimStats {
  const s = engine!.stats();
  return { ...s, stepsPerSec, simPerSec, running, finished, engine: info.kind };
}

function postFrame(f: Fields, reset = false): void {
  const records = pending;
  pending = [];
  acked = false;
  lastFrameAt = performance.now();
  post(
    {
      type: 'frame',
      stats: stats(),
      h: f.h,
      u: f.u,
      v: f.v,
      records,
      probeIds: init ? init.probes.map((p) => p.id) : [],
      sectionIds: init ? init.sections.map((q) => q.id) : [],
      reset,
    },
    [f.h.buffer, f.u.buffer, f.v.buffer],
  );
}

async function sendFrame(force = false, reset = false): Promise<void> {
  const e = engine;
  if (!e || (!acked && !force)) return;
  const f = await exclusive(() => e.fields());
  if (e === engine) postFrame(f, reset);
}

function postOutput(f: Fields, t: number): void {
  post({ type: 'output', t, h: f.h, u: f.u, v: f.v }, [f.h.buffer, f.u.buffer, f.v.buffer]);
}

async function sendOutput(): Promise<void> {
  const e = engine;
  if (!e) return;
  const f = await exclusive(() => e.fields());
  if (e === engine) postOutput(f, e.t);
}

async function sendEnvelopes(): Promise<void> {
  const e = engine;
  if (!e) return;
  const env = await exclusive(() => e.envelopes());
  if (e !== engine) return;
  lastEnvelopeAt = performance.now();
  post({ type: 'envelopes', ...env, t: e.t }, [env.maxH.buffer, env.maxV.buffer, env.maxHaz.buffer, env.arrival.buffer]);
}

async function runLoop(): Promise<void> {
  perfWall = performance.now();
  perfSteps = 0;
  perfSim = 0;
  while (running && engine) {
    const e = engine;
    if (e.t >= duration - 1e-9) {
      finished = true;
      running = false;
      break;
    }
    let tStop = Math.min(nextOutput, duration);
    if (speed > 0) {
      const target = simRef + ((performance.now() - wallRef) / 1000) * speed;
      if (e.t >= target - 1e-12) {
        await sleep(8);
        continue;
      }
      tStop = Math.min(tStop, target);
    }
    const wantFields = acked && performance.now() - lastFrameAt >= 15;
    const steps0 = e.stepCount;
    const t0 = e.t;
    let r;
    try {
      r = await exclusive(() => e.advance(tStop, 14, wantFields));
    } catch (err) {
      running = false;
      post({ type: 'error', message: String((err as Error)?.message ?? err) });
      break;
    }
    if (e !== engine) break;
    if (r.records.length) pending.push(...r.records);
    perfSteps += e.stepCount - steps0;
    perfSim += e.t - t0;
    const now = performance.now();
    if (now - perfWall > 500) {
      const w = (now - perfWall) / 1000;
      stepsPerSec = perfSteps / w;
      simPerSec = perfSim / w;
      perfWall = now;
      perfSteps = 0;
      perfSim = 0;
    }
    if (!Number.isFinite(e.stats().volume)) {
      running = false;
      post({ type: 'error', message: '数值发散（出现 NaN），请减小 CFL 或检查边界/源项设置' });
      break;
    }
    let fields = r.fields;
    if (e.t >= nextOutput - 1e-9) {
      const f = fields ?? (await exclusive(() => e.fields()));
      postOutput({ h: f.h.slice(), u: f.u.slice(), v: f.v.slice() }, e.t);
      while (nextOutput <= e.t + 1e-9) nextOutput += outputInterval;
      if (!fields && acked) fields = f;
    }
    if (fields) postFrame(fields);
    else if (acked && now - lastFrameAt >= 15) await sendFrame();
    if (wantEnvelopes && performance.now() - lastEnvelopeAt > 1000) await sendEnvelopes();
    if (e.kind === 'cpu') await yieldTask();
  }
  if (!engine) return;
  if (finished) {
    pending.push(engine.currentRecord());
    await sendFrame(true);
    await sendEnvelopes();
    post({ type: 'state', running: false, finished: true });
  } else {
    post({ type: 'state', running, finished });
  }
}

async function stopLoop(): Promise<void> {
  running = false;
  if (loop) await loop;
}

function resetCommon(): void {
  running = false;
  finished = false;
  pending = engine ? [engine.currentRecord()] : [];
  nextOutput = outputInterval;
  stepsPerSec = 0;
  simPerSec = 0;
}

async function startEngine(msg: InitMessage, pref: EnginePref): Promise<void> {
  await stopLoop();
  const old = engine;
  engine = null;
  if (old) await exclusive(async () => old.dispose());
  init = msg;
  duration = msg.duration;
  outputInterval = msg.outputInterval;
  recordInterval = msg.recordInterval;
  const created = await createEngine(pref, {
    grid: msg.grid,
    z: msg.z,
    h0: msg.h0,
    params: msg.params,
    recordInterval: msg.recordInterval,
    probes: msg.probes,
    sections: msg.sections,
  });
  engine = created.engine;
  info = { kind: engine.kind, label: engine.label, note: created.note };
  resetCommon();
  post({ type: 'ready', stats: stats(), engine: info });
  await sendFrame(true, true);
  await sendOutput();
  if (wantEnvelopes) await sendEnvelopes();
}

async function handle(msg: MainToWorker): Promise<void> {
  switch (msg.type) {
    case 'init':
      epoch = msg.epoch;
      wantEnvelopes = false;
      await startEngine(msg, msg.engine);
      break;
    case 'engine':
      if (!init) return;
      await startEngine({ ...init, engine: msg.pref }, msg.pref);
      post({ type: 'state', running: false, finished: false });
      break;
    case 'run':
      if (!engine || finished || engine.t >= duration - 1e-9) return;
      running = true;
      wallRef = performance.now();
      simRef = engine.t;
      post({ type: 'state', running, finished });
      if (!loop) loop = runLoop().finally(() => (loop = null));
      break;
    case 'pause':
      await stopLoop();
      await sendFrame(true);
      post({ type: 'state', running: false, finished });
      break;
    case 'step': {
      if (!engine) return;
      await stopLoop();
      const e = engine;
      const r = await exclusive(() => e.advance(Math.min(nextOutput, duration), 1e9, false, msg.count));
      pending.push(...r.records);
      if (e.t >= nextOutput - 1e-9) {
        await sendOutput();
        while (nextOutput <= e.t + 1e-9) nextOutput += outputInterval;
      }
      if (e.t >= duration - 1e-9) finished = true;
      await sendFrame(true);
      if (wantEnvelopes) await sendEnvelopes();
      post({ type: 'state', running: false, finished });
      break;
    }
    case 'reset': {
      if (!engine || !init) return;
      await stopLoop();
      const e = engine;
      const h0 = init.h0;
      await exclusive(async () => e.setState(h0));
      resetCommon();
      await sendFrame(true, true);
      await sendOutput();
      await sendEnvelopes();
      post({ type: 'state', running: false, finished: false });
      break;
    }
    case 'setDepth': {
      if (!engine || !init) return;
      await stopLoop();
      init = { ...init, h0: msg.h };
      const e = engine;
      const h0 = msg.h;
      await exclusive(async () => e.setState(h0));
      resetCommon();
      await sendFrame(true, true);
      await sendOutput();
      post({ type: 'state', running: false, finished: false });
      break;
    }
    case 'params':
      if (!engine) return;
      engine.setParams(msg.params);
      if (init) init = { ...init, params: { ...init.params, ...msg.params } };
      if (msg.duration !== undefined) {
        duration = msg.duration;
        if (engine.t < duration - 1e-9 && finished) {
          finished = false;
          post({ type: 'state', running, finished });
        }
      }
      if (msg.outputInterval !== undefined) {
        outputInterval = msg.outputInterval;
        nextOutput = engine.t + outputInterval;
      }
      if (msg.recordInterval !== undefined) {
        recordInterval = msg.recordInterval;
        engine.setRecordInterval(recordInterval);
      }
      break;
    case 'observers':
      if (init) init = { ...init, probes: msg.probes, sections: msg.sections };
      engine?.setObservers(msg.probes, msg.sections);
      break;
    default:
      break;
  }
}

scope.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  // lightweight messages are applied immediately
  switch (msg.type) {
    case 'ack':
      acked = true;
      return;
    case 'speed':
      speed = msg.simPerSec;
      wallRef = performance.now();
      simRef = engine ? engine.t : 0;
      return;
    case 'pour':
      engine?.setExtraSources(msg.rate > 0 ? [{ x: msg.x, y: msg.y, radius: msg.radius, series: [[0, msg.rate]] }] : []);
      return;
    case 'envelopes':
      wantEnvelopes = true;
      lastEnvelopeAt = 0;
      if (!running) queue = queue.then(() => sendEnvelopes()).catch(() => undefined);
      return;
    default:
      break;
  }
  queue = queue
    .then(() => handle(msg))
    .catch((err) => post({ type: 'error', message: String((err as Error)?.message ?? err) }));
};

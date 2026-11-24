/**
 * 算法核验 dialog: runs the verification suite (src/verify/cases.ts) in a Web Worker and shows each
 * metric against its threshold, an analytical-vs-numerical plot and a link to the algorithm document.
 */
import { CASES, type VerifyPlot, type VerifyResult } from '../verify/cases';
import type { VerifyReply, VerifyRequest } from '../verify/verify.worker';
import { button, el, fmt, icon, modal } from './dom';
import { openDocs } from './docViewer';
import { ICONS } from './icons';

const PALETTE = ['#e2e8f0', '#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f472b6'];

function fmtVal(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  return a >= 1e-3 && a < 1e5 ? fmt(v, a < 1 ? 5 : 3) : v.toExponential(2);
}

/** Minimal SVG line chart: reference series dashed, NaN breaks the line. */
function plotSvg(p: VerifyPlot): SVGSVGElement {
  const W = 520;
  const H = 210;
  const L = 52;
  const R = 10;
  const T = 24;
  const B = 34;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of p.series) {
    s.x.forEach((x, k) => {
      const y = s.y[k];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    });
  }
  if (!(x1 > x0)) x1 = x0 + 1;
  if (!(y1 > y0)) {
    y0 -= 0.5;
    y1 += 0.5;
  }
  const pad = 0.06 * (y1 - y0);
  y0 -= pad;
  y1 += pad;
  const sx = (x: number): number => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const sy = (y: number): number => H - B - ((y - y0) / (y1 - y0)) * (H - T - B);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'vf-plot');
  const add = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    svg.append(e);
    return e;
  };
  add('rect', { x: L, y: T, width: W - L - R, height: H - T - B, class: 'vf-frame' });
  for (let k = 0; k <= 4; k++) {
    const yv = y0 + ((y1 - y0) * k) / 4;
    const yy = sy(yv);
    add('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'vf-grid' });
    add('text', { x: L - 5, y: yy + 3.5, class: 'vf-tick', 'text-anchor': 'end' }, fmtVal(+yv.toPrecision(3)));
    const xv = x0 + ((x1 - x0) * k) / 4;
    add('text', { x: sx(xv), y: H - B + 14, class: 'vf-tick', 'text-anchor': k === 0 ? 'start' : k === 4 ? 'end' : 'middle' }, fmtVal(+xv.toPrecision(3)));
  }
  add('text', { x: L + (W - L - R) / 2, y: H - 4, class: 'vf-axis', 'text-anchor': 'middle' }, p.xLabel);
  add('text', { x: 12, y: T + (H - T - B) / 2, class: 'vf-axis', 'text-anchor': 'middle', transform: `rotate(-90 12 ${T + (H - T - B) / 2})` }, p.yLabel);
  let lx = L + 6;
  p.series.forEach((s, k) => {
    const col = PALETTE[k % PALETTE.length];
    let d = '';
    let pen = false;
    s.x.forEach((x, m) => {
      const y = s.y[m];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
      pen = true;
    });
    add('path', { d, fill: 'none', stroke: col, 'stroke-width': s.ref ? 1.6 : 1.4, 'stroke-dasharray': s.ref ? '5 4' : 'none' });
    add('line', { x1: lx, x2: lx + 16, y1: T - 9, y2: T - 9, stroke: col, 'stroke-width': 2, 'stroke-dasharray': s.ref ? '4 3' : 'none' });
    const label = add('text', { x: lx + 20, y: T - 5, class: 'vf-legend' }, s.name);
    lx += 30 + Math.max(36, label.textContent!.length * 11);
  });
  return svg;
}

/** Open the verification dialog (cases run in a dedicated worker). */
export function openVerify(): void {
  const results = new Map<string, VerifyResult>();
  const running = new Set<string>();
  const queued = new Set<string>();
  let worker: Worker | null = null;
  const gpuOk = typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
  const list = el('div', { class: 'vf-list' });
  const summary = el('span', { class: 'vf-summary' });

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    worker = new Worker(new URL('../verify/verify.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<VerifyReply>) => {
      const m = e.data;
      if (m.type === 'start') {
        queued.delete(m.id);
        running.add(m.id);
      } else if (m.type === 'result') {
        running.delete(m.result.id);
        results.set(m.result.id, m.result);
      }
      render();
    };
    worker.onerror = (e) => {
      for (const id of [...running, ...queued]) results.set(id, { id, pass: false, ms: 0, metrics: [], detail: `核验线程出错：${e.message}` });
      running.clear();
      queued.clear();
      render();
    };
    return worker;
  };
  const runIds = (ids: string[]): void => {
    const todo = ids.filter((id) => !running.has(id) && !queued.has(id));
    if (!todo.length) return;
    todo.forEach((id) => {
      queued.add(id);
      results.delete(id);
    });
    ensureWorker().postMessage({ type: 'run', ids: todo } satisfies VerifyRequest);
    render();
  };

  const render = (): void => {
    const done = [...results.values()];
    const passed = done.filter((r) => r.pass && !r.skipped).length;
    const failed = done.filter((r) => !r.pass).length;
    const skipped = done.filter((r) => r.skipped).length;
    summary.textContent = done.length
      ? `已完成 ${done.length}/${CASES.length}：通过 ${passed}${failed ? ` · 未通过 ${failed}` : ''}${skipped ? ` · 跳过 ${skipped}` : ''}${running.size || queued.size ? ' · 运行中…' : ''}`
      : `${CASES.length} 个核验算例${gpuOk ? '' : '（当前浏览器无 WebGPU，GPU 一致性算例将跳过）'}`;
    list.replaceChildren(
      ...CASES.map((c) => {
        const r = results.get(c.id);
        const state = running.has(c.id) ? 'run' : queued.has(c.id) ? 'queue' : r ? (r.skipped ? 'skip' : r.pass ? 'pass' : 'fail') : 'idle';
        const badge = { run: '运行中…', queue: '排队中', skip: '跳过', pass: '通过', fail: '未通过', idle: '未运行' }[state];
        return el(
          'div',
          { class: `vf-case ${state}` },
          el(
            'div',
            { class: 'vf-head' },
            el('span', { class: `vf-badge ${state}` }, badge),
            el('span', { class: 'vf-title' }, c.title),
            el('span', { class: 'vf-algo' }, c.algorithm),
            r ? el('span', { class: 'muted small' }, `${(r.ms / 1000).toFixed(2)} s`) : null,
            button(el('span', null, icon(ICONS.book, 13), ' 文档'), () => void openDocs(c.doc), 'btn small ghost', '在算法文档中查看该算法'),
            button('运行', () => runIds([c.id]), 'btn small', '只运行该算例'),
          ),
          el('div', { class: 'vf-desc' }, c.description),
          r && r.metrics.length
            ? el(
                'table',
                { class: 'vf-table' },
                el('tr', null, el('th', null, '指标'), el('th', null, '数值'), el('th', null, '阈值'), el('th', null, '结论')),
                ...r.metrics.map((x) => {
                  const ok = x.kind === 'max' ? x.value <= x.limit : x.value >= x.limit;
                  return el(
                    'tr',
                    { class: ok ? 'ok' : 'bad' },
                    el('td', null, x.label),
                    el('td', null, `${fmtVal(x.value)}${x.unit ? ` ${x.unit}` : ''}`),
                    el('td', null, `${x.kind === 'max' ? '≤' : '≥'} ${fmtVal(x.limit)}`),
                    el('td', null, ok ? '✓' : '✗'),
                  );
                }),
              )
            : null,
          r?.detail ? el('div', { class: 'vf-detail' }, r.detail) : null,
          r?.plot ? el('div', { class: 'vf-plot-box' }, el('div', { class: 'vf-plot-title' }, r.plot.title), plotSvg(r.plot)) : null,
        );
      }),
    );
  };

  const body = el(
    'div',
    { class: 'vf-body' },
    el(
      'div',
      { class: 'vf-bar' },
      button(el('span', null, icon(ICONS.play, 14), ' 全部运行'), () => runIds(CASES.map((c) => c.id)), 'btn primary small'),
      summary,
      button(el('span', null, icon(ICONS.book, 14), ' 算法文档'), () => void openDocs('s15'), 'btn small ghost'),
    ),
    el(
      'p',
      { class: 'muted small' },
      '每个算例用与应用相同的求解器代码（CPU 双精度，GPU 算例为 WebGPU 单精度）在后台线程计算，并与解析解、守恒量或 CPU 参考结果比较；阈值与命令行 npm test 一致（tests/verify.test.ts）。',
    ),
    list,
  );
  modal('算法核验', body, {
    width: '960px',
    onClose: () => {
      worker?.terminate();
      worker = null;
    },
  });
  render();
}

/** Bottom dock: time-series charts (probes, sections, mass balance), longitudinal profile and input hydrographs. */
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { App } from '../app';
import { boundaryLevel } from '../core/solver';
import { sampleSeries } from '../core/timeseries';
import { surfaceElevation } from '../viz/picking';
import { button, el, icon, select } from './dom';
import { ICONS } from './icons';

const PALETTE = ['#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#a78bfa', '#fb923c', '#22d3ee', '#e879f9', '#f87171', '#a3e635'];

type Tab = 'probes' | 'sections' | 'balance' | 'profile' | 'inputs';
const TABS: [Tab, string][] = [
  ['probes', '观测点时程'],
  ['sections', '断面流量'],
  ['balance', '水量平衡'],
  ['profile', '断面剖面'],
  ['inputs', '输入过程线'],
];

function axisTheme(label: string, extra: Partial<uPlot.Axis> = {}): uPlot.Axis {
  return {
    label,
    stroke: '#9aa7b8',
    labelFont: '12px system-ui, sans-serif',
    font: '11px system-ui, sans-serif',
    grid: { stroke: 'rgba(148,163,184,0.12)', width: 1 },
    ticks: { stroke: 'rgba(148,163,184,0.25)', width: 1 },
    ...extra,
  };
}

class Chart {
  plot: uPlot | null = null;
  private key = '';
  constructor(private readonly host: HTMLElement) {
    new ResizeObserver(() => this.resize()).observe(host);
  }
  private size(): { width: number; height: number } {
    const legend = (this.host.querySelector('.u-legend') as HTMLElement | null)?.offsetHeight ?? 26;
    return { width: Math.max(200, this.host.clientWidth - 8), height: Math.max(80, this.host.clientHeight - legend - 10) };
  }
  resize(): void {
    if (this.plot) this.plot.setSize(this.size());
  }
  set(key: string, build: () => uPlot.Options, data: uPlot.AlignedData): void {
    if (!this.plot || key !== this.key) {
      this.plot?.destroy();
      this.host.replaceChildren();
      this.key = key;
      const opts = { ...build(), ...this.size() };
      this.plot = new uPlot(opts, data, this.host);
      this.resize();
    } else {
      this.plot.setData(data);
    }
  }
  clear(msg: string): void {
    this.plot?.destroy();
    this.plot = null;
    this.key = '';
    this.host.replaceChildren(el('div', { class: 'chart-empty' }, msg));
  }
}

export function buildDock(root: HTMLElement, app: App): void {
  let tab: Tab = 'probes';
  let probeVar: '0' | '1' | '2' = '0';
  let collapsed = false;
  let profileId: string | null = null;
  const tabBar = el('div', { class: 'dock-tabs' });
  const controls = el('div', { class: 'dock-ctl' });
  const host = el('div', { class: 'dock-chart' });
  const chart = new Chart(host);
  const toggle = button(icon(ICONS.chevron, 14), () => {
    collapsed = !collapsed;
    root.classList.toggle('collapsed', collapsed);
    toggle.classList.toggle('flip', collapsed);
    if (!collapsed) setTimeout(() => refresh(true), 50);
  }, 'icon-btn dock-toggle', '折叠/展开图表');
  root.append(el('div', { class: 'dock-head' }, tabBar, controls, toggle), host);

  const timeFmt = (): { f: number; label: string; fmt: (s: number) => string } => {
    const sc = app.scenario;
    const d = sc?.simulation.duration ?? 1;
    if (sc?.startTime) {
      const t0 = Date.parse(sc.startTime);
      return { f: 1, label: '时间 (UTC)', fmt: (s) => new Date(t0 + s * 1000).toISOString().slice(5, 16).replace('T', ' ') };
    }
    if (d >= 3 * 3600) return { f: 3600, label: '时间 (h)', fmt: (s) => (s / 3600).toFixed(2) };
    if (d >= 180) return { f: 60, label: '时间 (min)', fmt: (s) => (s / 60).toFixed(1) };
    return { f: 1, label: '时间 (s)', fmt: (s) => s.toFixed(1) };
  };

  const timeAxis = (): uPlot.Axis => {
    const tf = timeFmt();
    return axisTheme(tf.label, { values: (_u, vals) => vals.map((v) => (v == null ? '' : tf.fmt(v))) });
  };

  const baseOpts = (series: uPlot.Series[], yLabel: string, extraAxes: uPlot.Axis[] = [], scales: uPlot.Scales = {}): uPlot.Options => ({
    width: 400,
    height: 200,
    series: [{ label: '时间', value: (_u, v) => (v == null ? '—' : timeFmt().fmt(v)) }, ...series],
    axes: [timeAxis(), axisTheme(yLabel, { size: 60 }), ...extraAxes],
    scales: { x: { time: false }, ...scales },
    legend: { live: true },
    cursor: { drag: { x: true, y: false } },
  });

  const renderTabs = (): void => {
    tabBar.replaceChildren(
      ...TABS.map(([k, label]) =>
        button(label, () => {
          tab = k;
          renderTabs();
          refresh(true);
        }, `dock-tab ${tab === k ? 'active' : ''}`),
      ),
    );
    controls.replaceChildren();
    const sc = app.scenario;
    if (tab === 'probes') {
      controls.append(
        select<'0' | '1' | '2'>(probeVar, [['0', '水深 h (m)'], ['1', '水位 η (m)'], ['2', '流速 |V| (m/s)']], (v) => {
          probeVar = v;
          refresh(true);
        }),
      );
    }
    if (tab === 'profile' && sc) {
      const opts: [string, string][] = sc.sections.map((s) => [s.id, s.name]);
      if (!profileId || !sc.sections.some((s) => s.id === profileId)) profileId = opts[0]?.[0] ?? null;
      if (opts.length) controls.append(select(profileId ?? '', opts, (v) => {
        profileId = v;
        refresh(true);
      }));
    }
  };

  let last = 0;
  const refresh = (force = false): void => {
    if (collapsed) return;
    const now = performance.now();
    if (!force && now - last < 400) return;
    last = now;
    const sc = app.scenario;
    if (!sc) return;
    const rows = app.series.rows;
    const xs = rows.map((r) => r.t);
    if (tab === 'probes') {
      if (!sc.probes.length) return chart.clear('尚无观测点。使用左侧"放置观测点"工具在视图中单击添加。');
      const k = Number(probeVar);
      const data: (number | null)[][] = [xs];
      for (const p of sc.probes) data.push(rows.map((r) => r.probes.get(p.id)?.[k] ?? null));
      const label = ['水深 (m)', '水位 (m)', '流速 (m/s)'][k];
      chart.set(
        `probes:${probeVar}:${sc.probes.map((p) => p.id + p.name).join(',')}:${sc.startTime ?? ''}:${sc.simulation.duration}`,
        () => baseOpts(sc.probes.map((p, i) => ({ label: p.name, stroke: PALETTE[i % PALETTE.length], width: 1.6, spanGaps: false })), label),
        data as uPlot.AlignedData,
      );
    } else if (tab === 'sections') {
      if (!sc.sections.length) return chart.clear('尚无断面。使用左侧"绘制断面"工具单击起点和终点。');
      const data: (number | null)[][] = [xs];
      for (const q of sc.sections) data.push(rows.map((r) => r.sections.get(q.id) ?? null));
      chart.set(
        `sections:${sc.sections.map((q) => q.id + q.name).join(',')}:${sc.startTime ?? ''}:${sc.simulation.duration}`,
        () => baseOpts(sc.sections.map((q, i) => ({ label: q.name, stroke: PALETTE[(i + 2) % PALETTE.length], width: 1.6 })), '流量 Q (m³/s)'),
        data as uPlot.AlignedData,
      );
    } else if (tab === 'balance') {
      if (!rows.length) return chart.clear('暂无数据');
      const scale = Math.max(...rows.map((r) => Math.max(r.volume, r.rain + r.inflow + r.boundaryIn))) > 1e5 ? 1e6 : 1;
      const unit = scale === 1e6 ? '百万 m³' : 'm³';
      const data = [
        xs,
        rows.map((r) => r.volume / scale),
        rows.map((r) => (r.rain + r.inflow + r.boundaryIn) / scale),
        rows.map((r) => (r.boundaryOut + r.infiltration) / scale),
        rows.map((r) => r.wetArea / 1e6),
      ];
      chart.set(
        `balance:${unit}:${sc.startTime ?? ''}:${sc.simulation.duration}`,
        () =>
          baseOpts(
            [
              { label: `水量 (${unit})`, stroke: '#38bdf8', width: 2 },
              { label: `累计输入 (${unit})`, stroke: '#34d399', width: 1.5 },
              { label: `累计输出 (${unit})`, stroke: '#f87171', width: 1.5 },
              { label: '淹没面积 (km²)', stroke: '#fbbf24', width: 1.2, dash: [4, 3], scale: 'area' },
            ],
            `水量 (${unit})`,
            [axisTheme('淹没面积 (km²)', { side: 1, scale: 'area', size: 60, grid: { show: false } })],
            { area: { auto: true } },
          ),
        data as uPlot.AlignedData,
      );
    } else if (tab === 'profile') {
      const s = sc.sections.find((q) => q.id === profileId);
      const t = app.terrain;
      if (!s || !t) return chart.clear('尚无断面。剖面图显示所选断面沿线的地形与当前水面。');
      const n = 200;
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const st = app.displayed();
      const dist: number[] = [];
      const bed: number[] = [];
      const wse: (number | null)[] = [];
      for (let k = 0; k <= n; k++) {
        const f = k / n;
        const x = s.x1 + (s.x2 - s.x1) * f;
        const y = s.y1 + (s.y2 - s.y1) * f;
        const zb = surfaceElevation(t, x, y, null);
        const ws = st ? surfaceElevation(t, x, y, st.h, app.view.showDepth) : zb;
        dist.push(f * len);
        bed.push(zb);
        wse.push(ws > zb + 1e-3 ? ws : null);
      }
      chart.set(
        `profile:${s.id}`,
        () => ({
          width: 400,
          height: 200,
          series: [
            { label: '距离 (m)', value: (_u, v) => (v == null ? '—' : v.toFixed(1)) },
            { label: '地形 (m)', stroke: '#b08968', width: 2, fill: 'rgba(176,137,104,0.25)' },
            { label: '水面 (m)', stroke: '#38bdf8', width: 2, fill: 'rgba(56,189,248,0.25)', spanGaps: false },
          ],
          axes: [axisTheme('沿断面距离 (m)'), axisTheme('高程 (m)', { size: 60 })],
          scales: { x: { time: false } },
          bands: [{ series: [2, 1], fill: 'rgba(56,189,248,0.35)' }],
        }),
        [dist, bed, wse] as uPlot.AlignedData,
      );
    } else if (tab === 'inputs') {
      const d = sc.simulation.duration;
      const n = 300;
      const ts = Array.from({ length: n + 1 }, (_, k) => (k / n) * d);
      const series: uPlot.Series[] = [];
      const data: (number | null)[][] = [ts];
      if (sc.rainfall.enabled) {
        series.push({ label: '雨强 (mm/h)', stroke: '#60a5fa', width: 1.5, fill: 'rgba(96,165,250,0.18)', scale: 'rain', paths: uPlot.paths.stepped!({ align: 1 }) });
        data.push(ts.map((t) => sampleSeries(sc.rainfall.series, t, sc.rainfall.stepwise)));
      }
      sc.sources.forEach((q, i) => {
        series.push({ label: `${q.name} (m³/s)`, stroke: PALETTE[(i + 3) % PALETTE.length], width: 1.8 });
        data.push(ts.map((t) => sampleSeries(q.series, t)));
      });
      for (const side of ['west', 'east', 'south', 'north'] as const) {
        const b = sc.boundaries[side];
        if (b.type === 'level' || b.type === 'tide') {
          series.push({ label: `${{ west: '西', east: '东', south: '南', north: '北' }[side]}边界水位 (m)`, stroke: '#a78bfa', width: 1.5, dash: [5, 3], scale: 'level' });
          data.push(ts.map((t) => boundaryLevel(b, t)));
        }
      }
      if (!series.length) return chart.clear('当前算例没有入流、降雨或水位边界过程。');
      const axes: uPlot.Axis[] = [];
      const scales: uPlot.Scales = {};
      if (series.some((s) => s.scale === 'rain')) {
        axes.push(axisTheme('雨强 (mm/h)', { side: 1, scale: 'rain', size: 55, grid: { show: false } }));
        scales.rain = { auto: true, range: (_u, _min, max) => [0, Math.max(1, max * 1.1)] };
      }
      if (series.some((s) => s.scale === 'level')) {
        axes.push(axisTheme('水位 (m)', { side: 1, scale: 'level', size: 55, grid: { show: false } }));
        scales.level = { auto: true };
      }
      const hasQ = sc.sources.length > 0;
      chart.set(
        `inputs:${series.map((s) => s.label).join(',')}:${sc.startTime ?? ''}:${d}:${JSON.stringify(sc.sources.map((q) => q.series.length))}`,
        () => baseOpts(series, hasQ ? '流量 (m³/s)' : '', axes, scales),
        data as uPlot.AlignedData,
      );
    }
  };

  app.on('records', () => {
    if (tab !== 'profile' && tab !== 'inputs') refresh();
  });
  app.on('frame', () => {
    if (tab === 'profile') refresh();
  });
  app.on('case', () => {
    renderTabs();
    refresh(true);
  });
  app.on('scenario', () => {
    renderTabs();
    refresh(true);
  });
  app.on('selection', () => {
    const sc = app.scenario;
    if (sc && app.selected && sc.sections.some((s) => s.id === app.selected)) {
      profileId = app.selected;
      if (tab === 'profile') {
        renderTabs();
        refresh(true);
      }
    }
  });
  renderTabs();
}

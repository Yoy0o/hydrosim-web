/** Right panel: display settings, live statistics and data attribution. */
import { ROUGH_RANGE, roughColor, type App } from '../app';
import { LANDCOVER_CLASSES } from '../model';
import type { ColorMode, ColormapName, ViewSettings } from '../types';
import { COLORMAPS, COLOR_MODES } from '../viz/colormaps';
import { checkRow, el, fmt, fmtTime, fmtVolume, icon, kids, numRow, row, select, selectRow } from './dom';
import { ICONS } from './icons';

function slider(value: number, min: number, max: number, step: number, onInput: (v: number) => void, fmtFn: (v: number) => string): HTMLElement {
  const out = el('span', { class: 'slider-val' }, fmtFn(value));
  const inp = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), class: 'slider' }) as HTMLInputElement;
  inp.addEventListener('input', () => {
    const v = Number(inp.value);
    out.textContent = fmtFn(v);
    onInput(v);
  });
  return el('span', { class: 'slider-wrap' }, inp, out);
}

/** Legend of the terrain overlay (roughness ramp, land-cover classes or building coverage). */
function overlayLegend(app: App): HTMLElement {
  const mode = app.view.terrainOverlay;
  if (mode === 'roughness') {
    const stops = Array.from({ length: 9 }, (_, k) => {
      const [r, g, b] = roughColor(k / 8);
      return `rgb(${r},${g},${b}) ${((k / 8) * 100).toFixed(1)}%`;
    });
    // ticks at 0.01 / 0.03 / 0.1 / 0.3 are almost evenly spaced on the log scale
    const [lo, hi] = ROUGH_RANGE;
    const ticks = [lo, 0.03, 0.1, hi];
    return el(
      'div',
      { class: 'ov-legend' },
      el('div', { class: 'lg-bar', style: { background: `linear-gradient(to right, ${stops.join(', ')})` } }),
      el('div', { class: 'lg-ticks' }, ...ticks.map((x) => el('span', null, String(x)))),
      el('div', { class: 'muted small' }, app.model?.manning ? '曼宁 n（对数色阶）：土地利用 + 分区 + 建筑物' : `全域均匀 n = ${app.scenario?.manning}`),
    );
  }
  if (mode === 'landcover') {
    const lc = app.aux.landcover;
    if (!lc) return el('div', { class: 'ov-legend muted small' }, '尚未导入土地利用（在左侧"② 糙率与土地利用"中从 OpenStreetMap 导入）');
    const present = new Uint8Array(LANDCOVER_CLASSES.length);
    for (let c = 0; c < lc.cls.length; c++) present[lc.cls[c]] = 1;
    return el(
      'div',
      { class: 'ov-legend lc-legend' },
      ...LANDCOVER_CLASSES.filter((_, k) => k > 0 && present[k]).map((c) => el('span', null, el('i', { class: 'swatch', style: { background: c.color } }), c.label)),
    );
  }
  const cov = app.model?.buildingCover;
  if (!cov) return el('div', { class: 'ov-legend muted small' }, '无建筑物数据（导入 OSM 建筑物或手绘建筑物轮廓）');
  return el(
    'div',
    { class: 'ov-legend' },
    el('div', { class: 'lg-bar', style: { background: 'linear-gradient(to right, rgba(200,70,60,0.08), rgb(200,70,60))' } }),
    el('div', { class: 'lg-ticks' }, el('span', null, '0%'), el('span', null, '50%'), el('span', null, '100%')),
    el('div', { class: 'muted small' }, '网格内建筑物覆盖率（阻水模式下 ≥ 50% 的网格抬高）'),
  );
}

export function buildDisplayPanel(root: HTMLElement, app: App): void {
  const statsBox = el('div', { class: 'stats' });
  const attrBox = el('div', { class: 'attrib' });
  const displayBox = el('div');

  let selfUpdate = false;
  const STRUCTURAL: (keyof ViewSettings)[] = ['colorMode', 'autoRange', 'particles', 'contours', 'basemap', 'colormap', 'terrainOverlay'];
  const renderDisplay = (): void => {
    if (selfUpdate) return;
    const v = app.view;
    const t = app.terrain;
    const set = (p: Partial<ViewSettings>): void => {
      selfUpdate = true;
      try {
        app.setView(p);
      } finally {
        selfUpdate = false;
      }
      if (STRUCTURAL.some((k) => k in p)) renderDisplay();
    };
    const geoOk = t?.georef.kind === 'mercator';
    const info = COLOR_MODES[v.colorMode];
    displayBox.replaceChildren(...kids(
      el('div', { class: 'sub-title' }, '水面着色'),
      selectRow<ColorMode>(
        '着色变量',
        v.colorMode,
        (Object.keys(COLOR_MODES) as ColorMode[]).map((k) => [k, COLOR_MODES[k].label]),
        (m) => set({ colorMode: m }),
      ),
      v.colorMode !== 'realistic'
        ? selectRow<ColormapName>('色带', v.colormap, (Object.keys(COLORMAPS) as ColormapName[]).map((k) => [k, COLORMAPS[k].label]), (c) => set({ colormap: c }))
        : null,
      v.colorMode !== 'realistic' && !info.fixed
        ? el(
            'div',
            null,
            checkRow('自动范围', v.autoRange, (on) => set({ autoRange: on, rangeMin: app.range[0], rangeMax: app.range[1] })),
            !v.autoRange
              ? el(
                  'div',
                  { class: 'range-row' },
                  numRow('最小', v.rangeMin, (x) => set({ rangeMin: x }), { step: 0.1, unit: info.unit }),
                  numRow('最大', v.rangeMax, (x) => set({ rangeMax: x }), { step: 0.1, unit: info.unit }),
                )
              : null,
          )
        : null,
      numRow('显示水深阈值', v.showDepth, (x) => set({ showDepth: Math.max(1e-4, x) }), { unit: 'm', step: 0.005, min: 0.0001, title: '小于该水深的网格不绘制水面' }),
      row('水面不透明度', slider(v.waterOpacity, 0.3, 1, 0.01, (x) => set({ waterOpacity: x }), (x) => x.toFixed(2))),
      el('div', { class: 'sub-title' }, '流场'),
      checkRow('流动粒子', v.particles, (on) => set({ particles: on })),
      v.particles
        ? el(
            'div',
            null,
            row('粒子数量', slider(v.particleCount, 1000, 60000, 1000, (x) => set({ particleCount: x }), (x) => `${(x / 1000).toFixed(0)}k`)),
            row('粒子速度', slider(v.particleSpeed, 0.1, 5, 0.1, (x) => set({ particleSpeed: x }), (x) => `${x.toFixed(1)}×`)),
          )
        : null,
      el('div', { class: 'sub-title' }, '地形'),
      row('垂向夸张', slider(v.exaggeration, 1, 30, 0.5, (x) => set({ exaggeration: x }), (x) => `${x.toFixed(1)}×`)),
      geoOk
        ? selectRow<ViewSettings['basemap']>('地形贴图', v.basemap, [['none', '分层设色'], ['satellite', '卫星影像 (Sentinel-2)'], ['osm', 'OpenStreetMap']], (b) => set({ basemap: b }))
        : null,
      selectRow<ViewSettings['terrainOverlay']>(
        '地形叠加',
        v.terrainOverlay,
        [
          ['none', '无'],
          ['roughness', '曼宁糙率 n'],
          ['landcover', '土地利用类型'],
          ['buildings', '建筑物覆盖率'],
        ],
        (o) => set({ terrainOverlay: o }),
        '在地形上叠加显示模型输入（糙率场、土地利用、建筑物）',
      ),
      v.terrainOverlay !== 'none' ? overlayLegend(app) : null,
      checkRow('等高线', v.contours, (on) => set({ contours: on })),
      v.contours ? numRow('等高距', v.contourInterval, (x) => set({ contourInterval: Math.max(0.01, x) }), { unit: 'm', step: 1, min: 0.01 }) : null,
      checkRow('显示边界条件类型', v.showBoundaries, (on) => set({ showBoundaries: on })),
      el(
        'div',
        { class: 'bc-legend' },
        el('span', null, el('i', { class: 'dot dot-wall' }), '墙'),
        el('span', null, el('i', { class: 'dot dot-open' }), '出流'),
        el('span', null, el('i', { class: 'dot dot-level' }), '水位'),
        el('span', null, el('i', { class: 'dot dot-tide' }), '潮位'),
      ),
    ));
  };

  let lastStats = 0;
  let trailing: number | null = null;
  const renderStats = (force = false): void => {
    const now = performance.now();
    if (!force && now - lastStats < 250) {
      // make sure the last update is eventually shown (trailing call)
      if (trailing === null) trailing = window.setTimeout(() => {
        trailing = null;
        renderStats(true);
      }, 260);
      return;
    }
    lastStats = now;
    const s = app.stats;
    const t = app.terrain;
    if (!s || !t) {
      statsBox.replaceChildren(el('div', { class: 'muted' }, '—'));
      return;
    }
    const cellA = t.dx * t.dy;
    const inputs = s.rain + s.inflow + s.boundaryIn;
    const outputs = s.boundaryOut + s.infiltration;
    const ref = Math.max(s.volume, s.volume0, inputs, 1e-9);
    const relErr = Math.abs(s.massError) / ref;
    const short = (app.scenario?.simulation.duration ?? 0) < 120;
    const kv = (k: string, v: string, cls = ''): HTMLElement => el('div', { class: `kv ${cls}` }, el('span', null, k), el('b', null, v));
    statsBox.replaceChildren(
      kv('仿真时间', fmtTime(s.t, short)),
      kv('时间步 Δt', `${fmt(s.dt, 4)} s`),
      kv('计算步数', s.step.toLocaleString()),
      kv('计算引擎', app.engineInfo ? (app.engineInfo.kind === 'gpu' ? 'GPU · WebGPU' : 'CPU · Worker') : '—', app.engineInfo?.kind === 'gpu' ? 'ok' : ''),
      kv('计算速度', `${fmt(s.stepsPerSec, 0)} 步/s · ${s.simPerSec > 0 ? `${fmt(s.simPerSec, 1)}× 实时` : '—'}`),
      el('div', { class: 'sub-title' }, '水量平衡'),
      kv('当前水量', fmtVolume(s.volume)),
      kv('初始水量', fmtVolume(s.volume0)),
      kv('累计降雨', fmtVolume(s.rain)),
      kv('累计点源入流', fmtVolume(s.inflow)),
      kv('边界流入 / 流出', `${fmtVolume(s.boundaryIn)} / ${fmtVolume(s.boundaryOut)}`),
      kv('累计下渗', fmtVolume(s.infiltration)),
      kv('质量误差', `${fmt(s.massError, 4)} m³ (${relErr < 1e-12 ? '<1e-12' : relErr.toExponential(1)})`, relErr > (s.engine === 'gpu' ? 1e-4 : 1e-6) ? 'warn' : 'ok'),
      el('div', { class: 'sub-title' }, '淹没统计'),
      kv('淹没面积', `${fmt((s.wetCells * cellA) / 1e6, 4)} km²`),
      kv('淹没网格', `${s.wetCells.toLocaleString()} / ${(t.nx * t.ny).toLocaleString()}`),
      kv('最大水深', `${fmt(s.maxH, 3)} m`),
      kv('最大流速', `${fmt(s.maxV, 3)} m/s`),
      kv('结果帧', `${app.frames.frames.length} 帧 · ${fmt(app.frames.memoryMB, 0)} MB`),
      kv('净输入', fmtVolume(inputs - outputs)),
    );
  };

  const renderAttr = (): void => {
    const list = [...app.attribution];
    attrBox.replaceChildren(
      el('div', { class: 'sub-title' }, '数据来源与许可'),
      ...(list.length ? list.map((a) => el('div', { class: 'attr-item' }, a)) : [el('div', { class: 'muted small' }, '内置合成地形（无外部数据）')]),
    );
  };

  const secHead = (title: string, ic: string): HTMLElement => el('div', { class: 'panel-title' }, icon(ic, 16), ` ${title}`);
  root.replaceChildren(secHead('显示', ICONS.layers), el('div', { class: 'pad' }, displayBox), secHead('实时统计', ICONS.chart), el('div', { class: 'pad' }, statsBox), el('div', { class: 'pad' }, attrBox));
  app.on('view', renderDisplay);
  app.on('case', () => {
    renderDisplay();
    renderStats(true);
    renderAttr();
  });
  app.on('frame', () => renderStats());
  app.on('simstate', () => renderStats(true));
  app.on('scenario', renderAttr);
  app.on('view', renderAttr);
  // the overlay legend depends on model inputs (roughness edits, OSM imports)
  app.on('scenario', () => {
    if (app.view.terrainOverlay !== 'none') renderDisplay();
  });
  renderDisplay();
  renderStats(true);
  renderAttr();
  void select;
}

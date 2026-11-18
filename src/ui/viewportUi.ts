/** Overlays on the 3D viewport: tool palette, view buttons, legend, HUD, playback bar, busy overlay, toasts, status bar. */
import type { App, Tool } from '../app';
import { exportScreenshot } from '../io';
import { COLOR_MODES, colormapCss } from '../viz/colormaps';
import { button, el, fmt, fmtTime, icon, kids } from './dom';
import { ICONS } from './icons';
import { LINK_LABEL, STRUCTURE_LABEL } from './structuresPanel';

const TOOLS: [Tool, string, string, string][] = [
  ['navigate', ICONS.navigate, '浏览', '左键平移 · 右键旋转 · 滚轮缩放'],
  ['probe', ICONS.probe, '观测点', '单击地形放置观测点（Esc 退出）'],
  ['section', ICONS.section, '断面', '单击断面起点与终点（Esc 退出）'],
  ['source', ICONS.source, '入流点', '单击放置点源入流（Esc 退出）'],
  ['region', ICONS.region, '水体多边形', '依次单击顶点，双击或回车完成；用于水库/溃坝初始水体'],
  ['roughZone', ICONS.rough, '糙率分区', '依次单击顶点，双击或回车完成；分区内使用指定曼宁系数'],
  ['building', ICONS.building, '建筑物', '依次单击轮廓顶点，双击或回车完成'],
  ['structure', ICONS.levee, '结构线', '依次单击折线顶点，双击或回车完成'],
  ['link', ICONS.link, '涵洞/泵站', '单击进口（取水点），再单击出口（排水点）'],
  ['pour', ICONS.pour, '注水', '按住左键持续注水（交互式试验），松开停止'],
];

/** Tools whose hint shows the number of picked points. */
const POINT_TOOLS: Tool[] = ['region', 'section', 'roughZone', 'building', 'structure', 'link'];

export function buildViewportUi(viewport: HTMLElement, app: App): void {
  // ---------------------------------------------------------------- tool palette
  const palette = el('div', { class: 'vp-tools' });
  const renderTools = (): void => {
    palette.replaceChildren(
      ...TOOLS.map(([k, ic, label, tip]) => {
        const b = button(icon(ic, 18), () => app.setTool(k), `vp-btn ${app.tool === k ? 'active' : ''}`, `${label} — ${tip}`);
        return b;
      }),
    );
  };
  app.on('tool', renderTools);
  renderTools();

  // ---------------------------------------------------------------- view buttons
  const views = el(
    'div',
    { class: 'vp-views' },
    button(icon(ICONS.cube, 18), () => app.viewer.resetCamera('3d'), 'vp-btn', '三维视角'),
    button(icon(ICONS.top, 18), () => app.viewer.resetCamera('top'), 'vp-btn', '俯视（平面图）'),
    button(icon(ICONS.camera, 18), () => exportScreenshot(app), 'vp-btn', '截图 (PNG)'),
  );

  // ---------------------------------------------------------------- tool hint
  const hint = el('div', { class: 'vp-hint' });
  const renderHint = (): void => {
    const t = TOOLS.find(([k]) => k === app.tool)!;
    let label = t[2];
    let txt = t[3];
    if (app.tool === 'pour') txt += `（流量 ${fmt(app.pourRate, 1)} m³/s）`;
    if (app.tool === 'structure') label = `结构线 · ${STRUCTURE_LABEL[app.structureKind]}`;
    if (app.tool === 'link') label = LINK_LABEL[app.linkKind];
    if (POINT_TOOLS.includes(app.tool) && app.draft.length) txt += ` · 已选 ${app.draft.length} 点`;
    hint.replaceChildren(el('b', null, label), ' ', txt);
    hint.classList.toggle('active', app.tool !== 'navigate');
  };
  app.on('tool', renderHint);
  app.on('hover', () => {
    if (POINT_TOOLS.includes(app.tool)) renderHint();
  });
  renderHint();

  // ---------------------------------------------------------------- legend
  const legend = el('div', { class: 'legend' });
  const renderLegend = (): void => {
    const v = app.view;
    const info = COLOR_MODES[v.colorMode];
    if (v.colorMode === 'realistic') {
      legend.replaceChildren(
        el('div', { class: 'lg-title' }, '水深（真实感）'),
        el('div', { class: 'lg-bar', style: { background: 'linear-gradient(to right, rgba(84,158,168,0.45), #0f4c6e 50%, #082a4d)' } }),
        el('div', { class: 'lg-ticks' }, el('span', null, '浅'), el('span', null, '深')),
      );
      return;
    }
    const [lo, hi] = app.range;
    const ticks: HTMLElement[] = [];
    if (v.colormap === 'hazard' && info.fixed) {
      legend.replaceChildren(
        el('div', { class: 'lg-title' }, `${info.label}`),
        el('div', { class: 'lg-bar', style: { background: colormapCss('hazard', 64) } }),
        el('div', { class: 'lg-ticks' }, el('span', null, '低'), el('span', null, '中'), el('span', null, '显著'), el('span', null, '极高')),
        el('div', { class: 'lg-note' }, 'DEFRA 洪水危险度：<0.75 / 0.75–1.25 / 1.25–2 / >2'),
      );
      return;
    }
    for (let k = 0; k <= 4; k++) ticks.push(el('span', null, fmt(lo + ((hi - lo) * k) / 4, hi - lo < 1 ? 2 : hi - lo < 10 ? 1 : 0)));
    legend.replaceChildren(...kids(
      el('div', { class: 'lg-title' }, `${info.label}${info.unit ? ` (${info.unit})` : ''}`),
      el('div', { class: 'lg-bar', style: { background: colormapCss(v.colormap, 32) } }),
      el('div', { class: 'lg-ticks' }, ...ticks),
      info.envelope && !app.envelopes ? el('div', { class: 'lg-note' }, '包络数据计算中…') : null,
    ));
  };
  app.on('view', renderLegend);
  app.on('style', renderLegend);

  // ---------------------------------------------------------------- HUD
  const hud = el('div', { class: 'hud' });
  const renderHud = (): void => {
    const sc = app.scenario;
    const s = app.stats;
    if (!sc) return;
    const shown = app.displayed();
    const t = shown?.t ?? s?.t ?? 0;
    const short = sc.simulation.duration < 120;
    const parts: (HTMLElement | string)[] = [];
    if (sc.startTime) {
      const d = new Date(Date.parse(sc.startTime) + t * 1000);
      parts.push(el('div', { class: 'hud-date' }, `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`));
    }
    parts.push(el('div', { class: 'hud-time' }, `T + ${fmtTime(t, short)}`));
    const mode = app.playbackIndex !== null ? '回放' : app.running ? (app.speed > 0 ? `运行中 · ${app.speed}×` : '运行中 · 最快') : app.finished ? '已完成' : '已暂停';
    parts.push(el('div', { class: `hud-state ${app.running ? 'on' : ''}` }, mode));
    hud.replaceChildren(...parts);
  };
  let lastHud = 0;
  app.on('frame', () => {
    const now = performance.now();
    if (now - lastHud > 100) {
      lastHud = now;
      renderHud();
    }
  });
  app.on('simstate', renderHud);
  app.on('playback', renderHud);
  app.on('case', renderHud);

  // ---------------------------------------------------------------- playback bar
  const slider = el('input', { type: 'range', min: '0', max: '0', step: '1', value: '0', class: 'pb-slider' }) as HTMLInputElement;
  const pbLabel = el('span', { class: 'pb-label' });
  const liveBtn = button(el('span', null, icon(ICONS.live, 14), ' 实时'), () => app.setPlayback(null), 'btn small pb-live', '返回实时计算结果');
  let anim: number | null = null;
  const playBtn = button(icon(ICONS.play, 14), () => {
    if (anim !== null) {
      cancelAnimationFrame(anim);
      anim = null;
      playBtn.replaceChildren(icon(ICONS.play, 14));
      return;
    }
    const n = app.frames.frames.length;
    if (n < 2) return;
    let k = app.playbackIndex ?? 0;
    if (k >= n - 1) k = 0;
    let acc = 0;
    let lastT = performance.now();
    const fps = 12;
    const loop = (now: number): void => {
      acc += (now - lastT) / 1000;
      lastT = now;
      if (acc >= 1 / fps) {
        acc = 0;
        k++;
        if (k >= app.frames.frames.length) {
          anim = null;
          playBtn.replaceChildren(icon(ICONS.play, 14));
          return;
        }
        app.setPlayback(k);
      }
      anim = requestAnimationFrame(loop);
    };
    playBtn.replaceChildren(icon(ICONS.pause, 14));
    app.setPlayback(k);
    anim = requestAnimationFrame(loop);
  }, 'icon-btn', '播放结果动画');
  slider.addEventListener('input', () => app.setPlayback(Number(slider.value)));
  const pbar = el('div', { class: 'playback' }, playBtn, el('span', { class: 'pb-title' }, '结果回放'), slider, pbLabel, liveBtn);
  const renderPb = (): void => {
    const n = app.frames.frames.length;
    slider.max = String(Math.max(0, n - 1));
    if (app.playbackIndex !== null) slider.value = String(app.playbackIndex);
    else slider.value = String(Math.max(0, n - 1));
    const short = (app.scenario?.simulation.duration ?? 0) < 120;
    const f = app.playbackIndex !== null ? app.frames.frames[app.playbackIndex] : null;
    pbLabel.textContent = f ? `${fmtTime(f.t, short)}（${app.playbackIndex! + 1}/${n}）` : `${n} 帧`;
    liveBtn.classList.toggle('on', app.playbackIndex === null);
    pbar.classList.toggle('hidden', n < 2);
  };
  app.on('playback', renderPb);
  app.on('case', renderPb);

  // ---------------------------------------------------------------- busy overlay
  const busy = el('div', { class: 'busy hidden' });
  app.on('busy', () => {
    const b = app.busy;
    busy.classList.toggle('hidden', !b);
    if (b) busy.replaceChildren(el('div', { class: 'busy-card' }, el('div', { class: 'spinner' }), el('div', null, b.msg), el('div', { class: 'busy-prog' }, el('div', { style: { width: `${Math.round(b.frac * 100)}%` } }))));
  });

  viewport.append(palette, views, hint, legend, hud, pbar, busy);
  renderLegend();
  renderPb();
}

export function buildToasts(app: App): void {
  const box = el('div', { class: 'toasts' });
  document.body.append(box);
  let progressEl: HTMLElement | null = null;
  app.on('message', (arg) => {
    const { msg, kind } = arg as { msg: string; kind: string };
    if (kind === 'progress') {
      if (!progressEl) {
        progressEl = el('div', { class: 'toast info' });
        box.append(progressEl);
      }
      progressEl.textContent = msg;
      const me = progressEl;
      clearTimeout((me as unknown as { _t?: number })._t);
      (me as unknown as { _t?: number })._t = window.setTimeout(() => {
        me.remove();
        if (progressEl === me) progressEl = null;
      }, 1500);
      return;
    }
    const t = el('div', { class: `toast ${kind}` }, msg);
    box.append(t);
    setTimeout(() => t.classList.add('out'), kind === 'error' ? 7000 : 4200);
    setTimeout(() => t.remove(), kind === 'error' ? 7600 : 4800);
  });
}

export function buildStatusbar(root: HTMLElement, app: App): void {
  const cursor = el('span', { class: 'sb-cursor' });
  const grid = el('span', { class: 'sb-grid' });
  const perf = el('span', { class: 'sb-perf' });
  root.append(cursor, grid, perf);
  app.on('hover', () => {
    const h = app.hover;
    if (!h) {
      cursor.textContent = '将鼠标移到地形上查看读数';
      return;
    }
    const spd = Math.hypot(h.u, h.v);
    const wet = h.h >= 1e-3;
    const parts = [
      h.lat !== undefined ? `${h.lat.toFixed(5)}°N ${h.lon!.toFixed(5)}°E` : `x ${fmt(h.x, 1)} m  y ${fmt(h.y, 1)} m`,
      `地面 ${fmt(h.z, 2)} m`,
      wet ? `水深 ${fmt(h.h, 3)} m` : '干',
      wet ? `水位 ${fmt(h.z + h.h, 2)} m` : '',
      wet ? `流速 ${fmt(spd, 2)} m/s` : '',
      wet ? `Fr ${fmt(spd / Math.sqrt(9.81 * Math.max(h.h, 1e-6)), 2)}` : '',
    ].filter(Boolean);
    cursor.textContent = parts.join('  ·  ');
  });
  const renderGrid = (): void => {
    const t = app.terrain;
    grid.textContent = t ? `网格 ${t.nx}×${t.ny} · Δx ${fmt(t.dx, 2)} m · ${app.scenario?.simulation.order === 2 ? '二阶' : '一阶'}` : '';
  };
  app.on('case', renderGrid);
  app.on('scenario', renderGrid);
  setInterval(() => {
    const s = app.stats;
    const eng = app.engineInfo ? (app.engineInfo.kind === 'gpu' ? 'GPU' : 'CPU') : '…';
    perf.textContent = `渲染 ${app.viewer.fps.toFixed(0)} fps · ${eng} 计算 ${s ? fmt(s.stepsPerSec, 0) : '0'} 步/s`;
  }, 500);
  cursor.textContent = '将鼠标移到地形上查看读数';
}

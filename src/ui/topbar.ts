import type { App } from '../app';
import { PRESETS } from '../data/presets';
import { GRID_EXPORTS, exportBalanceCsv, exportGrid, exportProbesCsv, exportScreenshot, exportSectionsCsv, importAsc, openProject, saveProject } from '../io';
import { button, el, fmtTime, icon, modal, numRow, pickFile } from './dom';
import { ICONS } from './icons';
import { openMapPicker } from './mapPicker';
import { openDocs } from './docViewer';
import { openVerify } from './verifyDialog';

const SPEEDS: [number, string][] = [
  [0, '最快'],
  [1, '实时 1×'],
  [10, '10×'],
  [60, '60×'],
  [300, '300×'],
  [1800, '1800×'],
  [7200, '7200×'],
];

function dropdown(label: HTMLElement | string, items: (HTMLElement | null)[], cls = 'btn ghost'): HTMLElement {
  const menu = el('div', { class: 'menu' }, ...items);
  const wrap = el('div', { class: 'dropdown' });
  const b = button(label, (e) => {
    e.stopPropagation();
    const open = wrap.classList.toggle('open');
    if (open) {
      const close = (ev: MouseEvent): void => {
        if (!wrap.contains(ev.target as Node) || (ev.target as HTMLElement).closest('.menu-item')) {
          wrap.classList.remove('open');
          window.removeEventListener('mousedown', close, true);
        }
      };
      setTimeout(() => window.addEventListener('mousedown', close, true));
    }
  }, cls);
  wrap.append(b, menu);
  menu.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.menu-item')) wrap.classList.remove('open');
  });
  return wrap;
}

function menuItem(label: string, onClick: () => void, sub?: string): HTMLElement {
  return el('button', { class: 'menu-item', type: 'button', onclick: onClick }, el('span', null, label), sub ? el('small', null, sub) : null);
}

export function buildTopbar(root: HTMLElement, app: App): void {
  const presetItems: HTMLElement[] = [];
  for (const g of ['基准验证', '合成场景', '真实地形'] as const) {
    presetItems.push(el('div', { class: 'menu-group' }, g));
    for (const p of PRESETS.filter((x) => x.group === g)) {
      const it = menuItem(p.name, () => void app.loadPreset(p.id));
      it.title = p.description;
      presetItems.push(it);
    }
  }
  const exportItems: HTMLElement[] = [
    menuItem('视图截图 (PNG)', () => exportScreenshot(app)),
    menuItem('观测点时程 (CSV)', () => exportProbesCsv(app)),
    menuItem('断面流量 (CSV)', () => exportSectionsCsv(app)),
    menuItem('水量平衡 (CSV)', () => exportBalanceCsv(app)),
    el('div', { class: 'menu-group' }, 'ESRI ASCII 栅格 (.asc)'),
    ...GRID_EXPORTS.map(([k, label]) => menuItem(label, () => exportGrid(app, k))),
  ];

  const ascImport = async (): Promise<void> => {
    const f = await pickFile('.asc,.txt');
    if (!f) return;
    let cells = 384;
    const body = el(
      'div',
      null,
      el('p', { class: 'muted' }, `文件：${f.name}（${(f.size / 1048576).toFixed(1)} MB）。若栅格过大，将按块平均降采样到下面的最大网格数。无数据 (NODATA) 网格按高地（不过水）处理。`),
      numRow('长边最大网格数', cells, (v) => (cells = Math.round(v)), { min: 32, max: app.gpuAvailable ? 2048 : 1024, step: 32, title: app.gpuAvailable ? 'GPU 引擎可流畅计算约 100 万网格' : undefined }),
    );
    const close = modal('导入 DEM（ESRI ASCII Grid）', body, {
      width: '460px',
      footer: el(
        'div',
        { class: 'foot-btns' },
        button('取消', () => close(), 'btn ghost'),
        button('导入', () => {
          close();
          importAsc(app, f, cells).catch((err) => app.toast(`导入失败：${(err as Error).message}`, 'error'));
        }, 'btn primary'),
      ),
    });
  };

  const playBtn = button(icon(ICONS.play), () => app.toggleRun(), 'tb-btn run', '运行 / 暂停（空格键）');
  const stepBtn = button(icon(ICONS.step), () => app.step(1), 'tb-btn', '单步计算');
  const resetBtn = button(icon(ICONS.reset), () => app.reset(), 'tb-btn', '重置到初始状态');
  const speedSel = el('select', { class: 'sel speed', title: '仿真速度（仿真秒/墙钟秒）' }) as HTMLSelectElement;
  for (const [v, l] of SPEEDS) speedSel.append(el('option', { value: String(v) }, l));
  speedSel.addEventListener('change', () => app.setSpeed(Number(speedSel.value)));
  const timeTxt = el('div', { class: 'tb-time' });
  const prog = el('div', { class: 'tb-prog' }, el('div', { class: 'tb-prog-bar' }));
  const caseName = el('div', { class: 'tb-case' });
  const engBadge = el('span', { class: 'eng-badge' }, '…');
  const renderEngine = (): void => {
    const e = app.engineInfo;
    engBadge.textContent = e ? (e.kind === 'gpu' ? 'GPU' : 'CPU') : '…';
    engBadge.className = `eng-badge ${e?.kind ?? ''}`;
    engBadge.title = e ? `计算引擎：${e.label}${e.note ? `；${e.note}` : ''}` : '正在初始化计算引擎';
  };
  app.on('engine', renderEngine);

  root.append(
    el(
      'div',
      { class: 'tb-brand' },
      el('span', { class: 'logo' }, icon(ICONS.logo, 24)),
      el('div', null, el('div', { class: 'brand-name' }, 'HydroSim Web'), el('div', { class: 'brand-sub' }, '二维水动力仿真平台 · MVP')),
    ),
    el(
      'div',
      { class: 'tb-menus' },
      dropdown(el('span', null, icon(ICONS.layers, 16), ' 算例'), presetItems),
      button(el('span', null, icon(ICONS.globe, 16), ' 在线地形'), () => openMapPicker(app), 'btn ghost', '从开放 DEM（AWS Terrain Tiles）按地图选区加载地形'),
      button(el('span', null, icon(ICONS.upload, 16), ' 导入 DEM'), () => void ascImport(), 'btn ghost', '导入 ESRI ASCII Grid (.asc) 地形'),
      button(el('span', null, icon(ICONS.open, 16), ' 打开'), async () => {
        const f = await pickFile('.json');
        if (f) openProject(app, f).catch((err) => app.toast(`打开失败：${(err as Error).message}`, 'error'));
      }, 'btn ghost', '打开工程文件 (.hydrosim.json)'),
      button(el('span', null, icon(ICONS.save, 16), ' 保存'), () => saveProject(app), 'btn ghost', '保存工程（含地形与全部设置）'),
      dropdown(el('span', null, icon(ICONS.download, 16), ' 导出'), exportItems),
      dropdown(el('span', null, icon(ICONS.help, 16), ' 帮助'), [
        menuItem('算法与实现文档', () => void openDocs(), '控制方程、离散格式、边界条件、源项、GPU 实现与代码位置'),
        menuItem('算法核验', () => openVerify(), '解析解对比、守恒性与 GPU 一致性，在后台线程运行'),
        el('div', { class: 'menu-group' }, '常用章节'),
        menuItem('§3 数值通量（HLL）', () => void openDocs('s3')),
        menuItem('§4 静水重构与底坡源项', () => void openDocs('s4')),
        menuItem('§7 科氏力与风应力', () => void openDocs('s7')),
        menuItem('§8 边界条件', () => void openDocs('s8')),
        menuItem('§15 核验清单', () => void openDocs('s15')),
        menuItem('§16 算法审查与改进记录', () => void openDocs('s16')),
      ]),
    ),
    caseName,
    el('div', { class: 'tb-run' }, playBtn, stepBtn, resetBtn, speedSel, engBadge, el('div', { class: 'tb-timebox' }, timeTxt, prog)),
  );

  const refresh = (): void => {
    const running = app.running;
    playBtn.replaceChildren(icon(running ? ICONS.pause : ICONS.play));
    playBtn.classList.toggle('active', running);
    speedSel.value = String(app.speed);
    const dur = app.scenario?.simulation.duration ?? 0;
    const t = app.playbackIndex !== null ? (app.displayed()?.t ?? 0) : (app.stats?.t ?? 0);
    const short = dur < 120;
    let txt = `${fmtTime(t, short)} / ${fmtTime(dur, short)}`;
    if (app.scenario?.startTime) {
      const d = new Date(Date.parse(app.scenario.startTime) + t * 1000);
      txt = `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${txt}`;
    }
    if (app.playbackIndex !== null) txt = `回放 ${txt}`;
    timeTxt.textContent = txt;
    (prog.firstChild as HTMLElement).style.width = `${dur > 0 ? Math.min(100, (100 * t) / dur) : 0}%`;
    caseName.textContent = app.scenario?.name ?? '';
    caseName.title = app.scenario?.description ?? '';
  };
  app.on('simstate', refresh);
  app.on('frame', refresh);
  app.on('scenario', refresh);
  app.on('case', refresh);
  app.on('playback', refresh);
  refresh();
}

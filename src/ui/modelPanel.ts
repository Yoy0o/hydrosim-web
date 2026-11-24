/** Left panel: model setup tree (terrain, roughness, structures, boundaries, initial conditions, sources, Coriolis/wind, numerics, observers). */
import type { App, ChangeKind } from '../app';
import { coriolisParameter, windDragCoefficient, type BoundarySpec, type Side } from '../core/solver';
import { integrateSeries, seriesMax, triangularHydrograph, type TimeSeries } from '../core/timeseries';
import { cosLatOf, localToLonLat } from '../data/geo';
import { dischargeSeriesFromDaily, fetchDailyDischarge, fetchHourlyRain, rainSeriesFromHourly } from '../data/openmeteo';
import type { Scenario, SourceDef } from '../types';
import type { EnginePref } from '../worker/protocol';
import { button, checkRow, el, fmt, fmtVolume, icon, numInput, numRow, row, select, selectRow } from './dom';
import { ICONS } from './icons';
import { openMapPicker } from './mapPicker';
import { docLink, section, seriesEditor, timeUnit, toolBtn } from './panelKit';
import { openVerify } from './verifyDialog';
import { roughnessSection, structuresSection } from './structuresPanel';

export { timeUnit };

const SIDE_LABEL: Record<Side, string> = { west: '西边界 (W)', east: '东边界 (E)', south: '南边界 (S)', north: '北边界 (N)' };
const BC_TYPES: [BoundarySpec['type'], string][] = [
  ['wall', '闭边界（墙）'],
  ['open', '自由出流'],
  ['level', '水位过程'],
  ['tide', '正弦潮位'],
  ['ocean', '外海开边界（水位+流速）'],
];

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

export function buildModelPanel(root: HTMLElement, app: App): void {
  const open = new Set<string>(['case', 'terrain', 'bc', 'src', 'sim']);
  const render = (): void => {
    const s = app.scenario;
    const t = app.terrain;
    const scroll = root.scrollTop;
    if (!s || !t) {
      root.replaceChildren(el('div', { class: 'panel-title' }, '模型设置'), el('p', { class: 'muted pad' }, '正在加载…'));
      return;
    }
    const unit = timeUnit(s.simulation.duration);
    const geo = t.georef;
    const lonlat = (x: number, y: number): string => {
      if (geo.kind !== 'mercator') return '';
      const [lo, la] = localToLonLat(x, y, geo, cosLatOf(geo));
      return `${la.toFixed(4)}°N, ${lo.toFixed(4)}°E`;
    };

    // ---------------------------------------------------------------- case
    const caseSec = section(
      'case',
      '算例说明',
      open,
      render,
      null,
      el('div', { class: 'case-name' }, s.name),
      el('p', { class: 'case-desc' }, s.description),
    );

    // ---------------------------------------------------------------- terrain
    const srcLabel = { synthetic: '内置合成地形', terrarium: '开放 DEM · AWS Terrain Tiles', asc: 'ESRI ASCII Grid 导入', bundled: '内置开放 DEM（离线）' }[t.source];
    const { zMin, zMax } = app.terrainStats();
    const kv = (k: string, v: string): HTMLElement => el('div', { class: 'kv' }, el('span', null, k), el('b', null, v));
    const terrainSec = section(
      'terrain',
      '① 地形与网格',
      open,
      render,
      `${t.nx}×${t.ny}`,
      kv('名称', t.name),
      kv('来源', srcLabel),
      kv('网格', `${t.nx} × ${t.ny} = ${(t.nx * t.ny).toLocaleString()} 单元`),
      kv('单元尺寸', `${fmt(t.dx, 2)} × ${fmt(t.dy, 2)} m`),
      kv('范围', `${fmt((t.nx * t.dx) / 1000, 2)} × ${fmt((t.ny * t.dy) / 1000, 2)} km`),
      kv('高程', `${fmt(zMin, 1)} ~ ${fmt(zMax, 1)} m`),
      geo.kind === 'mercator'
        ? kv('经纬度', `${geo.south.toFixed(3)}~${geo.north.toFixed(3)}°N, ${geo.west.toFixed(3)}~${geo.east.toFixed(3)}°E`)
        : geo.kind === 'projected'
          ? kv('坐标原点', `${fmt(geo.xll, 1)}, ${fmt(geo.yll, 1)}`)
          : kv('坐标', '局部坐标（原点为西南角）'),
      el('div', { class: 'btn-row' }, button(el('span', null, icon(ICONS.globe, 15), ' 在线地形…'), () => openMapPicker(app), 'btn small')),
      fillTool(app),
    );

    // ---------------------------------------------------------------- roughness, buildings, structures
    const roughSec = roughnessSection(app, open, render);
    const structSec = structuresSection(app, open, render);

    // ---------------------------------------------------------------- boundaries
    const bcRows: HTMLElement[] = [];
    for (const side of ['west', 'east', 'south', 'north'] as Side[]) {
      const b = s.boundaries[side];
      const setB = (nb: BoundarySpec): void => app.update('params', (sc) => (sc.boundaries[side] = nb));
      const typeSel = select(b.type, BC_TYPES, (v) => {
        const seaLevel = zMin < 0 ? 0 : Math.round((zMin + (zMax - zMin) * 0.1) * 10) / 10;
        const tide = b.type === 'tide' || b.type === 'ocean' ? b : { mean: seaLevel, amplitude: 0, period: 12.42 * 3600, phase: 0 };
        if (v === 'wall' || v === 'open') setB({ type: v });
        else if (v === 'level') setB({ type: 'level', series: [[0, seaLevel]] });
        else if (v === 'tide') setB({ type: 'tide', mean: tide.mean, amplitude: tide.amplitude || 1, period: tide.period, phase: tide.phase });
        else setB({ type: 'ocean', mean: tide.mean, amplitude: tide.amplitude, period: tide.period, phase: tide.phase, u: 0, v: 0 });
      });
      const box = el('div', { class: `bc-row bc-${b.type}` }, el('div', { class: 'bc-head' }, el('span', { class: `dot dot-${b.type}` }), el('span', null, SIDE_LABEL[side]), typeSel));
      if (b.type === 'level') {
        box.append(
          el('div', { class: 'muted small' }, '外部水位（单值即恒定水位）。低于地形处该边界不进水。'),
          seriesEditor(b.series, unit, '水位 (m)', (ser) => setB({ type: 'level', series: ser }), 3),
        );
      } else if (b.type === 'tide' || b.type === 'ocean') {
        box.append(
          numRow('平均水位', b.mean, (v) => setB({ ...b, mean: v }), { unit: 'm', step: 0.1 }),
          numRow(b.type === 'ocean' ? '潮汐振幅' : '振幅', b.amplitude, (v) => setB({ ...b, amplitude: v }), { unit: 'm', step: 0.1, min: 0 }),
          numRow('周期', b.period / 3600, (v) => setB({ ...b, period: Math.max(0.01, v) * 3600 }), { unit: 'h', step: 0.01, digits: 3 }),
          numRow('初相位', b.phase, (v) => setB({ ...b, phase: v }), { unit: '°', step: 5 }),
        );
        if (b.type === 'ocean') {
          box.append(
            numRow('外海流速 u（东向）', b.u, (v) => setB({ ...b, u: v }), { unit: 'm/s', step: 0.05, digits: 3 }),
            numRow('外海流速 v（北向）', b.v, (v) => setB({ ...b, v: v }), { unit: 'm/s', step: 0.05, digits: 3 }),
            el(
              'div',
              { class: 'muted small' },
              '外海水位与流速作为边界外侧的远场状态，由边界黎曼解区分入流与出流，向外传播的波动可无反射离开计算域；启用科氏力时边界水位按外海流的地转平衡倾斜。',
            ),
          );
        }
      }
      bcRows.push(box);
    }
    const bcSec = section(
      'bc',
      '④ 边界条件',
      open,
      render,
      null,
      ...bcRows,
      docLink('s8', '边界条件的算法与实现'),
    );

    // ---------------------------------------------------------------- initial conditions
    const ic = s.initial;
    const regionRows = ic.regions.map((r) =>
      el(
        'div',
        { class: `item ${app.selected === r.id ? 'sel' : ''}`, onclick: () => app.select(r.id) },
        el('input', {
          class: 'txt name',
          value: r.name,
          onchange: (e: Event) => app.update('markers', () => (r.name = (e.target as HTMLInputElement).value)),
        }),
        el('span', { class: 'muted small' }, '水位'),
        numInput(r.level, (v) => app.update('initial', () => (r.level = v)), { step: 0.1, digits: 2 }),
        el('span', { class: 'unit' }, 'm'),
        button(icon(ICONS.trash, 14), (e) => {
          e.stopPropagation();
          app.update('initial', (sc) => (sc.initial.regions = sc.initial.regions.filter((x) => x.id !== r.id)));
        }, 'icon-btn', '删除'),
      ),
    );
    const baseOn = ic.baseLevel !== null;
    const vel = ic.velocity ?? { u: 0, v: 0 };
    const setVel = (u: number, v: number): void =>
      app.update('initial', (sc) => {
        if (u === 0 && v === 0) delete sc.initial.velocity;
        else sc.initial.velocity = { u, v };
      });
    const icSec = section(
      'ic',
      '⑤ 初始条件',
      open,
      render,
      ic.regions.length ? `${ic.regions.length} 水体` : null,
      checkRow('全域初始水位（低于该水位的网格充水）', baseOn, (on) => app.update('initial', (sc) => (sc.initial.baseLevel = on ? Math.round(zMin + 1) : null))),
      baseOn ? numRow('初始水位', ic.baseLevel!, (v) => app.update('initial', (sc) => (sc.initial.baseLevel = v)), { unit: 'm', step: 0.1 }) : null,
      el('div', { class: 'sub-title' }, '水体多边形（水库 / 溃坝上游）'),
      ...regionRows,
      el(
        'div',
        { class: 'btn-row' },
        toolBtn(app, 'region', '绘制水体多边形', ICONS.region),
      ),
      app.tool === 'region' ? el('div', { class: 'tip' }, '在视图中依次单击顶点，双击或回车结束；Esc 取消。') : null,
      el('div', { class: 'sub-title' }, '初始流速（所有湿网格均匀）'),
      numRow('u（东向）', vel.u, (v) => setVel(v, vel.v), { unit: 'm/s', step: 0.05, digits: 3 }),
      numRow('v（北向）', vel.v, (v) => setVel(vel.u, v), { unit: 'm/s', step: 0.05, digits: 3 }),
      s.physics?.coriolis && (vel.u !== 0 || vel.v !== 0)
        ? el('div', { class: 'muted small' }, '已启用科氏力：全域初始水位按该流速的地转平衡倾斜（g∂η/∂y = −f·u，g∂η/∂x = f·v），避免启动时激发惯性振荡。')
        : null,
      el('div', { class: 'muted small' }, '注意：修改初始条件将重置模拟。'),
      docLink('s14', '初始条件的算法与实现'),
    );

    // ---------------------------------------------------------------- sources & rain
    const srcCards = s.sources.map((q) => sourceCard(app, q, unit, lonlat));
    const rf = s.rainfall;
    const totalRain = integrateSeries(rf.series, 0, s.simulation.duration, rf.stepwise);
    const rainBox = el(
      'div',
      { class: 'rain-box' },
      checkRow('启用降雨（面雨，全域均匀）', rf.enabled, (on) => app.update('params', (sc) => (sc.rainfall.enabled = on))),
      rf.enabled
        ? el(
            'div',
            null,
            seriesEditor(rf.series, unit, '雨强 (mm/h)', (ser) => app.update('params', (sc) => {
              sc.rainfall.series = ser;
              sc.rainfall.origin = '手动输入';
            }), 4),
            checkRow('阶梯过程（时段内雨强恒定，如逐时数据）', rf.stepwise, (on) => app.update('params', (sc) => (sc.rainfall.stepwise = on))),
            numRow('下渗率（恒定）', rf.infiltration, (v) => app.update('params', (sc) => (sc.rainfall.infiltration = v)), { min: 0, step: 0.5, unit: 'mm/h' }),
            el('div', { class: 'summary' }, `模拟时段内总雨量 ${fmt(totalRain / 3600, 1)} mm · 峰值雨强 ${fmt(seriesMax(rf.series), 1)} mm/h`),
            rf.origin ? el('div', { class: 'muted small' }, `来源：${rf.origin}`) : null,
            rainTools(app, s),
          )
        : null,
    );
    const srcSec = section(
      'src',
      '⑥ 源汇项（入流 / 降雨）',
      open,
      render,
      `${s.sources.length} 入流${rf.enabled ? ' · 降雨' : ''}`,
      el('div', { class: 'sub-title' }, '点源入流（流量过程线 Q(t)）'),
      ...srcCards,
      el('div', { class: 'btn-row' }, toolBtn(app, 'source', '放置入流点', ICONS.source)),
      app.tool === 'source' ? el('div', { class: 'tip' }, '在视图中单击河道位置放置入流点。') : null,
      el('div', { class: 'sub-title' }, '降雨'),
      rainBox,
      docLink('s9', '源汇项的算法与实现'),
    );

    // ---------------------------------------------------------------- Coriolis & wind
    const ph = s.physics!;
    const fCor = coriolisParameter(ph.latitude);
    const wind = ph.wind;
    const windConst = wind.speed.length === 1;
    const wMax = seriesMax(wind.speed);
    const cdMax = windDragCoefficient(wMax);
    /** With an initial current the Coriolis setting also tilts the initial surface: reset in that case. */
    const physKind = (): ChangeKind => (s.initial.velocity && (s.initial.velocity.u !== 0 || s.initial.velocity.v !== 0) ? 'initial' : 'params');
    const physSec = section(
      'phys',
      '⑦ 科氏力与风场',
      open,
      render,
      [ph.coriolis ? `${fmt(ph.latitude, 1)}°` : null, wind.enabled ? `风 ${fmt(wMax, 1)} m/s` : null].filter(Boolean).join(' · ') || null,
      checkRow('科氏力（f 平面近似）', ph.coriolis, (on) => app.update(physKind(), (sc) => (sc.physics!.coriolis = on))),
      numRow('纬度', ph.latitude, (v) => app.update(physKind(), (sc) => (sc.physics!.latitude = Math.max(-90, Math.min(90, v)))), {
        unit: '°N',
        step: 1,
        digits: 3,
        title: '南半球为负值；地理坐标地形默认取区域中心纬度',
      }),
      el(
        'div',
        { class: 'summary' },
        `f = 2Ω·sinφ = ${fCor.toExponential(3)} s⁻¹${fCor !== 0 ? ` · 惯性周期 ${fmt((2 * Math.PI) / Math.abs(fCor) / 3600, 1)} h` : ''}`,
      ),
      el('div', { class: 'muted small' }, '空间尺度大于约 10 km 或历时超过数小时的海洋、河口与大型湖泊过程需考虑科氏力；河道与城市洪水通常可忽略。'),
      el('div', { class: 'sub-title' }, '风应力（全域均匀风场）'),
      checkRow('启用风应力', wind.enabled, (on) => app.update('params', (sc) => (sc.physics!.wind.enabled = on))),
      wind.enabled
        ? el(
            'div',
            { class: 'rain-box' },
            row(
              '风速',
              select(windConst ? 'const' : 'series', [['const', '恒定'], ['series', '过程线']], (v) =>
                app.update('params', (sc) => {
                  const d = sc.simulation.duration;
                  sc.physics!.wind.speed = v === 'const' ? [[0, wMax]] : [[0, 0], [0.25 * d, wMax], [d, wMax]];
                }),
              ),
            ),
            windConst
              ? numRow('10 m 风速', wind.speed[0][1], (v) => app.update('params', (sc) => (sc.physics!.wind.speed = [[0, Math.max(0, v)]])), { unit: 'm/s', min: 0, step: 1 })
              : seriesEditor(wind.speed, unit, '风速 (m/s)', (ser) => app.update('params', (sc) => (sc.physics!.wind.speed = ser)), 4),
            numRow('风向（来向）', wind.direction, (v) => app.update('params', (sc) => (sc.physics!.wind.direction = ((v % 360) + 360) % 360)), {
              unit: '°',
              step: 15,
              title: '风吹来的方向，从正北顺时针：0 北风，90 东风，180 南风，270 西风',
            }),
            el('div', { class: 'summary' }, `Cd = ${(cdMax * 1000).toFixed(2)}×10⁻³（Wu 1982）· 最大风应力 τ = ${fmt(1.225 * cdMax * wMax * wMax, 3)} Pa`),
          )
        : null,
      numRow('水体密度', ph.waterDensity, (v) => app.update('params', (sc) => (sc.physics!.waterDensity = Math.max(900, Math.min(1100, v)))), {
        unit: 'kg/m³',
        step: 5,
        title: '淡水 1000，海水约 1025；影响风应力与底床剪切应力',
      }),
      docLink('s7', '科氏力与风应力的算法与实现'),
    );

    // ---------------------------------------------------------------- numerics
    const sim = s.simulation;
    const durUnit = timeUnit(sim.duration);
    const simSec = section(
      'sim',
      '⑧ 计算设置',
      open,
      render,
      `${sim.order === 2 ? '二阶' : '一阶'} · ${app.engineInfo ? (app.engineInfo.kind === 'gpu' ? 'GPU' : 'CPU') : '…'}`,
      selectRow<EnginePref>(
        '计算引擎',
        sim.engine ?? 'auto',
        [
          ['auto', '自动（优先 GPU）'],
          ['gpu', 'GPU · WebGPU'],
          ['cpu', 'CPU · Web Worker'],
        ],
        (v) => app.setEngine(v),
        '切换引擎会从初始状态重新开始计算',
      ),
      el(
        'div',
        { class: `engine-info ${app.engineInfo?.kind ?? ''}` },
        app.engineInfo ? app.engineInfo.label : '正在初始化计算引擎…',
        app.engineInfo?.kind === 'gpu' ? el('div', { class: 'muted small' }, '单精度（f32）GPU 计算：与 CPU 双精度结果一致到毫米级，质量相对误差约 1e-7~1e-5。') : null,
        !app.gpuAvailable ? el('div', { class: 'muted small' }, '此浏览器未开放 WebGPU（需 Chrome/Edge 113+、Firefox 141+ 或 Safari 26+）。') : null,
      ),
      numRow(`模拟时长`, sim.duration / durUnit.f, (v) => app.update('settings', (sc) => (sc.simulation.duration = Math.max(0.01, v) * durUnit.f)), {
        unit: durUnit.label,
        min: 0,
        step: 0.1,
        digits: 3,
      }),
      numRow('结果输出间隔', sim.outputInterval, (v) => app.update('settings', (sc) => (sc.simulation.outputInterval = Math.max(1e-3, v))), {
        unit: 's',
        min: 0.001,
        step: 1,
        title: '按该间隔记录结果帧用于时间轴回放',
      }),
      selectRow<'1' | '2'>('数值格式', String(sim.order) as '1' | '2', [['1', '一阶 Godunov（快速稳健）'], ['2', '二阶 MUSCL + Heun（更精确）']], (v) =>
        app.update('params', (sc) => (sc.simulation.order = Number(v) as 1 | 2)),
      ),
      numRow('CFL 数', sim.cfl, (v) => app.update('params', (sc) => (sc.simulation.cfl = v)), { min: 0.05, max: 0.95, step: 0.05 }),
      numRow('最大时间步', sim.maxDt, (v) => app.update('params', (sc) => (sc.simulation.maxDt = v)), { unit: 's', min: 0.001, step: 1 }),
      numRow('干湿阈值', sim.hDry, (v) => app.update('params', (sc) => (sc.simulation.hDry = v)), { unit: 'm', min: 1e-9, step: 1e-6 }),
      numRow('淹没判定水深', sim.arrivalDepth, (v) => app.update('params', (sc) => (sc.simulation.arrivalDepth = v)), {
        unit: 'm',
        min: 0.001,
        step: 0.01,
        title: '用于淹没面积与到达时间统计',
      }),
      el('div', { class: 'muted small' }, '有限体积 HLL 黎曼求解器 + Chen–Noelle 静水重构；隐式曼宁摩阻；CFL 自适应时间步。'),
      el(
        'div',
        { class: 'doc-links' },
        docLink('s3', '数值通量'),
        docLink('s4', '静水重构'),
        docLink('s5', '二阶格式'),
        docLink('s10', '时间步与干湿'),
        docLink('s12', 'GPU 实现'),
      ),
      button(el('span', null, icon(ICONS.check, 15), ' 运行算法核验…'), () => openVerify(), 'btn small', '在后台线程运行全部算法核验算例（解析解对比、守恒性、GPU 一致性）'),
    );

    // ---------------------------------------------------------------- observers
    const probeRows = s.probes.map((p) =>
      el(
        'div',
        { class: `item ${app.selected === p.id ? 'sel' : ''}`, onclick: () => app.select(p.id), title: lonlat(p.x, p.y) },
        el('span', { class: 'dot dot-probe' }),
        el('input', { class: 'txt name', value: p.name, onchange: (e: Event) => app.update('markers', () => (p.name = (e.target as HTMLInputElement).value)) }),
        el('span', { class: 'muted small' }, `(${fmt(p.x, 0)}, ${fmt(p.y, 0)})`),
        button(icon(ICONS.trash, 14), (e) => {
          e.stopPropagation();
          app.update('observers', (sc) => (sc.probes = sc.probes.filter((x) => x.id !== p.id)));
        }, 'icon-btn', '删除'),
      ),
    );
    const secRows = s.sections.map((q) =>
      el(
        'div',
        { class: `item ${app.selected === q.id ? 'sel' : ''}`, onclick: () => app.select(q.id) },
        el('span', { class: 'dot dot-section' }),
        el('input', { class: 'txt name', value: q.name, onchange: (e: Event) => app.update('markers', () => (q.name = (e.target as HTMLInputElement).value)) }),
        el('span', { class: 'muted small' }, `${fmt(Math.hypot(q.x2 - q.x1, q.y2 - q.y1), 0)} m`),
        button(icon(ICONS.trash, 14), (e) => {
          e.stopPropagation();
          app.update('observers', (sc) => (sc.sections = sc.sections.filter((x) => x.id !== q.id)));
        }, 'icon-btn', '删除'),
      ),
    );
    const obsSec = section(
      'obs',
      '⑨ 观测点与断面',
      open,
      render,
      `${s.probes.length} 点 · ${s.sections.length} 断面`,
      ...probeRows,
      el('div', { class: 'btn-row' }, toolBtn(app, 'probe', '放置观测点', ICONS.probe), toolBtn(app, 'section', '绘制断面', ICONS.section)),
      app.tool === 'probe' ? el('div', { class: 'tip' }, '在视图中单击放置观测点（记录水深/水位/流速时程）。') : null,
      app.tool === 'section' ? el('div', { class: 'tip' }, '单击断面起点与终点（统计过断面流量）。') : null,
      ...secRows,
    );

    root.replaceChildren(
      el('div', { class: 'panel-title' }, icon(ICONS.layers, 16), ' 模型设置'),
      caseSec,
      terrainSec,
      roughSec,
      structSec,
      bcSec,
      icSec,
      srcSec,
      physSec,
      simSec,
      obsSec,
    );
    root.scrollTop = scroll;
  };
  app.on('case', render);
  app.on('scenario', render);
  app.on('selection', render);
  app.on('tool', render);
  app.on('engine', render);
  render();
}

function sourceCard(app: App, q: SourceDef, unit: { f: number; label: string }, lonlat: (x: number, y: number) => string): HTMLElement {
  const s = app.scenario!;
  const t = app.terrain!;
  const constant = q.series.length === 1;
  const setSeries = (ser: TimeSeries, origin: string): void =>
    app.update('params', () => {
      q.series = ser;
      q.origin = origin;
    });
  const vol = integrateSeries(q.series, 0, s.simulation.duration);
  const card = el(
    'div',
    { class: `card ${app.selected === q.id ? 'sel' : ''}`, onclick: () => app.select(q.id) },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: 'dot dot-source' }),
      el('input', { class: 'txt name', value: q.name, onchange: (e: Event) => app.update('markers', () => (q.name = (e.target as HTMLInputElement).value)) }),
      button(icon(ICONS.trash, 14), (e) => {
        e.stopPropagation();
        app.update('params', (sc) => (sc.sources = sc.sources.filter((x) => x.id !== q.id)));
      }, 'icon-btn', '删除'),
    ),
    el('div', { class: 'muted small' }, `位置 (${fmt(q.x, 0)}, ${fmt(q.y, 0)}) m ${lonlat(q.x, q.y)}`),
    numRow('影响半径', q.radius, (v) => app.update('params', () => (q.radius = Math.max(0, v))), { unit: 'm', min: 0, step: 5 }),
    row(
      '过程线',
      select(constant ? 'const' : 'series', [['const', '恒定流量'], ['series', '流量过程线']], (v) => {
        if (v === 'const') setSeries([[0, seriesMax(q.series)]], '恒定流量');
        else setSeries(triangularHydrograph(0.1 * seriesMax(q.series), seriesMax(q.series), s.simulation.duration * 0.25, s.simulation.duration * 0.75), '三角形过程线');
      }),
    ),
    constant
      ? numRow('流量 Q', q.series[0][1], (v) => setSeries([[0, v]], '恒定流量'), { unit: 'm³/s', step: 1 })
      : seriesEditor(q.series, unit, '流量 (m³/s)', (ser) => setSeries(ser, '手动输入'), 4),
    el('div', { class: 'summary' }, `峰值 ${fmt(seriesMax(q.series), 1)} m³/s · 时段总水量 ${fmtVolume(vol)}`),
    q.origin ? el('div', { class: 'muted small' }, `来源：${q.origin}`) : null,
  );
  // tools: triangle generator and GloFAS fetch
  let base = 0.1 * seriesMax(q.series);
  let peak = Math.max(1, seriesMax(q.series));
  let tp = (s.simulation.duration * 0.3) / unit.f;
  let te = (s.simulation.duration * 0.8) / unit.f;
  const tri = el(
    'details',
    { class: 'tools' },
    el('summary', null, '生成三角形洪水过程线'),
    numRow('基流', base, (v) => (base = v), { unit: 'm³/s' }),
    numRow('洪峰', peak, (v) => (peak = v), { unit: 'm³/s' }),
    numRow('峰现时间', +tp.toFixed(3), (v) => (tp = v), { unit: unit.label }),
    numRow('退水结束', +te.toFixed(3), (v) => (te = v), { unit: unit.label }),
    button('应用', () => setSeries(triangularHydrograph(base, peak, tp * unit.f, te * unit.f), `三角形过程线（峰值 ${peak} m³/s）`), 'btn small'),
  );
  card.append(tri);
  if (t.georef.kind === 'mercator') {
    const geo = t.georef;
    const start0 = s.startTime ? s.startTime.slice(0, 10) : isoDay(-30);
    let start = start0;
    let end = s.startTime ? new Date(Date.parse(s.startTime) + s.simulation.duration * 1000).toISOString().slice(0, 10) : isoDay(-20);
    const sd = el('input', { type: 'date', class: 'txt', value: start, onchange: (e: Event) => (start = (e.target as HTMLInputElement).value) });
    const ed = el('input', { type: 'date', class: 'txt', value: end, onchange: (e: Event) => (end = (e.target as HTMLInputElement).value) });
    const fetchBtn = button('获取 GloFAS 流量', async () => {
      const [lon, lat] = localToLonLat(q.x, q.y, geo, cosLatOf(geo));
      fetchBtn.disabled = true;
      try {
        const d = await fetchDailyDischarge(lat, lon, start, end);
        const t0 = s.startTime ?? `${start}T00:00:00Z`;
        const ser = dischargeSeriesFromDaily(d, t0);
        if (!ser.length) throw new Error('该位置无流量数据');
        app.update('settings', (sc) => {
          q.series = ser;
          q.origin = `Open-Meteo Flood API · GloFAS v4 日均流量 @${d.latitude.toFixed(3)}, ${d.longitude.toFixed(3)}`;
          if (!sc.startTime) sc.startTime = t0;
        });
        app.toast(`已获取 GloFAS 流量 ${ser.length} 天，峰值 ${fmt(seriesMax(ser), 1)} m³/s`, 'ok');
      } catch (err) {
        app.toast(`GloFAS 获取失败：${(err as Error).message}`, 'error');
      } finally {
        fetchBtn.disabled = false;
      }
    }, 'btn small');
    card.append(
      el(
        'details',
        { class: 'tools' },
        el('summary', null, '开放数据：GloFAS 河道流量（Open-Meteo）'),
        el('div', { class: 'muted small' }, '按入流点经纬度查询 Copernicus GloFAS v4 逐日流量（约 5 km 网格，可能偏离实际河道）。'),
        row('开始日期', sd),
        row('结束日期', ed),
        fetchBtn,
      ),
    );
  }
  return card;
}

function rainTools(app: App, s: Scenario): HTMLElement {
  const unit = timeUnit(s.simulation.duration);
  let intensity = 50;
  let hours = 1;
  let total = 100;
  let dur = 3;
  let peakPos = 0.4;
  const setRain = (ser: TimeSeries, origin: string, stepwise: boolean): void =>
    app.update('params', (sc) => {
      sc.rainfall.series = ser;
      sc.rainfall.origin = origin;
      sc.rainfall.stepwise = stepwise;
    });
  const wrap = el(
    'div',
    null,
    el(
      'details',
      { class: 'tools' },
      el('summary', null, '恒定雨强'),
      numRow('雨强', intensity, (v) => (intensity = v), { unit: 'mm/h' }),
      numRow('历时', hours, (v) => (hours = v), { unit: 'h' }),
      button('应用', () => setRain([[0, intensity], [hours * 3600, intensity], [hours * 3600 + 0.001, 0]], `恒定雨强 ${intensity} mm/h × ${hours} h`, false), 'btn small'),
    ),
    el(
      'details',
      { class: 'tools' },
      el('summary', null, '设计暴雨（三角形雨型）'),
      numRow('总雨量', total, (v) => (total = v), { unit: 'mm' }),
      numRow('历时', dur, (v) => (dur = v), { unit: 'h' }),
      numRow('雨峰位置', peakPos, (v) => (peakPos = Math.min(1, Math.max(0, v))), { step: 0.05, title: '0~1，雨峰在历时中的相对位置' }),
      button('应用', () => {
        const ip = (2 * total) / dur; // peak intensity (mm/h) of a triangular hyetograph
        setRain([[0, 0], [peakPos * dur * 3600, ip], [dur * 3600, 0]], `三角形设计暴雨 ${total} mm / ${dur} h`, false);
      }, 'btn small'),
    ),
  );
  const t = app.terrain!;
  if (t.georef.kind === 'mercator') {
    const geo = t.georef;
    let start = s.startTime ? s.startTime.slice(0, 10) : isoDay(-14);
    let end = s.startTime ? new Date(Date.parse(s.startTime) + s.simulation.duration * 1000).toISOString().slice(0, 10) : isoDay(-12);
    const btn = button('获取 ERA5 逐时降雨', async () => {
      btn.disabled = true;
      try {
        const lat = (geo.south + geo.north) / 2;
        const lon = (geo.west + geo.east) / 2;
        const r = await fetchHourlyRain(lat, lon, start, end);
        const t0 = `${start}T00:00:00Z`;
        const dur = (Date.parse(`${end}T00:00:00Z`) - Date.parse(t0)) / 1000 + 86400;
        const ser = rainSeriesFromHourly(r, t0, dur);
        const sum = r.precipitation.reduce<number>((a, b) => a + (b ?? 0), 0);
        app.update('settings', (sc) => {
          sc.rainfall.series = ser.length ? ser : [[0, 0]];
          sc.rainfall.stepwise = true;
          sc.rainfall.enabled = true;
          sc.rainfall.origin = `Open-Meteo ERA5 逐时降水 @${r.latitude.toFixed(3)}, ${r.longitude.toFixed(3)}（${start} ~ ${end}）`;
          sc.startTime = t0;
          sc.simulation.duration = dur;
        });
        app.toast(`已获取 ERA5 降雨 ${r.time.length} 小时，累计 ${fmt(sum, 1)} mm；模拟起点设为 ${start} 00:00 UTC`, 'ok');
      } catch (err) {
        app.toast(`ERA5 获取失败：${(err as Error).message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    }, 'btn small');
    wrap.append(
      el(
        'details',
        { class: 'tools' },
        el('summary', null, '开放数据：ERA5 历史降雨（Open-Meteo）'),
        el('div', { class: 'muted small' }, '以区域中心经纬度查询 ERA5/ERA5-Land 逐时降水（约 9–25 km 分辨率，存在约 5 天延迟）。将同时设置模拟起点与时长。'),
        row('开始日期', el('input', { type: 'date', class: 'txt', value: start, onchange: (e: Event) => (start = (e.target as HTMLInputElement).value) })),
        row('结束日期', el('input', { type: 'date', class: 'txt', value: end, onchange: (e: Event) => (end = (e.target as HTMLInputElement).value) })),
        btn,
      ),
    );
  }
  void unit;
  return wrap;
}

let fillDepth = 10;
function fillTool(app: App): HTMLElement {
  return el(
    'details',
    { class: 'tools' },
    el('summary', null, 'DEM 预处理：填洼（Priority-Flood）'),
    el('div', { class: 'muted small' }, '以非闭边界为出口填充 DEM 洼地，消除粗分辨率 DEM 中由桥梁、植被造成的伪坝/伪洼。超过上限的深洼（真实湖库）只部分填充。'),
    numRow('最大填充深度', fillDepth, (v) => (fillDepth = Math.max(0.01, v)), { unit: 'm', min: 0.01, step: 1 }),
    button('执行填洼', () => app.fillTerrain(fillDepth), 'btn small'),
  );
}

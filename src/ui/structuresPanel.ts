/** Model panel sections for roughness / land use and for buildings, structure lines, culverts and pumps. */
import type { App, ChangeKind } from '../app';
import { seriesMax } from '../core/timeseries';
import { LANDCOVER_CLASSES } from '../model';
import type { BuildingsDef, LinkDef, LinkKind, StructureKind, StructureLine } from '../types';
import { button, checkRow, el, fmt, icon, numInput, numRow, row, select, selectRow } from './dom';
import { ICONS } from './icons';
import { deleteBtn, section, seriesEditor, shortUnit, timeUnit, toolBtn, type TimeUnit } from './panelKit';

export const STRUCTURE_LABEL: Record<StructureKind, string> = { levee: '堤防', weir: '堰', gate: '闸门', breach: '溃口' };
export const LINK_LABEL: Record<LinkKind, string> = { culvert: '涵洞', pump: '泵站' };

const STRUCTURE_TIPS: Record<StructureKind, string> = {
  levee: '堤防：依次单击折线顶点，双击或回车完成。沿线网格地面抬高到堤顶（默认沿线最高地面 + 1 m）。',
  weir: '堰：沿线网格地面设为堰顶高程（高于堰顶的地面也会被削低，宜只画在河槽或缺口范围内），水位超过堰顶即溢流（默认沿线最低地面 + 0.5 m）。',
  gate: '闸门：关闭时为挡水顶高，到开启时间后在启闭历时内降至底槛；可设定再次关闭时间。',
  breach: '溃口：画在堤防（或 DEM 中的堤）上，自溃决时间起在发展历时内由顶高线性降至溃口底高程。',
};

const MANNING_HINTS: [string, string][] = [
  ['混凝土/光滑渠道', '0.012–0.015'],
  ['顺直天然河道', '0.025–0.035'],
  ['蜿蜒多草河道', '0.035–0.05'],
  ['草地/农田', '0.03–0.05'],
  ['灌丛/果园', '0.05–0.08'],
  ['林地', '0.08–0.15'],
  ['城镇（无建筑物模型）', '0.05–0.1'],
];

const tip = (text: string): HTMLElement => el('div', { class: 'tip' }, text);

function polylineLength(pts: [number, number][]): number {
  let s = 0;
  for (let k = 1; k < pts.length; k++) s += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return s;
}

function osmButton(label: string, onClick: () => void): HTMLElement {
  return el('div', { class: 'btn-row' }, button(el('span', null, icon(ICONS.osm, 15), ` ${label}`), onClick, 'btn small'));
}

// ------------------------------------------------------------------ ② roughness & land use
export function roughnessSection(app: App, open: Set<string>, render: () => void): HTMLElement {
  const s = app.scenario!;
  const t = app.baseTerrain!;
  const R = s.roughness!;
  const lc = app.aux.landcover;
  const geoOk = t.georef.kind === 'mercator';
  const n = t.nx * t.ny;
  const parts: (HTMLElement | null)[] = [
    numRow('基础曼宁系数 n', s.manning, (v) => app.update('roughness', (sc) => (sc.manning = v)), {
      min: 0.001,
      max: 0.5,
      step: 0.001,
      unit: 's/m^⅓',
      title: '未被土地利用或糙率分区覆盖的网格使用该值',
    }),
    el('div', { class: 'sub-title' }, '土地利用（OpenStreetMap）'),
  ];
  if (lc) {
    const counts = new Array<number>(LANDCOVER_CLASSES.length).fill(0);
    for (let c = 0; c < n; c++) counts[lc.cls[c]]++;
    const rows = LANDCOVER_CLASSES.map((k, idx) => ({ k, idx, cnt: counts[idx] }))
      .filter((r) => r.idx > 0 && r.cnt > 0)
      .sort((a, b) => b.cnt - a.cnt);
    parts.push(
      checkRow('按土地利用类型赋糙率', R.useLandcover, (on) => app.update('roughness', (sc) => (sc.roughness!.useLandcover = on))),
      el(
        'div',
        { class: `lc-table ${R.useLandcover ? '' : 'off'}` },
        el('div', { class: 'lc-row lc-head' }, el('span', { class: 'lc-name' }, '类型'), el('span', { class: 'lc-pct' }, '占比'), el('span', { class: 'lc-n' }, '曼宁 n')),
        ...rows.map((r) =>
          el(
            'div',
            { class: 'lc-row' },
            el('i', { class: 'swatch', style: { background: r.k.color } }),
            el('span', { class: 'lc-name' }, r.k.label),
            el('span', { class: 'lc-pct' }, `${((100 * r.cnt) / n).toFixed(1)}%`),
            numInput(R.table[r.k.key] ?? r.k.n, (v) => app.update('roughness', (sc) => (sc.roughness!.table[r.k.key] = v)), {
              min: 0.005,
              max: 0.5,
              step: 0.005,
              digits: 3,
            }),
          ),
        ),
        counts[0] > 0
          ? el(
              'div',
              { class: 'lc-row' },
              el('i', { class: 'swatch', style: { background: LANDCOVER_CLASSES[0].color } }),
              el('span', { class: 'lc-name muted' }, '无分类（基础值）'),
              el('span', { class: 'lc-pct' }, `${((100 * counts[0]) / n).toFixed(1)}%`),
              el('span', { class: 'lc-n' }, fmt(s.manning, 3)),
            )
          : null,
      ),
      el('div', { class: 'muted small' }, `来源：${lc.source}`),
    );
  } else {
    parts.push(
      el(
        'div',
        { class: 'muted small' },
        geoOk
          ? '尚未导入土地利用。导入后按林地、农田、草地、居住用地等类型自动赋曼宁系数（可逐类修改）。'
          : '当前为局部坐标地形，无法导入 OpenStreetMap，可手绘糙率分区。',
      ),
    );
  }
  if (geoOk) parts.push(osmButton(lc ? '重新导入土地利用' : '从 OpenStreetMap 导入土地利用', () => void app.importOsm({ buildings: false, landcover: true })));

  parts.push(el('div', { class: 'sub-title' }, '糙率分区（优先于土地利用）'));
  for (const z of R.zones) {
    parts.push(
      el(
        'div',
        { class: `item ${app.selected === z.id ? 'sel' : ''}`, onclick: () => app.select(z.id) },
        el('span', { class: 'dot dot-rough' }),
        el('input', { class: 'txt name', value: z.name, onchange: (e: Event) => app.update('markers', () => (z.name = (e.target as HTMLInputElement).value)) }),
        el('span', { class: 'muted small' }, 'n'),
        numInput(z.n, (v) => app.update('roughness', () => (z.n = v)), { min: 0.005, max: 1, step: 0.005, digits: 3 }),
        deleteBtn(() => app.update('roughness', (sc) => (sc.roughness!.zones = sc.roughness!.zones.filter((x) => x.id !== z.id)))),
      ),
    );
  }
  parts.push(el('div', { class: 'btn-row' }, toolBtn(app, 'roughZone', '绘制糙率分区', ICONS.rough)));
  if (app.tool === 'roughZone') parts.push(tip('在视图中依次单击多边形顶点，双击或回车结束；Esc 取消。'));
  parts.push(
    el(
      'details',
      { class: 'tools' },
      el('summary', null, '曼宁系数参考值'),
      el('div', { class: 'hint-table' }, ...MANNING_HINTS.map(([a, b]) => el('div', null, el('span', null, a), el('b', null, b)))),
    ),
    el('div', { class: 'muted small' }, '优先级：糙率分区 > 土地利用 > 基础值；建筑物"高糙率"模式再按覆盖率混合。糙率修改即时生效，不重启计算。'),
  );
  const badge = [`n=${s.manning}`, lc && R.useLandcover ? '土地利用' : null, R.zones.length ? `${R.zones.length} 分区` : null].filter(Boolean).join(' · ');
  return section('rough', '② 糙率与土地利用', open, render, badge, ...parts);
}

// ------------------------------------------------------------------ ③ buildings & structures
export function structuresSection(app: App, open: Set<string>, render: () => void): HTMLElement {
  const s = app.scenario!;
  const t = app.baseTerrain!;
  const B = s.buildings!;
  const m = app.model;
  const ob = app.aux.buildings;
  const geoOk = t.georef.kind === 'mercator';
  const unit = timeUnit(s.simulation.duration);
  const su = shortUnit(s.simulation.duration);
  /** Building edits change the bed in block mode, only the roughness otherwise. */
  const bKind = (): ChangeKind => (B.mode === 'block' ? 'bed' : 'roughness');
  const parts: (HTMLElement | null)[] = [el('div', { class: 'sub-title' }, '建筑物')];

  parts.push(
    selectRow<BuildingsDef['mode']>(
      '处理方式',
      B.mode,
      [
        ['block', '阻水块（抬高地面）'],
        ['resistance', '高糙率（按覆盖率）'],
        ['off', '忽略'],
      ],
      (v) => app.update(B.mode === 'block' || v === 'block' ? 'bed' : 'roughness', (sc) => (sc.buildings!.mode = v)),
      '阻水块：覆盖过半的网格地面抬高建筑高度，水流绕行（需网格足够细）；高糙率：按建筑覆盖率提高曼宁系数（适合粗网格）',
    ),
  );
  if (B.mode === 'block') {
    parts.push(
      numRow('默认建筑高度', B.defaultHeight, (v) => app.update('bed', (sc) => (sc.buildings!.defaultHeight = Math.max(0.1, v))), {
        unit: 'm',
        min: 0.1,
        step: 1,
        title: 'OSM 无高度信息的建筑与手绘建筑使用该值',
      }),
    );
  } else if (B.mode === 'resistance') {
    parts.push(numRow('建筑区曼宁 n', B.n, (v) => app.update('roughness', (sc) => (sc.buildings!.n = v)), { min: 0.01, max: 1, step: 0.01, digits: 3 }));
  }
  if (ob) {
    parts.push(
      checkRow(`包含导入的建筑物（${ob.count.toLocaleString()} 栋）`, B.useOsm, (on) => app.update(bKind(), (sc) => (sc.buildings!.useOsm = on)), ob.source),
      el('div', { class: 'muted small' }, `来源：${ob.source}`),
    );
  }
  if (geoOk) parts.push(osmButton(ob ? '重新导入 OSM 建筑物' : '从 OpenStreetMap 导入建筑物', () => void app.importOsm({ buildings: true, landcover: false })));
  B.items.forEach((b, k) =>
    parts.push(
      el(
        'div',
        { class: 'item' },
        el('span', { class: 'dot dot-building' }),
        el('span', { class: 'name' }, `手绘建筑 ${k + 1}`),
        el('span', { class: 'muted small' }, '高'),
        numInput(b.height, (v) => app.update(bKind(), () => (b.height = Math.max(0.1, v))), { min: 0.1, step: 1, digits: 1 }),
        el('span', { class: 'unit' }, 'm'),
        deleteBtn(() => app.update(bKind(), (sc) => (sc.buildings!.items = sc.buildings!.items.filter((x) => x.id !== b.id)))),
      ),
    ),
  );
  parts.push(
    el(
      'div',
      { class: 'btn-row' },
      toolBtn(app, 'building', '绘制建筑物轮廓', ICONS.building),
      B.items.length > 1 ? button(`清除手绘（${B.items.length}）`, () => app.update(bKind(), (sc) => (sc.buildings!.items = [])), 'btn small') : null,
    ),
  );
  if (app.tool === 'building') parts.push(tip('依次单击建筑轮廓顶点，双击或回车完成；高度取"默认建筑高度"。'));
  if (B.mode !== 'off' && m?.buildingCover) {
    let touched = 0;
    for (let c = 0; c < m.buildingCover.length; c++) if (m.buildingCover[c] > 0) touched++;
    parts.push(
      el(
        'div',
        { class: 'summary' },
        B.mode === 'block'
          ? `阻水网格 ${m.buildingCells.toLocaleString()} 个（覆盖 ≥ 50%）· 部分覆盖 ${(touched - m.buildingCells).toLocaleString()} 个`
          : `受建筑影响网格 ${touched.toLocaleString()} 个（按覆盖率混合糙率）`,
      ),
    );
  }

  // ---- structure lines
  parts.push(el('div', { class: 'sub-title' }, '水工结构线（堤防 / 堰 / 闸门 / 溃口）'));
  for (const st of s.structures!) parts.push(structureCard(app, st, unit, su));
  parts.push(
    el(
      'div',
      { class: 'btn-row' },
      select<StructureKind>(app.structureKind, Object.entries(STRUCTURE_LABEL) as [StructureKind, string][], (v) => app.setStructureKind(v)),
      toolBtn(app, 'structure', `绘制${STRUCTURE_LABEL[app.structureKind]}`, ICONS.levee),
    ),
  );
  if (app.tool === 'structure') parts.push(tip(STRUCTURE_TIPS[app.structureKind]));

  // ---- culverts & pumps
  parts.push(el('div', { class: 'sub-title' }, '涵洞与泵站'));
  for (const L of s.links!) parts.push(linkCard(app, L, unit));
  parts.push(
    el(
      'div',
      { class: 'btn-row' },
      select<LinkKind>(app.linkKind, Object.entries(LINK_LABEL) as [LinkKind, string][], (v) => app.setLinkKind(v)),
      toolBtn(app, 'link', `放置${LINK_LABEL[app.linkKind]}`, ICONS.link),
    ),
  );
  if (app.tool === 'link') {
    parts.push(
      tip(
        app.linkKind === 'culvert'
          ? '涵洞：单击进口，再单击出口。按孔口公式 Q = Cd·A·√(2gΔH) 由水位差决定方向与流量。'
          : '泵站：单击取水点，再单击排水点。按流量过程线抽排，取水点水深不足时自动减抽。',
      ),
    );
  }
  parts.push(el('div', { class: 'muted small' }, '建筑物与结构线会改写计算地形，修改后模拟从初始状态重新开始；涵洞/泵站参数可在计算中热更新。'));

  const badge = [
    B.mode !== 'off' && ((ob && B.useOsm) || B.items.length) ? (B.mode === 'block' ? '建筑阻水' : '建筑糙率') : null,
    s.structures!.length ? `${s.structures!.length} 结构线` : null,
    s.links!.length ? `${s.links!.length} 涵/泵` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return section('struct', '③ 建筑物与水工结构', open, render, badge || null, ...parts);
}

function structureCard(app: App, st: StructureLine, unit: TimeUnit, su: TimeUnit): HTMLElement {
  const set = (fn: () => void): void => app.update('bed', fn);
  const cells = app.model?.structureCells.get(st.id) ?? [];
  const base = app.baseTerrain!;
  let gMin = Infinity;
  for (const c of cells) gMin = Math.min(gMin, base.z[c]);
  if (!Number.isFinite(gMin)) gMin = 0;
  const hNum = (label: string, v: number, onV: (x: number) => void, title?: string): HTMLElement =>
    numRow(label, v, onV, { unit: 'm', step: 0.1, digits: 2, title });
  const tNum = (label: string, sec: number, onV: (x: number) => void, u: TimeUnit, title?: string): HTMLElement =>
    numRow(label, sec / u.f, (x) => onV(Math.max(0, x) * u.f), { unit: u.label, min: 0, step: u.f === 1 ? 1 : 0.1, digits: 3, title });
  const card = el(
    'div',
    { class: `card ${app.selected === st.id ? 'sel' : ''}`, onclick: () => app.select(st.id) },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: `dot dot-${st.kind}` }),
      el('input', { class: 'txt name', value: st.name, onchange: (e: Event) => app.update('markers', () => (st.name = (e.target as HTMLInputElement).value)) }),
      el('span', { class: 'tag' }, STRUCTURE_LABEL[st.kind]),
      deleteBtn(() => app.update('bed', (sc) => (sc.structures = sc.structures!.filter((x) => x.id !== st.id)))),
    ),
    el('div', { class: 'muted small' }, `长 ${fmt(polylineLength(st.points), 0)} m · ${cells.length} 个网格 · 沿线最低地面 ${fmt(gMin, 2)} m`),
  );
  if (st.kind === 'levee') card.append(hNum('堤顶高程', st.crest, (v) => set(() => (st.crest = v))));
  else if (st.kind === 'weir') card.append(hNum('堰顶高程', st.crest, (v) => set(() => (st.crest = v))));
  else if (st.kind === 'gate') {
    card.append(
      hNum('挡水顶高（关闭）', st.crest, (v) => set(() => (st.crest = v))),
      hNum('底槛高程（开启）', st.bottom ?? gMin, (v) => set(() => (st.bottom = v))),
      tNum('开启时间', st.t1 ?? 0, (v) => set(() => (st.t1 = v)), unit, '0 表示始终开启'),
      tNum('再次关闭时间', st.t2 ?? 0, (v) => set(() => (st.t2 = v)), unit, '0 表示不再关闭'),
      tNum('启闭历时', st.ramp ?? 60, (v) => set(() => (st.ramp = Math.max(1, v))), su),
    );
  } else {
    card.append(
      hNum('初始顶高', st.crest, (v) => set(() => (st.crest = v)), '溃决前的堤顶高程（低于现状地面时不改变地面）'),
      hNum('溃口底高程', st.bottom ?? gMin, (v) => set(() => (st.bottom = v))),
      tNum('溃决开始时间', st.t1 ?? 0, (v) => set(() => (st.t1 = v)), unit),
      tNum('溃口发展历时', st.ramp ?? 600, (v) => set(() => (st.ramp = Math.max(1, v))), su),
    );
  }
  card.append(numRow('线宽', st.width, (v) => set(() => (st.width = Math.max(0, v))), { unit: 'm', min: 0, step: 1, title: '小于等于网格尺寸时为单排（4 连通）网格' }));
  return card;
}

function linkCard(app: App, L: LinkDef, unit: TimeUnit): HTMLElement {
  const set = (fn: () => void): void => app.update('links', fn);
  const card = el(
    'div',
    { class: `card ${app.selected === L.id ? 'sel' : ''}`, onclick: () => app.select(L.id) },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: `dot dot-${L.kind}` }),
      el('input', { class: 'txt name', value: L.name, onchange: (e: Event) => app.update('markers', () => (L.name = (e.target as HTMLInputElement).value)) }),
      el('span', { class: 'tag' }, LINK_LABEL[L.kind]),
      deleteBtn(() => app.update('links', (sc) => (sc.links = sc.links!.filter((x) => x.id !== L.id)))),
    ),
    el(
      'div',
      { class: 'muted small' },
      `${L.kind === 'pump' ? '取水' : '进口'} (${fmt(L.x1, 0)}, ${fmt(L.y1, 0)}) → ${L.kind === 'pump' ? '排水' : '出口'} (${fmt(L.x2, 0)}, ${fmt(L.y2, 0)}) · ${fmt(Math.hypot(L.x2 - L.x1, L.y2 - L.y1), 0)} m`,
    ),
  );
  if (L.kind === 'culvert') {
    const area = Math.max(1, L.count) * Math.PI * 0.25 * L.diameter * L.diameter;
    card.append(
      numRow('管径', L.diameter, (v) => set(() => (L.diameter = Math.max(0.05, v))), { unit: 'm', min: 0.05, step: 0.1, digits: 2 }),
      numRow('孔数', L.count, (v) => set(() => (L.count = Math.max(1, Math.round(v)))), { min: 1, step: 1 }),
      numRow('流量系数 Cd', L.cd, (v) => set(() => (L.cd = Math.min(1, Math.max(0.05, v)))), { min: 0.05, max: 1, step: 0.05, digits: 2 }),
      el('div', { class: 'summary' }, `过流面积 ${fmt(area, 2)} m² · 水位差 1 m 时 Q ≈ ${fmt(L.cd * area * Math.sqrt(2 * 9.81), 2)} m³/s`),
    );
  } else {
    const constant = L.series.length === 1;
    const dur = app.scenario!.simulation.duration;
    card.append(
      row(
        '运行方式',
        select(constant ? 'const' : 'series', [['const', '恒定流量'], ['series', '流量过程线']], (v) => {
          const q = Math.max(0.1, seriesMax(L.series));
          set(() => (L.series = v === 'const' ? [[0, q]] : [[0, 0], [dur * 0.3, 0], [dur * 0.3 + 300, q], [dur, q]]));
        }),
      ),
      constant
        ? numRow('抽排流量', L.series[0][1], (v) => set(() => (L.series = [[0, Math.max(0, v)]])), { unit: 'm³/s', min: 0, step: 0.5 })
        : seriesEditor(L.series, unit, '流量 (m³/s)', (ser) => set(() => (L.series = ser)), 4),
    );
  }
  return card;
}

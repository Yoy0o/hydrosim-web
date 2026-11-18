import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { App } from '../app';
import { BASEMAPS } from '../data/basemap';
import { bboxSizeMeters, chooseDemZoom, planGrid, type BBox } from '../data/geo';
import { TERRARIUM_ATTRIBUTION, loadTerrariumDEM } from '../data/terrarium';
import type { ViewSettings } from '../types';
import { button, el, kids, modal, select } from './dom';

const BOOKMARKS: { name: string; lat: number; lon: number; zoom: number; note: string }[] = [
  { name: 'Malpasset 溃坝 (法)', lat: 43.48, lon: 6.745, zoom: 12, note: '1959 年拱坝溃决' },
  { name: 'Ahr 河谷 (德)', lat: 50.525, lon: 7.05, zoom: 12, note: '2021 年山洪' },
  { name: '都江堰', lat: 31.0, lon: 103.61, zoom: 13, note: '岷江分水' },
  { name: '黄河壶口瀑布', lat: 36.15, lon: 110.445, zoom: 13, note: '峡谷急流' },
  { name: '长江三峡·巫峡', lat: 31.03, lon: 110.0, zoom: 12, note: '峡谷河段' },
  { name: '钱塘江河口', lat: 30.3, lon: 120.75, zoom: 11, note: '河口与潮汐' },
  { name: '香港维多利亚港', lat: 22.29, lon: 114.17, zoom: 12, note: '海湾（含水深）' },
  { name: 'Venice 潟湖 (意)', lat: 45.42, lon: 12.33, zoom: 11, note: '潟湖与风暴潮' },
];

const ASPECTS: [string, number][] = [
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
  ['2:1', 2],
  ['3:4', 3 / 4],
  ['1:2', 1 / 2],
];

export function openMapPicker(app: App): void {
  let cells = 256;
  let aspect = 1;
  let basemap: ViewSettings['basemap'] = 'satellite';
  const mapDiv = el('div', { class: 'picker-map' });
  const frameDiv = el('div', { class: 'picker-frame' });
  const info = el('div', { class: 'picker-info' });
  const wrap = el('div', { class: 'picker-wrap' }, mapDiv, frameDiv);
  const searchInp = el('input', { class: 'txt', placeholder: '纬度, 经度  例如 31.00, 103.61' }) as HTMLInputElement;
  const cellOpts: [string, string][] = [['128', '128'], ['192', '192'], ['256', '256'], ['320', '320'], ['384', '384'], ['512', '512']];
  if (app.gpuAvailable) cellOpts.push(['768', '768（GPU）'], ['1024', '1024（GPU）']);
  const cellsSel = select(String(cells), cellOpts, (v) => {
    cells = Number(v);
    update();
  });
  const aspectSel = select('1:1', ASPECTS.map(([k]) => [k, k] as [string, string]), (v) => {
    aspect = ASPECTS.find(([k]) => k === v)![1];
    layoutFrame();
    update();
  });
  const bmSel = select<ViewSettings['basemap']>(basemap, [['satellite', '卫星影像'], ['osm', 'OpenStreetMap'], ['none', '无（分层设色）']], (v) => (basemap = v));
  const bookmarks = el(
    'div',
    { class: 'bookmarks' },
    ...BOOKMARKS.map((b) => button(b.name, () => map.setView([b.lat, b.lon], b.zoom), 'chip', b.note)),
  );
  const body = el(
    'div',
    { class: 'picker' },
    el('div', { class: 'picker-top' }, searchInp, button('定位', () => goto(), 'btn'), el('span', { class: 'muted small' }, '平移/缩放地图，使研究区域位于选框内')),
    bookmarks,
    wrap,
    el(
      'div',
      { class: 'picker-opts' },
      el('label', null, '长边网格数 ', cellsSel),
      el('label', null, '选框比例 ', aspectSel),
      el('label', null, '地形贴图 ', bmSel),
      info,
    ),
    el('div', { class: 'muted small' }, `数据源：${TERRARIUM_ATTRIBUTION}。地图：© OpenStreetMap contributors；影像：${BASEMAPS.satellite.attribution}`),
  );
  const loadBtn = button('加载地形', () => void load(), 'btn primary');
  const close = modal('在线地形 — 开放 DEM 选区', body, {
    width: 'min(980px, 96vw)',
    footer: el('div', { class: 'foot-btns' }, button('取消', () => close(), 'btn ghost'), loadBtn),
    onClose: () => map.remove(),
  });

  const map = L.map(mapDiv, { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([31.0, 103.61], 12);
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' });
  const sat = L.tileLayer(BASEMAPS.satellite.url, { maxZoom: 16, attribution: 'Sentinel-2 cloudless 2016 © EOX (CC BY 4.0)' });
  osm.addTo(map);
  L.control.layers({ OpenStreetMap: osm, '卫星影像 (Sentinel-2)': sat }, {}, { position: 'topright' }).addTo(map);
  setTimeout(() => {
    map.invalidateSize();
    layoutFrame();
    update();
  }, 50);
  map.on('move zoom resize', () => update());

  function frameRect(): DOMRect {
    return frameDiv.getBoundingClientRect();
  }
  function layoutFrame(): void {
    const r = wrap.getBoundingClientRect();
    const maxW = r.width * 0.78;
    const maxH = r.height * 0.78;
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    Object.assign(frameDiv.style, { width: `${w}px`, height: `${h}px`, left: `${(r.width - w) / 2}px`, top: `${(r.height - h) / 2}px` });
  }
  function bbox(): BBox {
    const r = frameRect();
    const m = mapDiv.getBoundingClientRect();
    const nw = map.containerPointToLatLng([r.left - m.left, r.top - m.top]);
    const se = map.containerPointToLatLng([r.right - m.left, r.bottom - m.top]);
    return { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
  }
  function update(): void {
    const b = bbox();
    if (!(b.east > b.west && b.north > b.south)) return;
    const s = bboxSizeMeters(b);
    const plan = planGrid(b, cells);
    const range = chooseDemZoom(plan, 64, 13);
    const tooBig = s.width > 200000 || s.height > 200000;
    info.replaceChildren(...kids(
      el('span', null, `区域 ${(s.width / 1000).toFixed(2)} × ${(s.height / 1000).toFixed(2)} km`),
      el('span', null, `网格 ${plan.nx} × ${plan.ny}（${(plan.nx * plan.ny / 1000).toFixed(0)}k）`),
      el('span', { class: plan.dx < 10 ? 'warn' : '' }, `单元 ${plan.dx.toFixed(1)} m`),
      el('span', null, `DEM z${range.zoom} · ${range.count} 瓦片`),
      plan.dx < 25 ? el('span', { class: 'warn' }, '提示：开放 DEM 原始分辨率约 30 m，更细网格不会增加地形细节') : null,
      tooBig ? el('span', { class: 'warn' }, '区域过大') : null,
    ));
    loadBtn.disabled = tooBig;
  }
  function goto(): void {
    const m = searchInp.value.split(/[,\s，]+/).map(Number).filter((v) => Number.isFinite(v));
    if (m.length >= 2) map.setView([m[0], m[1]], Math.max(map.getZoom(), 12));
  }
  searchInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goto();
  });

  async function load(): Promise<void> {
    const b = bbox();
    close();
    app.setBusy('准备下载开放 DEM…', 0);
    try {
      const terrain = await loadTerrariumDEM({
        bbox: b,
        cells,
        name: `在线 DEM (${((b.south + b.north) / 2).toFixed(3)}°, ${((b.west + b.east) / 2).toFixed(3)}°)`,
        onProgress: (msg, frac) => app.setBusy(msg, frac),
      });
      app.loadTerrain(terrain, basemap);
      app.toast(`地形已加载：${terrain.nx}×${terrain.ny} 网格，单元 ${terrain.dx.toFixed(1)} m。请设置入流/降雨/初始水体后运行。`, 'ok');
    } catch (err) {
      app.toast(`DEM 下载失败：${(err as Error).message}（请检查网络，或使用内置算例）`, 'error');
    } finally {
      app.setBusy(null);
    }
  }
}

import './styles.css';
import { App } from './app';
import { DEFAULT_PRESET } from './data/presets';
import { buildDisplayPanel } from './ui/displayPanel';
import { buildDock } from './ui/dock';
import { buildModelPanel } from './ui/modelPanel';
import { buildTopbar } from './ui/topbar';
import { buildStatusbar, buildToasts, buildViewportUi } from './ui/viewportUi';

function $(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e;
}

function boot(): void {
  let app: App;
  try {
    app = new App($('viewport'));
  } catch (err) {
    $('boot').innerHTML = `<div class="boot-card error"><b>无法初始化 WebGL2 渲染器</b><div>${String((err as Error).message)}</div><div>请使用支持 WebGL2 的现代浏览器（Chrome / Edge / Firefox / Safari 最新版）。</div></div>`;
    return;
  }
  buildToasts(app);
  buildTopbar($('topbar'), app);
  buildModelPanel($('left'), app);
  buildDisplayPanel($('right'), app);
  buildViewportUi($('viewport'), app);
  buildDock($('dock'), app);
  buildStatusbar($('statusbar'), app);
  const params = new URLSearchParams(location.search);
  void app.loadPreset(params.get('case') ?? DEFAULT_PRESET).then(() => $('boot').remove());
  (window as unknown as { hydrosim: App }).hydrosim = app;
}

boot();

/** Shared building blocks of the model setup panel (collapsible sections, series editors, tool buttons). */
import type { App, Tool } from '../app';
import { parseSeriesText, seriesToText, type TimeSeries } from '../core/timeseries';
import { button, el, icon } from './dom';
import { openDocs } from './docViewer';
import { ICONS } from './icons';

export interface TimeUnit {
  f: number;
  label: string;
}

/** Time unit used for editing series, based on the simulated duration. */
export function timeUnit(duration: number): TimeUnit {
  if (duration >= 3 * 3600) return { f: 3600, label: 'h' };
  if (duration >= 180) return { f: 60, label: 'min' };
  return { f: 1, label: 's' };
}

/** Unit for short durations (gate travel, breach development): minutes unless the whole run is short. */
export function shortUnit(duration: number): TimeUnit {
  return duration >= 180 ? { f: 60, label: 'min' } : { f: 1, label: 's' };
}

export function section(
  id: string,
  title: string,
  open: Set<string>,
  rerender: () => void,
  badge: string | null,
  ...content: (HTMLElement | null)[]
): HTMLElement {
  const isOpen = open.has(id);
  const head = el(
    'button',
    {
      class: `sec-head ${isOpen ? 'open' : ''}`,
      type: 'button',
      onclick: () => {
        if (open.has(id)) open.delete(id);
        else open.add(id);
        rerender();
      },
    },
    icon(ICONS.chevron, 14),
    el('span', { class: 'sec-title' }, title),
    badge ? el('span', { class: 'badge' }, badge) : null,
  );
  return el('div', { class: 'sec' }, head, isOpen ? el('div', { class: 'sec-body' }, ...content) : null);
}

export function seriesEditor(series: TimeSeries, unit: TimeUnit, valueLabel: string, onChange: (s: TimeSeries) => void, rows = 5): HTMLElement {
  const ta = el('textarea', { class: 'series', rows, spellcheck: false }) as HTMLTextAreaElement;
  ta.value = seriesToText(series, unit.f, 4);
  ta.addEventListener('change', () => {
    const s = parseSeriesText(ta.value, unit.f);
    if (s.length) onChange(s);
  });
  return el('div', { class: 'series-box' }, el('div', { class: 'series-head' }, `时间 (${unit.label}), ${valueLabel}`), ta);
}

export function toolBtn(app: App, tool: Tool, label: string, ic: string): HTMLButtonElement {
  return button(el('span', null, icon(ic, 15), ` ${label}`), () => app.setTool(app.tool === tool ? 'navigate' : tool), `btn small ${app.tool === tool ? 'active' : ''}`);
}

/** Small "delete" icon button that does not select the row it sits in. */
export function deleteBtn(onDelete: () => void): HTMLButtonElement {
  return button(
    icon(ICONS.trash, 14),
    (e) => {
      e.stopPropagation();
      onDelete();
    },
    'icon-btn',
    '删除',
  );
}

/** Link to a section of the algorithm document (docs/ALGORITHMS.md, opened in the in-app viewer). */
export function docLink(anchor: string, label: string): HTMLButtonElement {
  return el(
    'button',
    {
      class: 'doc-link',
      type: 'button',
      title: '在算法文档中查看对应章节（公式、实现位置与核验方法）',
      onclick: (e: Event) => {
        e.stopPropagation();
        void openDocs(anchor);
      },
    },
    icon(ICONS.book, 13),
    ` ${label}`,
  ) as HTMLButtonElement;
}

/** Minimal DOM helpers for building the UI without a framework. */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') e.setAttribute('style', v);
        else Object.assign(e.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'html') {
        e.innerHTML = String(v);
      } else if (k in e && k !== 'list') {
        (e as unknown as Record<string, unknown>)[k] = v;
      } else {
        e.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(typeof c === 'number' ? String(c) : c);
  }
  return e;
}

export function fmt(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  return (+v.toFixed(digits)).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

export function fmtVolume(m3: number): string {
  const a = Math.abs(m3);
  if (a >= 1e6) return `${fmt(m3 / 1e6, 3)} 百万m³`;
  if (a >= 1e3) return `${fmt(m3 / 1e3, 2)} 千m³`;
  return `${fmt(m3, 2)} m³`;
}

export function fmtTime(s: number, withMs = false): string {
  if (!Number.isFinite(s)) return '—';
  const neg = s < 0;
  s = Math.abs(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = withMs || (h === 0 && m === 0 && sec < 60 && sec % 1 !== 0) ? sec.toFixed(withMs ? 2 : 1).padStart(withMs ? 5 : 4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return `${neg ? '-' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`;
}

export interface NumOpts {
  min?: number;
  max?: number;
  step?: number | 'any';
  unit?: string;
  digits?: number;
  title?: string;
  disabled?: boolean;
}

export function numInput(value: number, onChange: (v: number) => void, o: NumOpts = {}): HTMLInputElement {
  const inp = el('input', {
    type: 'number',
    class: 'num',
    value: o.digits !== undefined ? String(+value.toFixed(o.digits)) : String(value),
    step: String(o.step ?? 'any'),
    title: o.title,
    disabled: o.disabled,
  }) as HTMLInputElement;
  if (o.min !== undefined) inp.min = String(o.min);
  if (o.max !== undefined) inp.max = String(o.max);
  inp.addEventListener('change', () => {
    let v = Number(inp.value);
    if (!Number.isFinite(v)) return;
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    onChange(v);
  });
  return inp;
}

export function row(label: string, control: HTMLElement, unit?: string, title?: string): HTMLElement {
  return el('label', { class: 'row', title }, el('span', { class: 'row-label' }, label), el('span', { class: 'row-ctl' }, control, unit ? el('span', { class: 'unit' }, unit) : null));
}

export function numRow(label: string, value: number, onChange: (v: number) => void, o: NumOpts = {}): HTMLElement {
  return row(label, numInput(value, onChange, o), o.unit, o.title);
}

export function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const s = el('select', { class: 'sel' }) as HTMLSelectElement;
  for (const [v, l] of options) s.append(el('option', { value: v, selected: v === value }, l));
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

export function selectRow<T extends string>(label: string, value: T, options: [T, string][], onChange: (v: T) => void, title?: string): HTMLElement {
  return row(label, select(value, options, onChange), undefined, title);
}

export function checkRow(label: string, checked: boolean, onChange: (v: boolean) => void, title?: string): HTMLElement {
  const c = el('input', { type: 'checkbox', checked }) as HTMLInputElement;
  c.addEventListener('change', () => onChange(c.checked));
  return el('label', { class: 'row check', title }, c, el('span', null, label));
}

export function button(label: string | Node, onClick: (e: MouseEvent) => void, cls = 'btn', title?: string): HTMLButtonElement {
  const b = el('button', { class: cls, title, type: 'button' }, label) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}

export function icon(svgPath: string, size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = svgPath;
  return s;
}

export function download(filename: string, data: Blob | string, mime = 'text/plain'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type: `${mime};charset=utf-8` }) : data;
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = el('input', { type: 'file', accept }) as HTMLInputElement;
    inp.addEventListener('change', () => resolve(inp.files?.[0] ?? null));
    inp.click();
  });
}

/** Modal dialog; returns a close function. */
export function modal(title: string, body: HTMLElement, opts: { width?: string; onClose?: () => void; footer?: HTMLElement } = {}): () => void {
  const close = (): void => {
    back.remove();
    window.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  const back = el(
    'div',
    { class: 'modal-back' },
    el(
      'div',
      { class: 'modal', style: { width: opts.width ?? '560px' } },
      el('div', { class: 'modal-head' }, el('h3', null, title), button('×', close, 'icon-btn close', '关闭')),
      el('div', { class: 'modal-body' }, body),
      opts.footer ? el('div', { class: 'modal-foot' }, opts.footer) : null,
    ),
  );
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) close();
  });
  window.addEventListener('keydown', onKey);
  document.body.append(back);
  return close;
}

/** Filter out empty children (for replaceChildren). */
export function kids(...c: (Node | string | null | undefined | false)[]): (Node | string)[] {
  return c.filter((x): x is Node | string => x !== null && x !== undefined && x !== false);
}

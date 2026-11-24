/**
 * In-app viewer of the algorithm documentation (docs/ALGORITHMS.md): Markdown (marked) + LaTeX formulas
 * (KaTeX), both loaded on first use so they stay out of the main bundle. Sections numbered "N" / "N.M" in
 * the document get the anchors "sN" / "sN-M", which the model panel links to (docLink in panelKit.ts).
 */
import { button, el, icon } from './dom';
import { ICONS } from './icons';
import { openVerify } from './verifyDialog';

/** Repository the document's relative source links point into (opened in a new tab). */
const REPO_BLOB = 'https://github.com/Yoy0o/hydrosim-web/blob/main/';

interface Rendered {
  html: string;
}

let rendered: Promise<Rendered> | null = null;

/** Replace math with placeholders outside code, so Markdown does not mangle it. */
function protectMath(md: string): { text: string; math: { tex: string; display: boolean }[] } {
  const math: { tex: string; display: boolean }[] = [];
  const out: string[] = [];
  // split on fenced code blocks and inline code spans; odd segments are code and left untouched
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  parts.forEach((part, k) => {
    if (k % 2 === 1) {
      out.push(part);
      return;
    }
    let s = part.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => {
      math.push({ tex: tex.trim(), display: true });
      return `\n\nMATHPH${math.length - 1}X\n\n`;
    });
    s = s.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, pre: string, tex: string) => {
      math.push({ tex: tex.trim(), display: false });
      return `${pre}MATHPH${math.length - 1}X`;
    });
    out.push(s);
  });
  return { text: out.join(''), math };
}

async function render(): Promise<Rendered> {
  const [{ marked }, katexMod, md] = await Promise.all([import('marked'), import('katex'), import('../../docs/ALGORITHMS.md?raw')]);
  await import('katex/dist/katex.min.css');
  const katex = katexMod.default;
  const { text, math } = protectMath(md.default);
  let html = await marked.parse(text, { gfm: true });
  const tex = (k: number): string => {
    const m = math[k];
    return katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore' });
  };
  html = html.replace(/<p>MATHPH(\d+)X<\/p>/g, (_, k: string) => `<div class="math-block">${tex(Number(k))}</div>`);
  html = html.replace(/MATHPH(\d+)X/g, (_, k: string) => tex(Number(k)));
  return { html };
}

/** Anchor for a heading: "8.4 外海开边界" -> "s8-4", "8 边界条件" -> "s8". */
function headingId(text: string, index: number): string {
  const m = /^§?\s*(\d+(?:\.\d+)*)[\s.、]/.exec(text.trim() + ' ');
  return m ? `s${m[1].replace(/\./g, '-')}` : `h${index}`;
}

let openClose: (() => void) | null = null;
let current: { content: HTMLElement; go: (id: string) => void } | null = null;

/** Open the algorithm document, optionally at a section anchor ("s7", "s8-4", …). */
export async function openDocs(anchor?: string): Promise<void> {
  if (current) {
    if (anchor) current.go(anchor);
    return;
  }
  const content = el('article', { class: 'doc-content' }, el('div', { class: 'doc-loading' }, el('div', { class: 'spinner' }), '正在加载算法文档…'));
  const toc = el('nav', { class: 'doc-toc' });
  const close = (): void => {
    overlay.remove();
    window.removeEventListener('keydown', onKey);
    current = null;
    openClose = null;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  const go = (id: string): void => {
    const target = content.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    content.scrollTop = target.offsetTop - 12;
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1600);
  };
  const verifyBtn = button(
    el('span', null, icon(ICONS.check, 15), ' 算法核验'),
    () => {
      // the dialog sits below this overlay: close the document first
      close();
      openVerify();
    },
    'btn small',
    '运行全部核验算例（解析解对比、守恒性、GPU 一致性）',
  );
  const overlay = el(
    'div',
    { class: 'doc-overlay' },
    el(
      'div',
      { class: 'doc-window' },
      el(
        'header',
        { class: 'doc-head' },
        el('span', { class: 'doc-title' }, icon(ICONS.book, 18), ' 水动力算法与实现说明'),
        el('span', { class: 'muted small doc-sub' }, 'docs/ALGORITHMS.md · 公式、代码位置与核验方法'),
        verifyBtn,
        button('×', close, 'icon-btn close', '关闭（Esc）'),
      ),
      el('div', { class: 'doc-body' }, toc, content),
    ),
  );
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', onKey);
  document.body.append(overlay);
  current = { content, go };
  openClose = close;
  try {
    rendered ??= render();
    const { html } = await rendered;
    if (!current) return;
    content.innerHTML = html;
    const heads = Array.from(content.querySelectorAll<HTMLElement>('h1, h2, h3'));
    heads.forEach((h, k) => (h.id = headingId(h.textContent ?? '', k)));
    // relative links into the repository open the source on GitHub; in-document anchors scroll
    content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          go(href.slice(1));
        });
      } else if (!/^[a-z]+:/i.test(href)) {
        const path = href.replace(/^\.\.\//, '').replace(/^\.\//, 'docs/');
        a.href = REPO_BLOB + path;
        a.target = '_blank';
        a.rel = 'noopener';
        a.title = `在 GitHub 查看 ${path}`;
      } else {
        a.target = '_blank';
        a.rel = 'noopener';
      }
    });
    toc.replaceChildren(
      ...heads
        .filter((h) => h.tagName !== 'H1')
        .map((h) =>
          el(
            'button',
            { class: `toc-item ${h.tagName === 'H3' ? 'sub' : ''}`, type: 'button', onclick: () => go(h.id) },
            h.textContent ?? '',
          ),
        ),
    );
    if (anchor) requestAnimationFrame(() => go(anchor));
  } catch (err) {
    content.replaceChildren(el('p', { class: 'muted' }, `文档加载失败：${(err as Error).message}`));
  }
}

/** Close the viewer if open (used by tests / navigation). */
export function closeDocs(): void {
  openClose?.();
}

// The two editors: CodeMirror (source view) and Milkdown Crepe (WYSIWYG view).
// Both are given the Markdown text and report edits through onChange.
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { Crepe } from '@milkdown/crepe';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import crepeCommon from '@milkdown/crepe/theme/common/style.css?inline';
import crepeLight from '@milkdown/crepe/theme/frame.css?inline';
import crepeDark from '@milkdown/crepe/theme/frame-dark.css?inline';
import { backend } from './backend';
import { dirname, localImagePath } from './paths';

export interface EditorHandle {
  destroy(): void;
  focus(): void;
  /** 0 (top) to 1 (bottom), used to keep roughly the same place when switching views. */
  getScroll(): number;
  setScroll(ratio: number): void;
}

/** Crepe's light and dark themes both style `.milkdown`, so only one stylesheet is loaded at a time. */
export function applyCrepeTheme(dark: boolean): void {
  let el = document.getElementById('crepe-theme') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'crepe-theme';
    document.head.appendChild(el);
  }
  el.textContent = crepeCommon + '\n' + (dark ? crepeDark : crepeLight);
}

function ratioOf(el: HTMLElement): number {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

function setRatio(el: HTMLElement, ratio: number): void {
  el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
}

export function createSourceEditor(
  parent: HTMLElement,
  text: string,
  dark: boolean,
  onChange: (text: string) => void,
): EditorHandle {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ codeLanguages: languages }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        ...(dark ? [oneDark] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    destroy: () => view.destroy(),
    focus: () => view.focus(),
    getScroll: () => ratioOf(view.scrollDOM),
    setScroll: (r) => setRatio(view.scrollDOM, r),
  };
}

// Crepe's formatting toolbar buttons are icons only. These names, in the order Crepe draws the
// buttons, become hover text and screen-reader labels.
const TOP_BAR_LABELS = [
  'Bold (Ctrl+B)',
  'Italic (Ctrl+I)',
  'Strikethrough',
  'Inline code',
  'Bulleted list',
  'Numbered list',
  'Task list',
  'Link',
  'Image',
  'Table',
  'Code block',
  'Quote',
  'Divider',
];

function labelTopBar(parent: HTMLElement): void {
  const buttons = parent.querySelectorAll<HTMLElement>('.milkdown-top-bar .top-bar-item');
  // If a Crepe update changes the buttons, skip labeling rather than put wrong names on them.
  if (buttons.length !== TOP_BAR_LABELS.length) return;
  buttons.forEach((b, i) => {
    b.title = TOP_BAR_LABELS[i];
    b.setAttribute('aria-label', TOP_BAR_LABELS[i]);
  });
  const heading = parent.querySelector<HTMLElement>('.milkdown-top-bar .top-bar-heading-button');
  heading?.setAttribute('title', 'Paragraph or heading');
}

/**
 * The bullet character (`-`, `*` or `+`) the file's lists already use, so saving does not swap it.
 * Milkdown otherwise writes `*` for every bullet. Files with no bullet list get `-`.
 */
export function detectBullet(text: string): '-' | '*' | '+' {
  let inCode = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
    if (inCode) continue;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // a divider like "* * *", not a list
    const m = /^\s*([-*+])\s/.exec(line);
    if (m) return m[1] as '-' | '*' | '+';
  }
  return '-';
}

/** The anchor name GitHub gives a heading: "Hello, World!" becomes "hello-world". */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** A "#section" link scrolls to the heading with that anchor name, in the same window. */
function scrollToHeading(parent: HTMLElement, anchor: string): void {
  let wanted = anchor;
  try {
    wanted = decodeURIComponent(anchor);
  } catch {
    // keep as is
  }
  wanted = wanted.toLowerCase();
  const headings = parent.querySelectorAll<HTMLElement>('.ProseMirror :is(h1, h2, h3, h4, h5, h6)');
  const hit = Array.from(headings).find((h) => headingSlug(h.textContent ?? '') === wanted);
  hit?.scrollIntoView({ block: 'start' });
}

// Links open with Ctrl+Click, as in Word or VS Code. A plain click only places the cursor, so the
// link text can still be edited. The webview's own link handling is always blocked, so the app
// window never navigates away.
// Crepe's hover box for a link also shows the address as a link meant to open in a new tab.
// That one opens on a plain click, since clicking it is clearly a request to open.
function watchLinks(parent: HTMLElement, onLink: (href: string) => void): void {
  const linkAt = (e: Event) => (e.target as Element).closest<HTMLAnchorElement>('.ProseMirror a[href]');
  const previewAt = (e: Event) => (e.target as Element).closest<HTMLAnchorElement>('.link-preview a[href]');
  const follow = (href: string) => {
    if (href.startsWith('#')) scrollToHeading(parent, href.slice(1));
    else onLink(href);
  };
  parent.addEventListener('click', (e) => {
    const preview = previewAt(e);
    if (preview) {
      e.preventDefault();
      e.stopPropagation();
      follow(preview.getAttribute('href') ?? '');
      return;
    }
    const a = linkAt(e);
    if (!a) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      follow(a.getAttribute('href') ?? '');
    }
  }, true);
  // Middle-click would also try to open the link in the webview.
  parent.addEventListener('auxclick', (e) => {
    if (linkAt(e) || previewAt(e)) e.preventDefault();
  }, true);
  // The hover text goes on the container, not the link, because ProseMirror owns the link
  // element and would treat a changed attribute as an edit.
  parent.addEventListener('mouseover', (e) => {
    const a = linkAt(e);
    parent.title = a ? `${a.getAttribute('href')}\nCtrl+Click to open` : '';
  });
}

export async function createWysiwygEditor(
  parent: HTMLElement,
  text: string,
  filePath: string,
  onChange: (text: string) => void,
  onLink: (href: string) => void,
): Promise<EditorHandle> {
  const base = dirname(filePath);
  const crepe = new Crepe({
    root: parent,
    defaultValue: text,
    features: {
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.TopBar]: true, // the formatting toolbar; Crepe leaves it off by default
      [Crepe.Feature.AI]: false,
    },
    featureConfigs: {
      // Show images that the file refers to by relative path.
      [Crepe.Feature.ImageBlock]: {
        proxyDomURL: (url: string) => {
          const local = localImagePath(base, url);
          return local === null ? url : backend.imageUrl(local);
        },
      },
    },
  });

  const bullet = detectBullet(text);
  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet }));
  });

  let ready = false;
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, md, prev) => {
      if (ready && md !== prev) onChange(md);
    });
  });
  await crepe.create();
  ready = true;
  labelTopBar(parent);
  watchLinks(parent, onLink);

  return {
    destroy: () => {
      ready = false;
      void crepe.destroy();
    },
    focus: () => parent.querySelector<HTMLElement>('.ProseMirror')?.focus(),
    getScroll: () => ratioOf(parent),
    setScroll: (r) => setRatio(parent, r),
  };
}

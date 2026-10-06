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
import { dirname, resolveLocal } from './paths';

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

export async function createWysiwygEditor(
  parent: HTMLElement,
  text: string,
  filePath: string,
  onChange: (text: string) => void,
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
      [Crepe.Feature.ImageBlock]: { proxyDomURL: (url: string) => resolveLocal(base, url) },
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

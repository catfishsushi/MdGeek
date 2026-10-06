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
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.AI]: false,
    },
    featureConfigs: {
      // Show images that the file refers to by relative path.
      [Crepe.Feature.ImageBlock]: { proxyDomURL: (url: string) => resolveLocal(base, url) },
    },
  });

  let ready = false;
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, md, prev) => {
      if (ready && md !== prev) onChange(md);
    });
  });
  await crepe.create();
  ready = true;

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

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
import { editorViewCtx, editorViewOptionsCtx, remarkCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import type { Fragment, Node as ProseNode } from '@milkdown/kit/prose/model';
import { $remark } from '@milkdown/kit/utils';
import crepeCommon from '@milkdown/crepe/theme/common/style.css?inline';
import crepeLight from '@milkdown/crepe/theme/frame.css?inline';
import crepeDark from '@milkdown/crepe/theme/frame-dark.css?inline';
import { backend } from './backend';
import { keepFormatting } from './keep-format';
import { dirname, localImagePath } from './paths';

export interface EditorHandle {
  destroy(): void;
  focus(): void;
  /**
   * The Markdown line at the top of the view, counting from 0, with a fraction for how far into it.
   * Both views use lines of the file, so switching views keeps the same place.
   */
  getScroll(): number;
  setScroll(line: number): void;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

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
    getScroll: () => {
      if (view.scrollDOM.scrollTop <= 0) return 0;
      const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
      const block = view.lineBlockAtHeight(top);
      return view.state.doc.lineAt(block.from).number - 1 + clamp01((top - block.top) / block.height);
    },
    setScroll: (at) => {
      const doc = view.state.doc;
      const line = doc.line(Math.min(doc.lines, Math.floor(at) + 1));
      // A spot partway into a long wrapped line, so its later rows land at the top.
      const pos = line.from + Math.round((at % 1) * line.length);
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
    },
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

/** The name in a raw HTML anchor like `<a name="setup">` or `<a id="setup">`, lowercased. */
function htmlAnchorName(html: string): string | null {
  const m = /^<a\s[^>]*\b(?:name|id)\s*=\s*["']?([^"'\s>]+)/i.exec(html);
  return m ? m[1].toLowerCase() : null;
}

/**
 * A "#section" link scrolls to the heading with that anchor name, in the same window, or to a raw HTML
 * anchor with that name. Those anchors are hidden (see style.css), so it scrolls to whatever follows.
 */
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
  if (hit) {
    hit.scrollIntoView({ block: 'start' });
    return;
  }
  const anchors = parent.querySelectorAll<HTMLElement>('.ProseMirror span[data-type="html"]');
  const mark = Array.from(anchors).find((a) => htmlAnchorName(a.dataset.value ?? '') === wanted);
  // The anchor itself is hidden and has no position, so use the block it sits in.
  mark?.closest<HTMLElement>('.ProseMirror > *')?.scrollIntoView({ block: 'start' });
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

type MdNode = { type: string; title?: string | null; children?: MdNode[] };

/**
 * Works around a Milkdown 7.22 bug. A picture on a line of its own with no title, like `![x](pic.png)`,
 * has a title of null, which Crepe's picture block rejects. The picture then vanished from the editor,
 * and the next autosave deleted it from the file. An empty title is the same thing and is not written
 * back, so the file is unchanged. Fixes both node types, since the order plugins run in isn't promised.
 */
const imageTitleFix = $remark('mdgeek-image-title-fix', () => () => (tree: unknown) => {
  const walk = (node: MdNode) => {
    if ((node.type === 'image' || node.type === 'image-block') && node.title == null) node.title = '';
    node.children?.forEach(walk);
  };
  walk(tree as MdNode);
});

/**
 * Copied text for "paste as plain text". Crepe copies Markdown, so a few words copied from a table cell
 * came with the table's pipes. Anything with a table in it is copied as plain text instead: cells
 * separated by tabs and rows by line breaks, which also pastes into a spreadsheet as cells.
 * Returns "" for everything else, which leaves it to Crepe.
 */
function tablePlainText(content: Fragment): string {
  let hasTable = false;
  content.descendants((n) => {
    if (n.type.name === 'table') hasTable = true;
    return !hasTable;
  });
  if (!hasTable) return '';
  const plain = (node: ProseNode): string => {
    if (node.isText) return node.text ?? '';
    if (node.isTextblock)
      return node.textBetween(0, node.content.size, '', (leaf) => (leaf.type.name === 'hardbreak' ? '\n' : ''));
    const parts: string[] = [];
    node.forEach((child) => parts.push(plain(child)));
    if (node.type.name === 'table') return parts.join('\n');
    if (node.type.name.endsWith('_row')) return parts.join('\t');
    return parts.join('\n\n');
  };
  const blocks: string[] = [];
  content.forEach((node) => blocks.push(plain(node)));
  return blocks.join('\n\n');
}

type MdBlock = { type: string; position?: { start: { line: number }; end: { line: number } } };

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

  crepe.editor.use(imageTitleFix);
  const bullet = detectBullet(text);
  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet }));
    ctx.update(editorViewOptionsCtx, (prev) => ({
      ...prev,
      clipboardTextSerializer: (slice) => tablePlainText(slice.content),
    }));
  });

  // What the editor writes for the file as loaded. Edits are merged into the original text against it,
  // so lines the user didn't touch keep their formatting (see keep-format.ts).
  let written: string | null = null;
  let fileText = text; // the file as it stands, edits included
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, md, prev) => {
      if (written !== null && md !== prev) onChange((fileText = keepFormatting(text, written, md)));
    });
  });

  /**
   * Each top-level block on screen with the file lines it came from (end exclusive). Blocks are paired
   * with the file's top-level Markdown blocks in order; link definitions ("[x]: url") are left out
   * because they don't appear in the editor. Returns [] if the two don't line up.
   */
  function blockLines(): { el: HTMLElement; from: number; to: number }[] {
    const view = crepe.editor.ctx.get(editorViewCtx);
    const tree = crepe.editor.ctx.get(remarkCtx).parse(fileText) as { children: MdBlock[] };
    const md = tree.children.filter((n) => n.type !== 'definition');
    const doc = view.state.doc;
    // Crepe may add an empty paragraph at the end so there's somewhere to type.
    if (doc.childCount !== md.length && doc.childCount !== md.length + 1) return [];
    const out: { el: HTMLElement; from: number; to: number }[] = [];
    doc.forEach((_node, offset, i) => {
      const pos = md[i]?.position;
      const el = view.nodeDOM(offset);
      if (pos && el instanceof HTMLElement) out.push({ el, from: pos.start.line - 1, to: pos.end.line });
    });
    return out;
  }
  await crepe.create();
  written = crepe.getMarkdown();
  labelTopBar(parent);
  watchLinks(parent, onLink);

  return {
    destroy: () => {
      written = null;
      void crepe.destroy();
    },
    // Through the editor rather than the page element: a plain focus() put the cursor at the start and
    // scrolled there, losing the place kept when switching views.
    focus: () => crepe.editor.ctx.get(editorViewCtx).focus(),
    getScroll: () => {
      if (parent.scrollTop <= 0) return 0;
      const top = parent.getBoundingClientRect().top;
      const blocks = blockLines();
      const b = blocks.find((x) => x.el.getBoundingClientRect().bottom > top) ?? blocks.at(-1);
      if (!b) return 0;
      const r = b.el.getBoundingClientRect();
      return b.from + clamp01((top - r.top) / r.height) * (b.to - b.from);
    },
    setScroll: (at) => {
      const blocks = blockLines();
      const b = blocks.findLast((x) => x.from <= at) ?? blocks[0];
      if (!b) return;
      const r = b.el.getBoundingClientRect();
      const into = b.to > b.from ? clamp01((at - b.from) / (b.to - b.from)) : 0;
      parent.scrollTop += r.top - parent.getBoundingClientRect().top + into * r.height;
    },
  };
}

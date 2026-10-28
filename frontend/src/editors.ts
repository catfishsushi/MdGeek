// The two editors: CodeMirror (source view) and Milkdown Crepe (WYSIWYG view).
// Both are given the Markdown text and report edits through onChange.
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, editorViewOptionsCtx, remarkCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import type { Fragment, Node as ProseNode } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
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
  /** Marks every place the text appears, ignoring case, and returns how many. "" clears the marks. */
  find(text: string): number;
  /** Marks match i (counting from 0) as the current one, and scrolls to it unless scroll is false. */
  showMatch(i: number, scroll?: boolean): void;
  /** Selects match i in the document, so the cursor is there when the find bar closes. */
  selectMatch(i: number): void;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Where text appears in a string, ignoring case, as [start, end) pairs. */
function findAll(haystack: string, text: string): [number, number][] {
  if (!text) return [];
  const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return Array.from(haystack.matchAll(re), (m) => [m.index, m.index + m[0].length]);
}

// The source view marks matches with CodeMirror decorations, swapped in whole on each search.
const setFindMarks = StateEffect.define<DecorationSet>();
const findMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (marks, tr) => tr.effects.find((e) => e.is(setFindMarks))?.value ?? marks.map(tr.changes),
  provide: (f) => EditorView.decorations.from(f),
});
const matchMark = Decoration.mark({ class: 'find-match' });
const currentMark = Decoration.mark({ class: 'find-match find-current' });

// The WYSIWYG view can't add marks to its page elements, since ProseMirror would take any change there
// for an edit. It uses the browser's highlight feature instead, which colours text ranges from outside.
// The two highlights are shared by both sides; each editor adds and removes only its own ranges.
const matchHighlight = new Highlight();
const currentHighlight = new Highlight();
currentHighlight.priority = 1;
CSS.highlights?.set('find-match', matchHighlight);
CSS.highlights?.set('find-current', currentHighlight);

/** Ranges for each match inside one element's text, such as a line of a code block. */
function textRanges(el: Element, text: string): Range[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const at = (i: number): [Text, number] => {
    for (const n of nodes) {
      if (i <= n.length) return [n, i];
      i -= n.length;
    }
    return [nodes[nodes.length - 1], nodes[nodes.length - 1].length];
  };
  return findAll(nodes.map((n) => n.data).join(''), text).map(([from, to]) => {
    const r = document.createRange();
    r.setStart(...at(from));
    r.setEnd(...at(to));
    return r;
  });
}

/**
 * How the source view is coloured. 'light' and 'dark' are CodeMirror's own styles. 'themed' takes every
 * colour from the app theme's variables (--head, --em, --codeink, --listmk and the rest; see Neutral and
 * Dusk in style.css), so one style serves both a light and a dark theme.
 */
export type SourceLook = 'light' | 'dark' | 'themed';

const themedHighlight = HighlightStyle.define([
  // The Markdown itself
  { tag: t.heading, color: 'var(--head)', fontWeight: '600' },
  { tag: t.heading1, color: 'var(--head)', fontWeight: '700' },
  { tag: t.emphasis, color: 'var(--em)', fontStyle: 'italic' },
  { tag: t.strong, color: 'var(--head)', fontWeight: '650' },
  { tag: t.strikethrough, color: 'var(--ink2)', textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--acc)' },
  { tag: t.url, color: 'var(--ink2)', textDecoration: 'underline', textUnderlineOffset: '3px' },
  { tag: t.monospace, color: 'var(--codeink)' },
  { tag: t.quote, color: 'var(--ink2)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--listmk)' },
  { tag: t.contentSeparator, color: 'var(--ink3)' },
  // The marks around the text (#, **, `, >, [ ]) fade back so the words stand out.
  { tag: [t.processingInstruction, t.meta, t.labelName], color: 'var(--ink3)' },
  // Code blocks, in whatever language they're tagged with
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--acc)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--codeink)' },
  { tag: [t.number, t.bool, t.atom, t.null], color: 'var(--listmk)' },
  { tag: t.comment, color: 'var(--ink3)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--em)' },
  { tag: [t.function(t.variableName), t.definition(t.variableName), t.function(t.propertyName)], color: 'var(--head)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--accink)' },
  { tag: t.tagName, color: 'var(--acc)' },
  { tag: t.invalid, color: 'var(--warn-line)' },
]);

// Selection, cursor and the current line, in the theme's colours. Set here rather than in style.css
// because CodeMirror's own selection rule is more specific than a stylesheet rule would comfortably be.
const themedChrome = EditorView.theme({
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--sel)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--acc)', borderLeftWidth: '2px' },
  '.cm-activeLine': { background: 'var(--curline)' },
});

function lookExtensions(look: SourceLook) {
  if (look === 'themed') return [syntaxHighlighting(themedHighlight), themedChrome, highlightActiveLine()];
  return [syntaxHighlighting(defaultHighlightStyle, { fallback: true }), ...(look === 'dark' ? [oneDark] : [])];
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

export function createSourceEditor(
  parent: HTMLElement,
  text: string,
  look: SourceLook,
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
        ...lookExtensions(look),
        EditorView.lineWrapping,
        findMarks,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  let matches: [number, number][] = [];
  const marks = (current: number) =>
    setFindMarks.of(Decoration.set(matches.map(([f, t], i) => (i === current ? currentMark : matchMark).range(f, t))));
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
    find: (text) => {
      matches = findAll(view.state.doc.toString(), text);
      view.dispatch({ effects: marks(-1) });
      return matches.length;
    },
    showMatch: (i, scroll = true) => {
      const m = matches[i];
      if (!m) return;
      const effects: StateEffect<unknown>[] = [marks(i)];
      if (scroll) effects.push(EditorView.scrollIntoView(m[0], { y: 'center' }));
      view.dispatch({ effects });
    },
    selectMatch: (i) => {
      const m = matches[i];
      if (m) view.dispatch({ selection: { anchor: m[0], head: m[1] } });
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

  // Find: each match's on-screen range, and where it is in the document (null inside a code block).
  let found: { range: Range; at: [number, number] | null }[] = [];
  let current: Range | null = null;
  const clearFound = () => {
    for (const f of found) matchHighlight.delete(f.range);
    if (current) currentHighlight.delete(current);
    found = [];
    current = null;
  };

  return {
    destroy: () => {
      written = null;
      clearFound();
      void crepe.destroy();
    },
    find: (text) => {
      clearFound();
      if (!text) return 0;
      const view = crepe.editor.ctx.get(editorViewCtx);
      view.state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        if (node.type.spec.code) {
          // Code blocks are small CodeMirror editors with their own page elements, so they're searched
          // line by line on screen. CodeMirror may skip drawing lines of a very long block until they're
          // scrolled near, and matches in those lines aren't found.
          const dom = view.nodeDOM(pos);
          if (dom instanceof HTMLElement)
            dom.querySelectorAll('.cm-line').forEach((line) => {
              for (const range of textRanges(line, text)) found.push({ range, at: null });
            });
          return false;
        }
        // Each character of this text is one document position, as is each picture or line break,
        // which are counted as one placeholder character.
        const start = pos + 1;
        for (const [f, t] of findAll(node.textBetween(0, node.content.size, undefined, '￼'), text)) {
          const a = view.domAtPos(start + f);
          const b = view.domAtPos(start + t);
          const range = document.createRange();
          range.setStart(a.node, a.offset);
          range.setEnd(b.node, b.offset);
          found.push({ range, at: [start + f, start + t] });
        }
        return false;
      });
      for (const f of found) matchHighlight.add(f.range);
      return found.length;
    },
    showMatch: (i, scroll = true) => {
      const f = found[i];
      if (!f) return;
      if (current) currentHighlight.delete(current);
      current = f.range;
      currentHighlight.add(current);
      if (!scroll) return;
      // A third of the way down, unless it's already in view below the formatting toolbar.
      const r = f.range.getBoundingClientRect();
      const box = parent.getBoundingClientRect();
      if (r.top < box.top + 60 || r.bottom > box.bottom) parent.scrollTop += r.top - box.top - box.height / 3;
    },
    selectMatch: (i) => {
      const at = found[i]?.at;
      if (!at) return;
      const view = crepe.editor.ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, ...at)));
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

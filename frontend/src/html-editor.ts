// The WYSIWYG view for HTML files: the page itself, shown in a frame and made editable with the
// browser's design mode (the way TinyMCE's full-page mode and Dreamweaver's design view work).
//
// Three things keep the file safe:
// - The frame is sandboxed without scripts, so a script in the file never runs, and neither do
//   onclick-style attributes or javascript: links.
// - Pictures and stylesheets the file links by relative path are pointed at MdGeek's own file
//   server, and an auto-refresh <meta> is switched off. Each changed attribute keeps its original
//   value beside it (data-mdg-was-*), which goes back in place when the page is written out, so the
//   file never sees these changes.
// - The browser writes the HTML out in its own style (quotes, <br> for <br/>, and so on). Edits are
//   merged into the original text line by line (keep-format.ts), so lines the user didn't touch keep
//   their exact text, and nothing is written at all until the user edits in this view.
import { backend } from './backend';
import type { EditorHandle } from './editors';
import { keepFormatting } from './keep-format';
import { dirname, localImagePath } from './paths';

const SWAPPED = 'data-mdg-swap'; // marks an element with attributes to put back
const WAS = 'data-mdg-was-'; // + attribute name: the original value
const UI = 'data-mdg-ui'; // marks elements MdGeek added, which are left out when writing

/**
 * The element a selection point is in. Checked by node type, not `instanceof Element`: nodes in the
 * frame belong to the frame's own copy of Element, so instanceof is always false for them.
 */
const elementOf = (node: Node | null | undefined): Element | null =>
  !node ? null : node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const isScriptUrl = (url: string) => /^\s*(javascript|vbscript|data:text\/html)/i.test(url);

/** Whether the file is a whole page (with an <html> tag) rather than a piece of one. */
const isWholePage = (text: string) => /<html[\s>]/i.test(text);

function swapAttr(el: Element, name: string, value: string): void {
  if (!el.hasAttribute(WAS + name)) el.setAttribute(WAS + name, el.getAttribute(name) ?? '');
  el.setAttribute(name, value);
  el.setAttribute(SWAPPED, '');
}

/** Points relative pictures and stylesheets at files MdGeek can serve, and turns off auto-refresh. */
async function prepare(doc: Document, baseDir: string): Promise<void> {
  const jobs: Promise<void>[] = [];
  const point = (el: Element, attr: string) => {
    const value = el.getAttribute(attr);
    if (!value) return;
    const local = localImagePath(baseDir, value);
    if (local === null) return;
    jobs.push(
      Promise.resolve(backend.imageUrl(local)).then((url) => {
        if (url) swapAttr(el, attr, url);
      }),
    );
  };
  doc.querySelectorAll('img[src], source[src], video[poster], input[type=image][src]').forEach((el) =>
    point(el, el.hasAttribute('poster') ? 'poster' : 'src'),
  );
  doc.querySelectorAll('link[rel~=stylesheet][href], link[rel~=icon][href]').forEach((el) => point(el, 'href'));
  doc.querySelectorAll('meta[http-equiv]').forEach((el) => {
    if (/refresh/i.test(el.getAttribute('http-equiv') ?? '')) swapAttr(el, 'http-equiv', 'x-mdgeek-off');
  });
  await Promise.all(jobs);
}

/** A copy of the page with everything MdGeek changed put back. `restore` false keeps the changes, for showing it. */
function cleanCopy(doc: Document, restore = true): HTMLElement {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  if (!restore) return root;
  root.querySelectorAll(`[${UI}]`).forEach((el) => el.remove());
  root.querySelectorAll(`[${SWAPPED}]`).forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (!a.name.startsWith(WAS)) continue;
      el.setAttribute(a.name.slice(WAS.length), a.value);
      el.removeAttribute(a.name);
    }
    el.removeAttribute(SWAPPED);
  });
  return root;
}

/** The page as the browser writes it: its whole text, and the insides of <head> and <body>. */
interface Written {
  whole: string;
  head: string;
  body: string;
}

function writeOut(doc: Document, original: string, restore = true): Written {
  const root = cleanCopy(doc, restore);
  const head = root.querySelector(':scope > head')?.innerHTML ?? '';
  const body = root.querySelector(':scope > body')?.innerHTML ?? '';
  // A piece of a page: the browser wrapped it in <html>, <head> and <body>, which the file never had.
  if (!isWholePage(original)) return { whole: head + body, head, body };
  // Whatever came before <html> (the doctype, comments) and after </html> is kept exactly.
  const start = original.search(/<html[\s>]/i);
  const end = original.toLowerCase().lastIndexOf('</html>');
  const after = end >= 0 ? original.slice(end + '</html>'.length) : '';
  return { whole: original.slice(0, start) + root.outerHTML + after, head, body };
}

/**
 * Where the insides of <head> and <body> are in the file's text. Head is null if the file has no <head>
 * tag (the browser adds an empty one). Returns null if the file doesn't write out <body> and </body>.
 */
function innerRanges(text: string): { head: [number, number] | null; body: [number, number] } | null {
  const range = (tag: string): [number, number] | null => {
    const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i').exec(text);
    const close = text.toLowerCase().lastIndexOf(`</${tag}>`);
    if (!open || close < open.index + open[0].length) return null;
    return [open.index + open[0].length, close];
  };
  const head = range('head');
  const body = range('body');
  if (!body || (head && head[1] > body[0])) return null;
  return { head, body };
}

/** The page's meaning, ignoring how it's laid out in the text: for checking that nothing was lost. */
const meaning = (html: string) =>
  new DOMParser().parseFromString(html, 'text/html').documentElement.outerHTML.replace(/\s+/g, ' ');

/**
 * The original text with the user's edits applied, keeping the original's own text wherever it wasn't
 * edited. For a whole page, only the insides of <head> and <body> are merged and the tags around them
 * stay exactly as written, because the browser writes those tags its own way and they don't line up.
 * If the merge would change what the page means (it can't always line the lines up), the browser's
 * version is used as it is: some lines lose their original layout, but nothing is lost.
 */
function mergeEdit(original: string, base: Written, now: Written): string {
  if (now.whole === base.whole) return original;
  const at = isWholePage(original) ? innerRanges(original) : null;
  // Without a <head> tag, anything before <body> stays as written, as long as the head wasn't changed.
  const split = at && (at.head || base.head === now.head);
  const merged = split
    ? (at.head
        ? original.slice(0, at.head[0]) +
          keepFormatting(original.slice(...at.head), base.head, now.head) +
          original.slice(at.head[1], at.body[0])
        : original.slice(0, at.body[0])) +
      keepFormatting(original.slice(...at.body), base.body, now.body) +
      original.slice(at.body[1])
    : keepFormatting(original, base.whole, now.whole);
  return meaning(merged) === meaning(now.whole) ? merged : now.whole;
}

/** The text the frame is given: the prepared page, in the same standards or quirks mode the file asks for. */
async function framedHtml(text: string, filePath: string): Promise<string> {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  await prepare(doc, dirname(filePath));
  const page = writeOut(doc, text, false).whole;
  return isWholePage(text) ? page : `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

function makeFrame(parent: HTMLElement, html: string, sandbox: string): Promise<HTMLIFrameElement> {
  const frame = document.createElement('iframe');
  frame.className = 'html-frame';
  frame.setAttribute('sandbox', sandbox);
  frame.title = 'Page';
  return new Promise((resolve) => {
    frame.addEventListener('load', () => resolve(frame), { once: true });
    frame.srcdoc = html;
    parent.appendChild(frame);
  });
}

/** Prints an HTML file as it looks in a browser, for Export PDF. Scripts stay off here too. */
export async function printHtml(text: string, filePath: string): Promise<void> {
  const holder = document.createElement('div');
  holder.className = 'html-print';
  document.body.appendChild(holder);
  try {
    const frame = await makeFrame(holder, await framedHtml(text, filePath), 'allow-same-origin allow-modals');
    const doc = frame.contentDocument!;
    const images = Array.from(doc.images);
    await Promise.race([
      Promise.all(images.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })))),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    frame.contentWindow!.print();
  } finally {
    holder.remove();
  }
}

/** The formatting bar's buttons: [command, label, content]. Content is text or an SVG path. */
const BUTTONS: [string, string, string][] = [
  ['bold', 'Bold (Ctrl+B)', '<b>B</b>'],
  ['italic', 'Italic (Ctrl+I)', '<i>I</i>'],
  ['underline', 'Underline (Ctrl+U)', '<u>U</u>'],
  ['strikeThrough', 'Strikethrough', '<s>S</s>'],
  ['|', '', ''],
  ['insertUnorderedList', 'Bulleted list', 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01'],
  ['insertOrderedList', 'Numbered list', 'M10 6h10M10 12h10M10 18h10M4 4v4M3 8h2M3 14h2l-2 3h2'],
  ['outdent', 'Decrease indent', 'M20 6H10M20 12H10M20 18H10M7 9l-3 3 3 3'],
  ['indent', 'Increase indent', 'M20 6H10M20 12H10M20 18H10M4 9l3 3-3 3'],
  ['|', '', ''],
  ['link', 'Link', 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  ['unlink', 'Remove link', 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7M4 4l16 16'],
  ['image', 'Picture', 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01'],
  ['table', 'Table', 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14M15 5v14'],
  ['insertHorizontalRule', 'Divider', 'M4 12h16'],
  ['|', '', ''],
  ['removeFormat', 'Clear formatting', 'M6 5h12M12 5l-3 14M4 20l16-16'],
  ['undo', 'Undo (Ctrl+Z)', 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3'],
  ['redo', 'Redo (Ctrl+Y)', 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3'],
];

type TableOp = 'row-above' | 'row-below' | 'col-left' | 'col-right' | 'delete-row' | 'delete-col' | 'delete-table';

const BLOCKS: [string, string][] = [
  ['p', 'Paragraph'],
  ['h1', 'Heading 1'],
  ['h2', 'Heading 2'],
  ['h3', 'Heading 3'],
  ['h4', 'Heading 4'],
  ['pre', 'Preformatted'],
  ['blockquote', 'Quote'],
];

export async function createHtmlEditor(
  parent: HTMLElement,
  text: string,
  filePath: string,
  onChange: (text: string) => void,
  onLink: (href: string) => void,
): Promise<EditorHandle> {
  parent.classList.add('html-host');
  const bar = document.createElement('div');
  bar.className = 'html-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');
  parent.appendChild(bar);

  const frame = await makeFrame(parent, await framedHtml(text, filePath), 'allow-same-origin');
  const win = frame.contentWindow!;
  const doc = frame.contentDocument!;

  const ui = doc.createElement('style');
  ui.setAttribute(UI, '');
  ui.textContent =
    '::highlight(find-match){background-color:rgba(255,196,0,.35)}' +
    '::highlight(find-current){background-color:rgba(255,140,0,.75)}' +
    // Empty table cells get some room while editing, so there's something to click. Only this view
    // has this rule; it isn't saved, and cells with anything in them size as the page says.
    ':is(td,th):is(:empty,:has(>br:only-child)){min-width:3em;height:1.5em}';
  doc.head.appendChild(ui);
  doc.designMode = 'on';
  doc.execCommand('styleWithCSS', false, 'false'); // <b> and <i>, not <span style="…">

  // What the browser writes for the file as loaded; edits are merged into the original against it.
  const base = writeOut(doc, text);
  let fileText = text;
  const changed = () => {
    const now = mergeEdit(text, base, writeOut(doc, text));
    if (now !== fileText) onChange((fileText = now));
  };
  doc.addEventListener('input', changed);

  // The selection is remembered, because using the block list or the address box moves focus away.
  let saved: Range | null = null;
  const sel = () => win.getSelection();
  doc.addEventListener('selectionchange', () => {
    const s = sel();
    if (s && s.rangeCount) saved = s.getRangeAt(0).cloneRange();
    syncBlock();
  });
  const restore = () => {
    win.focus();
    const s = sel();
    if (saved && s) {
      s.removeAllRanges();
      s.addRange(saved);
    }
  };
  const run = (cmd: string, value?: string) => {
    restore();
    doc.execCommand(cmd, false, value);
    changed();
  };

  // ---- the formatting bar ----
  const blockSel = document.createElement('select');
  blockSel.className = 'html-block';
  blockSel.title = blockSel.ariaLabel = 'Paragraph or heading';
  blockSel.append(new Option('', ''));
  for (const [tag, label] of BLOCKS) blockSel.append(new Option(label, tag));
  blockSel.addEventListener('change', () => {
    if (blockSel.value) run('formatBlock', `<${blockSel.value}>`);
  });
  bar.appendChild(blockSel);
  function syncBlock(): void {
    const node = sel()?.anchorNode;
    const el = elementOf(node);
    const block = el?.closest(BLOCKS.map(([t]) => t).join(','));
    blockSel.value = block ? block.tagName.toLowerCase() : '';
  }

  // The address box for links and pictures, shown in the bar in place of a pop-up.
  const ask = document.createElement('form');
  ask.className = 'html-ask';
  ask.hidden = true;
  const askInput = document.createElement('input');
  askInput.type = 'text';
  askInput.spellcheck = false;
  const askOk = document.createElement('button');
  askOk.type = 'submit';
  askOk.textContent = 'OK';
  const askCancel = document.createElement('button');
  askCancel.type = 'button';
  askCancel.textContent = 'Cancel';
  ask.append(askInput, askOk, askCancel);
  let onAsk: ((url: string) => void) | null = null;
  const closeAsk = () => {
    ask.hidden = true;
    onAsk = null;
    restore();
  };
  const openAsk = (label: string, value: string, then: (url: string) => void) => {
    askInput.placeholder = label;
    askInput.ariaLabel = label;
    askInput.value = value;
    onAsk = then;
    ask.hidden = false;
    askInput.focus();
    askInput.select();
  };
  ask.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = askInput.value.trim();
    const then = onAsk;
    closeAsk();
    if (!url || !then) return;
    if (isScriptUrl(url)) return; // a link that runs code isn't allowed in the page
    then(url);
  });
  askCancel.addEventListener('click', closeAsk);
  askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAsk();
    }
  });

  // ---- tables ----
  // The Table button opens a grid picker, as in Word and Google Docs: hover (or use the arrow keys)
  // to choose the size shown under the grid, then click (or press Enter) to put the table in.
  const GRID_COLS = 10;
  const GRID_ROWS = 8;

  /** A new table with an empty, clickable cell in each place. Borders show so the cells can be seen. */
  function tableHtml(rows: number, cols: number): string {
    const row = '    <tr>\n' + '      <td><br></td>\n'.repeat(cols) + '    </tr>\n';
    return `<table data-mdg-new border="1" style="border-collapse: collapse">\n  <tbody>\n${row.repeat(rows)}  </tbody>\n</table>`;
  }

  function insertTable(rows: number, cols: number): void {
    restore();
    doc.execCommand('insertHTML', false, tableHtml(rows, cols));
    const table = doc.querySelector('table[data-mdg-new]');
    table?.removeAttribute('data-mdg-new');
    const first = table?.querySelector('td');
    if (first) placeCaret(first);
    changed();
  }

  function placeCaret(cell: Element): void {
    const r = doc.createRange();
    r.selectNodeContents(cell);
    r.collapse(true);
    const s = sel();
    s?.removeAllRanges();
    s?.addRange(r);
  }

  function tablePicker(button: HTMLButtonElement): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'html-pick';
    const pop = document.createElement('div');
    pop.className = 'html-grid';
    pop.hidden = true;
    pop.tabIndex = -1;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Insert table: arrow keys choose the size, Enter puts it in');
    const cells = document.createElement('div');
    cells.className = 'html-grid-cells';
    cells.style.gridTemplateColumns = `repeat(${GRID_COLS}, auto)`;
    const label = document.createElement('div');
    label.className = 'html-grid-label';
    label.setAttribute('aria-live', 'polite');
    pop.append(cells, label);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');

    let rows = 1;
    let cols = 1;
    const show = () => {
      cells.querySelectorAll<HTMLElement>('span').forEach((c) => {
        c.classList.toggle('on', Number(c.dataset.r) <= rows && Number(c.dataset.c) <= cols);
      });
      label.textContent = `${cols} × ${rows} table`;
    };
    for (let r = 1; r <= GRID_ROWS; r++)
      for (let c = 1; c <= GRID_COLS; c++) {
        const cell = document.createElement('span');
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        cells.appendChild(cell);
      }
    cells.addEventListener('mouseover', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('span');
      if (!cell) return;
      rows = Number(cell.dataset.r);
      cols = Number(cell.dataset.c);
      show();
    });
    cells.addEventListener('mousedown', (e) => e.preventDefault());
    cells.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('span');
      if (!cell) return;
      close(false);
      insertTable(Number(cell.dataset.r), Number(cell.dataset.c));
    });
    pop.addEventListener('keydown', (e) => {
      const moves: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
      const m = moves[e.key];
      if (m) {
        rows = Math.min(GRID_ROWS, Math.max(1, rows + m[0]));
        cols = Math.min(GRID_COLS, Math.max(1, cols + m[1]));
        show();
      } else if (e.key === 'Enter' || e.key === ' ') {
        close(false);
        insertTable(rows, cols);
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        close(true);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });

    const outside = (e: Event) => {
      if (!wrap.contains(e.target as Node)) close(false);
    };
    function open(): void {
      rows = 1;
      cols = 1;
      show();
      pop.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      pop.focus({ preventScroll: true });
      document.addEventListener('mousedown', outside, true);
      doc.addEventListener('mousedown', outside, true);
    }
    function close(refocus: boolean): void {
      if (pop.hidden) return;
      pop.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', outside, true);
      doc.removeEventListener('mousedown', outside, true);
      if (refocus) button.focus();
    }
    actions.table = () => (pop.hidden ? open() : close(false));
    wrap.append(button, pop);
    return wrap;
  }

  /** The table cell the cursor is in, if any. */
  const cellAtCursor = (): HTMLTableCellElement | null => {
    const node = sel()?.anchorNode;
    const el = elementOf(node);
    return el?.closest<HTMLTableCellElement>('td, th') ?? null;
  };

  // Tab and Shift+Tab move between table cells, as in Word.
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    const cell = cellAtCursor();
    const table = cell?.closest('table');
    if (!cell || !table) return;
    const all = Array.from(table.querySelectorAll('td, th')).filter((c) => c.closest('table') === table);
    const next = all[all.indexOf(cell) + (e.shiftKey ? -1 : 1)];
    e.preventDefault();
    if (next) placeCaret(next);
  });

  // ---- the table menu ----
  // Right-click in a table (or press the Menu key or Shift+F10 there) for row and column commands,
  // as in Word and TinyMCE. Each change is made on a copy of the table, which then takes the table's
  // place, so the file's line breaks and indents inside the table stay as they were. (The browser's own
  // "replace" command drops some of them.) These changes keep their own undo list, below.
  const tableMenu = makeTableMenu();

  // Undo and redo for table changes. Each entry is a pair of tables, of which one is on the page; undo
  // and redo swap them. The table taken out is the very one that was there, so the browser's own undo
  // list, which points at its rows and cells, still works for older edits once the swap is undone.
  // Typing or any other edit starts a new history, so these entries are cleared then.
  type Swap = { before: Element; after: Element };
  let undoTables: Swap[] = [];
  let redoTables: Swap[] = [];
  doc.addEventListener('input', () => {
    undoTables = [];
    redoTables = [];
  });
  function swapTables(from: Swap[], to: Swap[], undo: boolean): boolean {
    const entry = from.pop();
    if (!entry) return false;
    const [out, back] = undo ? [entry.after, entry.before] : [entry.before, entry.after];
    if (!out.isConnected) return false;
    out.replaceWith(back);
    to.push(entry);
    const first = back.querySelector('td, th');
    if (first) placeCaret(first);
    changed();
    return true;
  }
  const undo = () => swapTables(undoTables, redoTables, true) || (run('undo'), true);
  const redo = () => swapTables(redoTables, undoTables, false) || (run('redo'), true);
  doc.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const isUndo = k === 'z' && !e.shiftKey;
    const isRedo = k === 'y' || (k === 'z' && e.shiftKey);
    if ((isUndo && undoTables.length) || (isRedo && redoTables.length)) {
      e.preventDefault();
      (isUndo ? undo : redo)();
    }
  });

  /** Rows and the cell's place in them. Tables with merged cells only get the commands that are safe for them. */
  function tableEdit(cell: HTMLTableCellElement, op: TableOp): void {
    const table = cell.closest('table')!;
    const r = (cell.parentElement as HTMLTableRowElement).rowIndex;
    const c = cell.cellIndex;
    if (op === 'delete-table') {
      selectNode(table);
      doc.execCommand('delete');
      changed();
      return;
    }
    const copy = table.cloneNode(true) as HTMLTableElement;
    const rows = Array.from(copy.rows);
    let focus: Element | null = null;
    /** An empty copy of a cell or row: same tag and look, no content, no id. */
    const blank = <T extends Element>(like: T): T => {
      const n = like.cloneNode(like.tagName === 'TR') as T;
      n.removeAttribute('id');
      n.removeAttribute('rowspan');
      const cells = n.tagName === 'TR' ? Array.from((n as unknown as HTMLTableRowElement).cells) : [n];
      for (const c of cells) {
        c.removeAttribute('id');
        c.removeAttribute('rowspan');
        c.replaceChildren(doc.createElement('br'));
      }
      return n;
    };
    if (op === 'row-above' || op === 'row-below') {
      const row = rows[r];
      const fresh = blank(row);
      insertNear(row, fresh, op === 'row-below');
      focus = fresh.cells[Math.min(c, fresh.cells.length - 1)];
    } else if (op === 'col-left' || op === 'col-right') {
      for (const row of rows) {
        const at = row.cells[Math.min(c, row.cells.length - 1)];
        if (!at) continue;
        const n = blank(at);
        insertNear(at, n, op === 'col-right');
        if (row === rows[r]) focus = n;
      }
    } else if (op === 'delete-row') {
      if (isBlankText(rows[r].previousSibling)) rows[r].previousSibling!.remove();
      rows[r].remove();
      const left = Array.from(copy.rows);
      focus = left[Math.min(r, left.length - 1)]?.cells[c] ?? null;
    } else if (op === 'delete-col') {
      for (const row of rows) {
        const at = row.cells[c];
        if (!at) continue;
        if (isBlankText(at.previousSibling)) at.previousSibling!.remove();
        at.remove();
      }
      const row = copy.rows[r];
      focus = row?.cells[Math.min(c, row.cells.length - 1)] ?? null;
    }
    // Rows or columns all gone: the table goes too.
    if (!Array.from(copy.rows).some((row) => row.cells.length)) return tableEdit(cell, 'delete-table');
    table.replaceWith(copy);
    undoTables.push({ before: table, after: copy });
    redoTables = [];
    win.focus();
    if (focus) placeCaret(focus);
    changed();
  }

  const isBlankText = (n: Node | null) => n?.nodeType === Node.TEXT_NODE && !n.textContent!.trim();
  /**
   * Puts a new row or cell beside `like`, with the same indent before it, so the file stays tidy:
   * each row or cell in the file has its line break and spaces just before it.
   */
  function insertNear(like: Element, node: Element, after: boolean): void {
    const parentEl = like.parentNode!;
    // The browser files the space before a table's first row outside the row group, so for that row the
    // space after it (before the next row) is copied instead.
    const near = isBlankText(like.previousSibling)
      ? like.previousSibling
      : isBlankText(like.nextSibling) && like.nextSibling!.nextSibling
        ? like.nextSibling
        : null;
    const indent = near ? near.cloneNode() : null;
    if (after) {
      const next = like.nextSibling;
      if (indent) parentEl.insertBefore(indent, next);
      parentEl.insertBefore(node, next);
    } else {
      parentEl.insertBefore(node, like);
      if (indent) parentEl.insertBefore(indent, like);
    }
  }

  function selectNode(node: Node): void {
    win.focus();
    const r = doc.createRange();
    r.selectNode(node);
    const s = sel();
    s?.removeAllRanges();
    s?.addRange(r);
  }

  function makeTableMenu() {
    const menu = document.createElement('div');
    menu.className = 'html-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Table');
    menu.hidden = true;
    let cell: HTMLTableCellElement | null = null;
    const ITEMS: [TableOp | '|', string][] = [
      ['row-above', 'Insert row above'],
      ['row-below', 'Insert row below'],
      ['col-left', 'Insert column left'],
      ['col-right', 'Insert column right'],
      ['|', ''],
      ['delete-row', 'Delete row'],
      ['delete-col', 'Delete column'],
      ['delete-table', 'Delete table'],
    ];
    const buttons: HTMLButtonElement[] = [];
    for (const [op, label] of ITEMS) {
      if (op === '|') {
        const sep = document.createElement('div');
        sep.className = 'html-menu-sep';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.dataset.op = op;
      b.tabIndex = -1;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') === 'true' || !cell) return;
        const target = cell;
        close();
        tableEdit(target, op);
      });
      buttons.push(b);
      menu.appendChild(b);
    }
    document.body.appendChild(menu);

    const enabled = () => buttons.filter((b) => b.getAttribute('aria-disabled') !== 'true');
    menu.addEventListener('keydown', (e) => {
      const list = enabled();
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') list[(i + 1) % list.length]?.focus();
      else if (e.key === 'ArrowUp') list[(i - 1 + list.length) % list.length]?.focus();
      else if (e.key === 'Home') list[0]?.focus();
      else if (e.key === 'End') list[list.length - 1]?.focus();
      else if (e.key === 'Escape' || e.key === 'Tab') close(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    const outside = (e: Event) => {
      if (!menu.contains(e.target as Node)) close();
    };
    const onScroll = () => close();

    function open(at: HTMLTableCellElement, x: number, y: number, fromKey: boolean): void {
      cell = at;
      // Merged cells (colspan or rowspan) make rows and columns uneven, so those commands are left off.
      const table = at.closest('table')!;
      const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('td, th')).filter((c) => c.closest('table') === table);
      const rowSpans = cells.some((c) => c.rowSpan > 1);
      const colSpans = cells.some((c) => c.colSpan > 1);
      for (const b of buttons) {
        const op = b.dataset.op as TableOp;
        const off = (op.startsWith('col') || op === 'delete-col') ? colSpans || rowSpans : op.startsWith('row') || op === 'delete-row' ? rowSpans : false;
        b.setAttribute('aria-disabled', String(off));
      }
      menu.hidden = false;
      const box = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`;
      document.addEventListener('mousedown', outside, true);
      doc.addEventListener('mousedown', outside, true);
      win.addEventListener('scroll', onScroll);
      window.addEventListener('resize', onScroll);
      if (fromKey) enabled()[0]?.focus();
      else menu.focus();
    }
    function close(refocus = false): void {
      if (menu.hidden) return;
      menu.hidden = true;
      document.removeEventListener('mousedown', outside, true);
      doc.removeEventListener('mousedown', outside, true);
      win.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (refocus) restore();
    }
    menu.tabIndex = -1;
    return { open, close, remove: () => (close(), menu.remove()) };
  }

  doc.addEventListener('contextmenu', (e) => {
    const cell = (e.target as Element).closest?.<HTMLTableCellElement>('td, th');
    if (!cell) return; // outside a table: the browser's own menu (spelling and so on)
    e.preventDefault();
    // Put the cursor where the click was, so the menu acts on that cell.
    const at = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (at && cell.contains(at.startContainer)) {
      const s = sel();
      s?.removeAllRanges();
      s?.addRange(at);
    } else placeCaret(cell);
    const f = frame.getBoundingClientRect();
    tableMenu.open(cell, f.left + e.clientX, f.top + e.clientY, false);
  });
  doc.addEventListener('keydown', (e) => {
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    const cell = cellAtCursor();
    if (!cell) return;
    e.preventDefault();
    const f = frame.getBoundingClientRect();
    const r = cell.getBoundingClientRect();
    tableMenu.open(cell, f.left + r.left, f.top + r.bottom, true);
  });

  const linkAtSelection = () => {
    const node = saved?.commonAncestorContainer;
    const el = elementOf(node);
    return el?.closest('a[href]') ?? null;
  };
  const actions: Record<string, () => void> = {
    undo: () => void undo(),
    redo: () => void redo(),
    link: () =>
      openAsk('Link address', linkAtSelection()?.getAttribute('href') ?? 'https://', (url) => {
        if (saved && !saved.collapsed) run('createLink', url);
        else run('insertHTML', `<a href="${escapeAttr(url)}">${escapeAttr(url)}</a>`);
      }),
    image: () =>
      openAsk('Picture address or file path', '', async (url) => {
        const local = localImagePath(dirname(filePath), url);
        const shown = local === null ? url : await backend.imageUrl(local);
        const swap = shown !== url ? ` ${SWAPPED} ${WAS}src="${escapeAttr(url)}"` : '';
        run('insertHTML', `<img src="${escapeAttr(shown || url)}" alt=""${swap}>`);
      }),
  };

  for (const [cmd, label, content] of BUTTONS) {
    if (cmd === '|') {
      const sep = document.createElement('span');
      sep.className = 'html-sep';
      bar.appendChild(sep);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'html-b';
    b.title = b.ariaLabel = label;
    b.innerHTML = content.startsWith('<')
      ? content
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${content}"/></svg>`;
    // Pressing a button mustn't take the selection out of the page.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => (actions[cmd] ?? (() => run(cmd)))());
    bar.appendChild(cmd === 'table' ? tablePicker(b) : b);
  }
  bar.appendChild(ask);

  // ---- keys, links ----
  // Keys pressed in the frame don't reach the app's window, so the app's shortcuts (Ctrl+S, Ctrl+E,
  // Ctrl+F and the rest) are passed on. Any the app doesn't use carry on as usual (Ctrl+B, Ctrl+Z).
  doc.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const copy = new KeyboardEvent('keydown', {
      key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
      bubbles: true, cancelable: true,
    });
    if (!window.dispatchEvent(copy)) e.preventDefault();
  });
  // Links open with Ctrl+Click, as in the Markdown view; a plain click places the cursor.
  const linkAt = (e: Event) => (e.target as Element).closest?.('a[href]');
  doc.addEventListener('click', (e) => {
    const a = linkAt(e);
    if (!a) return;
    e.preventDefault();
    if (!(e.ctrlKey || e.metaKey)) return;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
    else if (!isScriptUrl(href)) onLink(href);
  }, true);
  doc.addEventListener('auxclick', (e) => {
    if (linkAt(e)) e.preventDefault();
  }, true);
  doc.addEventListener('mouseover', (e) => {
    const a = linkAt(e);
    frame.title = a ? `${a.getAttribute('href')}\nCtrl+Click to open` : 'Page';
  });
  // Dropped files would replace the page; files are opened by dropping them outside it.
  doc.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  doc.addEventListener('drop', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });

  // ---- find ----
  // The frame is its own page, with its own set of highlights.
  type Hl = { add(r: Range): void; delete(r: Range): void; clear(): void; priority: number };
  const W = win as unknown as { Highlight?: new () => Hl; CSS: { highlights?: Map<string, Hl> } };
  const matchHl = W.Highlight ? new W.Highlight() : null;
  const currentHl = W.Highlight ? new W.Highlight() : null;
  if (matchHl && currentHl) {
    currentHl.priority = 1;
    W.CSS.highlights?.set('find-match', matchHl);
    W.CSS.highlights?.set('find-current', currentHl);
  }
  let found: Range[] = [];
  const clearFound = () => {
    matchHl?.clear();
    currentHl?.clear();
    found = [];
  };
  /** The text of the page, grouped by the block (paragraph, cell, heading) it's in, so matches don't run across blocks. */
  function textGroups(): Text[][] {
    const groups = new Map<Element, Text[]>();
    const blockOf = new Map<Element, Element>();
    const findBlock = (el: Element): Element => {
      const known = blockOf.get(el);
      if (known) return known;
      const inline = win.getComputedStyle(el).display.startsWith('inline') && el.parentElement;
      const b = inline ? findBlock(el.parentElement!) : el;
      blockOf.set(el, b);
      return b;
    };
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      const p = t.parentElement;
      if (!p || p.closest('script, style, template, noscript') || !t.data) continue;
      const b = findBlock(p);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b)!.push(t);
    }
    return [...groups.values()];
  }

  const lineCount = () => fileText.split('\n').length;
  const scroller = () => doc.scrollingElement ?? doc.documentElement;

  return {
    destroy: () => {
      clearFound();
      tableMenu.remove();
      doc.removeEventListener('input', changed);
    },
    focus: () => win.focus(),
    // The source view counts by file line; here the place is the same fraction of the way down.
    getScroll: () => {
      const s = scroller();
      const room = s.scrollHeight - s.clientHeight;
      return room > 0 ? clamp01(s.scrollTop / room) * (lineCount() - 1) : 0;
    },
    setScroll: (line) => {
      const s = scroller();
      const lines = lineCount();
      s.scrollTop = lines > 1 ? (line / (lines - 1)) * (s.scrollHeight - s.clientHeight) : 0;
    },
    find: (q) => {
      clearFound();
      if (!q) return 0;
      const needle = q.toLowerCase();
      for (const nodes of textGroups()) {
        const all = nodes.map((n) => n.data).join('');
        const hay = all.toLowerCase();
        const at = (i: number): [Text, number] => {
          for (const n of nodes) {
            if (i <= n.length) return [n, i];
            i -= n.length;
          }
          const last = nodes[nodes.length - 1];
          return [last, last.length];
        };
        for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
          const r = doc.createRange();
          r.setStart(...at(i));
          r.setEnd(...at(i + needle.length));
          found.push(r);
          matchHl?.add(r);
        }
      }
      return found.length;
    },
    showMatch: (i, scroll = true) => {
      const r = found[i];
      if (!r) return;
      currentHl?.clear();
      currentHl?.add(r);
      if (!scroll) return;
      const box = r.getBoundingClientRect();
      if (box.top < 40 || box.bottom > win.innerHeight) scroller().scrollTop += box.top - win.innerHeight / 3;
    },
    selectMatch: (i) => {
      const r = found[i];
      const s = sel();
      if (!r || !s) return;
      s.removeAllRanges();
      s.addRange(r);
    },
  };
}

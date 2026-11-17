// Table design for the HTML view: header row, banded rows, colours and borders, and column widths.
//
// It follows Word's and Google Docs' model (a gallery of styles plus "Header row" and "Banded rows"
// options, and borders you drag to resize). All styling is CSS in the page's <head>, none of it in
// style attributes:
// - A styled table gets an id, and plain rules of its own in the page's <style> block, such as
//   "#table-1 thead th { background: #2f6fdf; … }" and "#table-1 tbody tr:nth-child(even) { … }".
//   New rows pick up the banding by themselves, and the panel reads the settings back from the rules.
// - The header row is real HTML: the top row moves into <thead> and its cells become <th>.
// - Column widths are rules for the table's <col> elements: "#table-1 col:nth-child(2) { width: 120px; }".
import { createStyleBlock, declarations, pageSheet, removeRules, setRule, topRules } from './html-stylesheet';

export interface TableStyle {
  header: boolean;
  banded: boolean;
  headBg: string;
  headColor: string;
  rowBg: string;
  bandBg: string;
  borderColor: string;
  borderWidth: number;
}

type Colours = Omit<TableStyle, 'header' | 'banded' | 'borderWidth'>;

export const PRESETS: { name: string; colours: Colours }[] = [
  { name: 'Grey', colours: { headBg: '#e9ecef', headColor: '#212529', rowBg: '#ffffff', bandBg: '#f6f7f9', borderColor: '#ced4da' } },
  { name: 'Blue', colours: { headBg: '#2f6fdf', headColor: '#ffffff', rowBg: '#ffffff', bandBg: '#eef4ff', borderColor: '#b9cdf3' } },
  { name: 'Green', colours: { headBg: '#2e8b57', headColor: '#ffffff', rowBg: '#ffffff', bandBg: '#edf7f1', borderColor: '#b7dcc6' } },
  { name: 'Orange', colours: { headBg: '#f4a261', headColor: '#1f1f1f', rowBg: '#ffffff', bandBg: '#fdf1e6', borderColor: '#f0c9a4' } },
  { name: 'Purple', colours: { headBg: '#6a4c93', headColor: '#ffffff', rowBg: '#ffffff', bandBg: '#f3eef9', borderColor: '#cdbfe0' } },
  { name: 'Dark', colours: { headBg: '#2b2f36', headColor: '#ffffff', rowBg: '#ffffff', bandBg: '#f1f2f4', borderColor: '#5c6370' } },
];

// An earlier MdGeek styled tables with these classes and shared rules reading --mdgeek-* variables.
// Such a table still shows its colours in the panel, and is moved over to plain rules when restyled.
const OLD_CLASS = 'mdgeek-table';
const OLD_BANDED = 'mdgeek-banded';
const OLD_VARS: Record<keyof Colours | 'borderWidth', string> = {
  headBg: '--mdgeek-head-bg',
  headColor: '--mdgeek-head-color',
  rowBg: '--mdgeek-row-bg',
  bandBg: '--mdgeek-band-bg',
  borderColor: '--mdgeek-border-color',
  borderWidth: '--mdgeek-border-width',
};

export const DEFAULT_STYLE: TableStyle = { header: true, banded: true, borderWidth: 1, ...PRESETS[0].colours };
const PADDING = '6px 10px';

const isBlank = (n: Node | null | undefined) => n?.nodeType === Node.TEXT_NODE && !n.textContent!.trim();
const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

/** Where table styling is written: the page's style block, as part of the current undo step. */
export interface Styler {
  win: Window;
  /** The block to change, made if the page has none. */
  sheet(): HTMLStyleElement;
}

/** The page's style block, made if the page has none. */
export function ensureSheet(doc: Document): HTMLStyleElement {
  return pageSheet(doc) ?? createStyleBlock(doc, null, []);
}

/** The selector for this table's own rules, giving it an id ("table-1", "table-2", …) if it has none. */
function selectorFor(table: HTMLTableElement): string {
  if (!table.id) {
    let n = 1;
    while (table.ownerDocument.getElementById(`table-${n}`)) n++;
    table.id = `table-${n}`;
  }
  return `#${CSS.escape(table.id)}`;
}

/** The selectors of a table's style rules. */
const rulesFor = (sel: string) => ({
  cells: `${sel} th, ${sel} td`,
  head: `${sel} thead th`,
  row: `${sel} tbody tr`,
  band: `${sel} tbody tr:nth-child(even)`,
});

/** Changes this table's own rule: each property set to its value, or taken out for null. */
function changeTableRule(table: HTMLTableElement, styler: Styler, changes: Record<string, string | null>): void {
  const sel = selectorFor(table);
  const sheet = styler.sheet();
  const css = sheet.textContent ?? '';
  const rule = topRules(css).find((r) => r.selector === sel);
  const decls = rule ? declarations(css, rule) : new Map<string, string>();
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) decls.delete(k);
    else decls.set(k, v);
  }
  sheet.textContent = setRule(css, sel, decls);
}

/** Sets whole rules: each selector to these declarations, or taken out for null. */
function setRules(styler: Styler, rules: [string, Record<string, string> | null][]): void {
  const sheet = styler.sheet();
  let css = sheet.textContent ?? '';
  for (const [sel, decls] of rules) css = setRule(css, sel, new Map(Object.entries(decls ?? {})));
  sheet.textContent = css;
}

/** Takes off the id MdGeek gave a table once no rule uses it. */
function dropUnusedId(table: HTMLTableElement, styler: Styler): void {
  if (!/^table-\d+$/.test(table.id)) return;
  const sel = `#${table.id}`;
  const css = styler.sheet().textContent ?? '';
  if (!topRules(css).some((r) => r.selector === sel || r.selector.startsWith(sel + ' '))) table.removeAttribute('id');
}

/** Clears styling an older MdGeek wrote: style attributes, classes and the --mdgeek-* variables. */
function clearOld(table: HTMLTableElement, styler: Styler): void {
  for (const p of Object.values(OLD_VARS)) table.style.removeProperty(p);
  clearInline(table);
  if (!table.classList.contains(OLD_CLASS)) return;
  table.classList.remove(OLD_CLASS, OLD_BANDED);
  if (!table.classList.length) table.removeAttribute('class');
  changeTableRule(table, styler, Object.fromEntries(Object.values(OLD_VARS).map((v) => [v, null])));
  // The shared rules go once no table uses them.
  if (table.ownerDocument.querySelector(`table.${OLD_CLASS}`)) return;
  const sheet = styler.sheet();
  sheet.textContent = removeRules(sheet.textContent ?? '', (sel) => sel.startsWith(`.${OLD_CLASS}`)).replace(
    /\n?[ \t]*\/\*[^*]*MdGeek[^*]*--mdgeek-\*[^*]*\*\//g,
    '',
  );
  if (/^mdgeek-(table-)?styles$/.test(sheet.id)) sheet.removeAttribute('id');
}

/** Clears style attributes an older MdGeek wrote, without touching the style block. */
function clearInline(table: HTMLTableElement): void {
  table.removeAttribute('border');
  for (const p of ['border-collapse', 'width', 'table-layout']) table.style.removeProperty(p);
  if (!table.getAttribute('style')?.trim()) table.removeAttribute('style');
  table.querySelectorAll(':scope > colgroup > col[style]').forEach((c) => c.removeAttribute('style'));
}

/** The table's style as the panel shows it. An unstyled table shows the default, with "Header row" on, as Word does. */
export function readStyle(table: HTMLTableElement, win: Window): TableStyle {
  const header = !!table.tHead;
  const sheet = pageSheet(table.ownerDocument);
  const css = sheet?.textContent ?? '';
  const all = topRules(css);
  const rule = (sel: string) => {
    const r = all.find((x) => x.selector === sel);
    return r ? declarations(css, r) : null;
  };
  const sel = table.id ? `#${CSS.escape(table.id)}` : '';
  const names = rulesFor(sel);
  const cells = sel ? rule(names.cells) : null;
  if (cells) {
    const colour = (v: string | undefined, k: keyof Colours) => (v && isHex(v) ? v : DEFAULT_STYLE[k]);
    const border = /^(\d+)px\s+solid\s+(#[0-9a-f]{6})$/i.exec(cells.get('border') ?? '');
    const head = rule(names.head);
    const band = rule(names.band);
    return {
      header,
      banded: !!band,
      headBg: colour(head?.get('background'), 'headBg'),
      headColor: colour(head?.get('color'), 'headColor'),
      rowBg: colour(rule(names.row)?.get('background'), 'rowBg'),
      bandBg: colour(band?.get('background'), 'bandBg'),
      borderColor: colour(border?.[2], 'borderColor'),
      borderWidth: cells.get('border') === 'none' ? 0 : border ? Number(border[1]) : DEFAULT_STYLE.borderWidth,
    };
  }
  if (!table.classList.contains(OLD_CLASS)) return { ...DEFAULT_STYLE };
  const cs = win.getComputedStyle(table);
  const get = (k: keyof typeof OLD_VARS) => cs.getPropertyValue(OLD_VARS[k]).trim();
  const colour = (k: keyof Colours) => (isHex(get(k)) ? get(k) : DEFAULT_STYLE[k]);
  const width = parseInt(get('borderWidth'), 10);
  return {
    header,
    banded: table.classList.contains(OLD_BANDED),
    headBg: colour('headBg'),
    headColor: colour('headColor'),
    rowBg: colour('rowBg'),
    bandBg: colour('bandBg'),
    borderColor: colour('borderColor'),
    borderWidth: Number.isFinite(width) ? width : DEFAULT_STYLE.borderWidth,
  };
}

/** Borders and a header row for a new table, so its cells can be seen and clicked. */
export function basicStyle(table: HTMLTableElement, styler: Styler): void {
  const names = rulesFor(selectorFor(table));
  const d = DEFAULT_STYLE;
  changeTableRule(table, styler, { 'border-collapse': 'collapse' });
  setRules(styler, [
    [names.cells, { border: `1px solid ${d.borderColor}`, padding: PADDING }],
    [names.head, { background: d.headBg, color: d.headColor, 'font-weight': 'bold', 'text-align': 'left' }],
  ]);
}

/**
 * Takes out rules for tables that are gone (say, a table deleted after it was styled). They're the
 * rules MdGeek writes, whose selectors start with a table's "#table-N" id.
 */
export function dropRulesForMissingTables(root: ParentNode, blocks: HTMLStyleElement[]): void {
  for (const block of blocks) {
    const css = block.textContent ?? '';
    const next = removeRules(css, (sel) => {
      const m = /^#(table-\d+)(?![\w-])/.exec(sel);
      return !!m && !root.querySelector(`table#${m[1]}`);
    });
    if (next !== css) block.textContent = next;
  }
}

/** Styles a table with its own plain rules in the page's style block. */
export function applyStyle(table: HTMLTableElement, s: TableStyle, styler: Styler): void {
  clearOld(table, styler);
  const sel = selectorFor(table);
  const names = rulesFor(sel);
  const hex = (v: string, k: keyof Colours) => (isHex(v) ? v : DEFAULT_STYLE[k]);
  const width = Math.max(0, Math.min(8, Math.round(s.borderWidth)));
  changeTableRule(table, styler, { 'border-collapse': 'collapse' });
  setRules(styler, [
    [names.cells, { border: width ? `${width}px solid ${hex(s.borderColor, 'borderColor')}` : 'none', padding: PADDING }],
    [names.head, { background: hex(s.headBg, 'headBg'), color: hex(s.headColor, 'headColor'), 'font-weight': 'bold', 'text-align': 'left' }],
    [names.row, { background: hex(s.rowBg, 'rowBg') }],
    [names.band, s.banded ? { background: hex(s.bandBg, 'bandBg') } : null],
  ]);
  setHeader(table, s.header);
}

/** Takes the style off, leaving the table's content, header row and column widths. */
export function removeStyle(table: HTMLTableElement, styler: Styler): void {
  clearOld(table, styler);
  const sel = selectorFor(table);
  changeTableRule(table, styler, { 'border-collapse': null });
  setRules(styler, Object.values(rulesFor(sel)).map((n) => [n, null]));
  dropUnusedId(table, styler);
}

/** Copies a cell as a <th> or <td>, keeping its attributes and content. */
export function retag(cell: Element, tag: 'th' | 'td'): Element {
  const n = cell.ownerDocument.createElement(tag);
  for (const a of Array.from(cell.attributes)) n.setAttribute(a.name, a.value);
  while (cell.firstChild) n.appendChild(cell.firstChild);
  cell.replaceWith(n);
  return n;
}

/** Makes the top row the header row (in <thead>, with <th> cells), or turns it back into an ordinary row. */
export function setHeader(table: HTMLTableElement, on: boolean): void {
  const doc = table.ownerDocument;
  if (on === !!table.tHead) return;
  const lastLine = (t: string) => t.slice(t.lastIndexOf('\n'));
  if (on) {
    const row = table.rows[0];
    if (!row) return;
    const section = row.parentElement!;
    // <thead> goes where the row's section starts, with the same indent; its row goes one step in.
    // The space between the moved row and the next one goes, so the section starts with its next row
    // the way it did before (and the file's lines still match up).
    const before = isBlank(section.previousSibling) ? lastLine(section.previousSibling!.textContent!) : '\n    ';
    // Where the row is indented now: by the space before it, or (as the first row of a <tbody> the file
    // never wrote) by the space before the section.
    const was = isBlank(row.previousSibling) ? lastLine(row.previousSibling!.textContent!) : before;
    if (isBlank(row.nextSibling)) row.nextSibling!.remove();
    const thead = doc.createElement('thead');
    table.insertBefore(thead, section);
    table.insertBefore(doc.createTextNode(before), section);
    thead.append(doc.createTextNode(before + '  '), row, doc.createTextNode(before));
    for (const c of Array.from(row.cells)) retag(c, 'th');
    indentRow(row, before.length + 2 - was.length);
  } else {
    const thead = table.tHead!;
    const body = table.tBodies[0] ?? table.appendChild(doc.createElement('tbody'));
    const first = body.rows[0] ?? null;
    // The indent of the body's rows: the space before its first row, or, for a <tbody> the file never
    // wrote (which starts right at its first row), the space before the section.
    const gap = [first?.previousSibling, body.previousSibling].find(isBlank) ?? null;
    const to = gap ? lastLine(gap.textContent!).length : null;
    for (const row of Array.from(thead.rows)) {
      for (const c of Array.from(row.cells)) retag(c, 'td');
      const at = isBlank(row.previousSibling) ? lastLine(row.previousSibling!.textContent!).length : null;
      if (to !== null && at !== null) indentRow(row, to - at);
      body.insertBefore(row, first);
      if (gap && first) body.insertBefore(gap.cloneNode(), first);
    }
    if (isBlank(thead.nextSibling)) thead.nextSibling!.remove();
    thead.remove();
  }
}

/** Moves a row's cells in (or, for a negative number, out) by that many spaces, to match the row's new depth. */
function indentRow(row: HTMLTableRowElement, by: number): void {
  if (!by) return;
  const out = new RegExp(`\\n {1,${Math.abs(by)}}`, 'g');
  for (const n of Array.from(row.childNodes)) {
    if (!isBlank(n)) continue;
    n.textContent = by > 0 ? n.textContent!.replace(/\n/g, '\n' + ' '.repeat(by)) : n.textContent!.replace(out, '\n');
  }
}

// ---------- columns ----------

/** Each row's cells laid out by column, with merged cells filling every place they cover. */
function layout(table: HTMLTableElement): HTMLTableCellElement[][] {
  const grid: HTMLTableCellElement[][] = [];
  Array.from(table.rows).forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of Array.from(row.cells)) {
      while (grid[r][c]) c++;
      for (let dr = 0; dr < cell.rowSpan; dr++)
        for (let dc = 0; dc < cell.colSpan; dc++) (grid[r + dr] ??= [])[c + dc] = cell;
      c += cell.colSpan;
    }
  });
  return grid;
}

export const columnCount = (table: HTMLTableElement) => Math.max(0, ...layout(table).map((r) => r.length));

/** Each column's width on screen, in pixels, measured from a cell that covers only that column. */
export function measureColumns(table: HTMLTableElement): number[] {
  const grid = layout(table);
  const n = columnCount(table);
  const total = table.getBoundingClientRect().width;
  const widths: number[] = [];
  for (let c = 0; c < n; c++) {
    const cell = grid.map((row) => row[c]).find((x) => x && x.colSpan === 1);
    widths.push(cell ? cell.getBoundingClientRect().width : total / n);
  }
  return widths;
}

/** The table's <colgroup> with one <col> per column, made if needed. */
function colgroup(table: HTMLTableElement, n: number): HTMLTableColElement[] {
  const doc = table.ownerDocument;
  let group = table.querySelector<HTMLTableColElement>(':scope > colgroup');
  if (!group) {
    group = doc.createElement('colgroup') as HTMLTableColElement;
    const first = Array.from(table.children).find((c) => c.tagName !== 'CAPTION') ?? null;
    const ws = isBlank(first?.previousSibling) ? first!.previousSibling!.textContent! : '';
    table.insertBefore(group, first);
    if (ws) table.insertBefore(doc.createTextNode(ws), first);
  }
  let cols = Array.from(group.querySelectorAll<HTMLTableColElement>(':scope > col'));
  // A <col span="2"> covers two columns; resizing needs one <col> each, so the group is rebuilt.
  if (cols.length !== n || cols.some((c) => c.span > 1)) {
    group.replaceChildren(...Array.from({ length: n }, () => doc.createElement('col')));
    cols = Array.from(group.children) as HTMLTableColElement[];
  }
  return cols;
}

/** Sets every column's width, and the table's width to their total, as rules in the page's style block. */
export function setColumnWidths(table: HTMLTableElement, widths: number[], styler: Styler): void {
  colgroup(table, widths.length);
  clearInline(table);
  const total = Math.round(widths.reduce((a, b) => a + b, 0));
  changeTableRule(table, styler, { width: `${total}px`, 'table-layout': 'fixed' });
  const sel = selectorFor(table);
  const sheet = styler.sheet();
  const colSel = (i: number) => `${sel} col:nth-child(${i + 1})`;
  // Rules for columns the table no longer has go.
  let css = removeRules(sheet.textContent ?? '', (s) => {
    const m = s.startsWith(`${sel} col:nth-child(`) && /\((\d+)\)$/.exec(s);
    return !!m && Number(m[1]) > widths.length;
  });
  widths.forEach((w, i) => (css = setRule(css, colSel(i), new Map([['width', `${Math.round(w)}px`]]))));
  sheet.textContent = css;
}

/** Keeps a resized table's columns right when a column is added (at `index`) or removed. */
export function columnAdded(table: HTMLTableElement, index: number, widths: number[] | null, styler: Styler): void {
  if (!widths) return;
  const next = [...widths];
  next.splice(index, 0, widths[Math.min(index, widths.length - 1)] ?? 80);
  setColumnWidths(table, next, styler);
}
export function columnRemoved(table: HTMLTableElement, index: number, widths: number[] | null, styler: Styler): void {
  if (!widths || widths.length <= 1) return;
  setColumnWidths(table, widths.filter((_, i) => i !== index), styler);
}
/** The widths a table was given by resizing, or null if it was never resized. */
export function fixedWidths(table: HTMLTableElement, win: Window): number[] | null {
  const group = table.querySelector(':scope > colgroup');
  if (!group || win.getComputedStyle(table).tableLayout !== 'fixed') return null;
  const ws = Array.from(group.querySelectorAll(':scope > col')).map((c) => parseFloat(win.getComputedStyle(c).width));
  return ws.length && ws.every((w) => w > 0) ? ws : null;
}

const MIN_COL = 24;

export interface ResizeHost {
  doc: Document;
  styler: Styler;
  /** Starts an undoable change of the table and returns the copy to change. */
  begin(table: HTMLTableElement): HTMLTableElement;
  /** Keeps the change. */
  end(): void;
  /** Drops a change that didn't change anything. */
  cancel(): void;
  changed(): void;
  /** Shows the resize pointer over the whole page, or stops showing it. */
  setCursor(on: boolean): void;
}

/**
 * Column resizing by dragging borders, as in Word and Google Docs. A border between two columns moves
 * between them and the table keeps its width; the table's right edge changes the last column, and so
 * the table's width.
 */
export function attachResize(host: ResizeHost): void {
  const { doc } = host;
  type Edge = { table: HTMLTableElement; index: number };
  let hover: Edge | null = null;
  let drag: { table: HTMLTableElement; index: number; startX: number; widths: number[]; moved: boolean; id: number } | null = null;

  /** The column border under the pointer, if it's within a few pixels of one. */
  function edgeAt(e: PointerEvent): Edge | null {
    const cell = (e.target as Element).closest?.<HTMLTableCellElement>('td, th');
    const table = cell?.closest('table');
    if (!table || !table.closest('body')) return null;
    const tol = e.pointerType === 'touch' ? 10 : 4;
    const widths = measureColumns(table);
    let x = table.getBoundingClientRect().left;
    for (let i = 0; i < widths.length; i++) {
      x += widths[i];
      if (Math.abs(e.clientX - x) <= tol) return { table, index: i };
    }
    return null;
  }

  doc.addEventListener('pointermove', (e) => {
    if (drag) {
      if (e.pointerId !== drag.id) return;
      const d = e.clientX - drag.startX;
      const w = [...drag.widths];
      const i = drag.index;
      if (i < w.length - 1) {
        // Between two columns: one grows as the other shrinks.
        const move = Math.max(MIN_COL - w[i], Math.min(w[i + 1] - MIN_COL, d));
        w[i] += move;
        w[i + 1] -= move;
      } else {
        w[i] = Math.max(MIN_COL, w[i] + d);
      }
      drag.moved ||= Math.abs(d) > 0;
      setColumnWidths(drag.table, w, host.styler);
      return;
    }
    const was = !!hover;
    hover = edgeAt(e);
    if (!!hover !== was) host.setCursor(!!hover);
  });

  // Stops the browser starting a text selection on a border press.
  doc.addEventListener('mousedown', (e) => {
    if (hover || drag) e.preventDefault();
  }, true);

  doc.addEventListener('pointerdown', (e) => {
    if (!hover || e.button !== 0) return;
    e.preventDefault();
    const table = host.begin(hover.table);
    drag = { table, index: hover.index, startX: e.clientX, widths: measureColumns(table), moved: false, id: e.pointerId };
    try {
      // Keeps the drag going when the pointer runs past the page's edge.
      doc.documentElement.setPointerCapture(e.pointerId);
    } catch {
      // not every pointer can be captured; the drag still works inside the page
    }
  }, true);

  const finish = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    hover = null;
    host.setCursor(false);
    if (moved) {
      host.end();
      host.changed();
    } else host.cancel();
  };
  doc.addEventListener('pointerup', finish);
  doc.addEventListener('pointercancel', finish);
}

// ---------- the design panel ----------

export interface PanelHost {
  styler: Styler;
  /** The table the cursor is in. */
  currentTable(): HTMLTableElement | null;
  begin(table: HTMLTableElement): HTMLTableElement;
  end(): void;
  changed(): void;
  /** Puts focus back in the page. */
  restore(): void;
}

const FIELDS: [keyof Colours, string][] = [
  ['headBg', 'Header background'],
  ['headColor', 'Header text'],
  ['rowBg', 'Rows'],
  ['bandBg', 'Alternate rows'],
  ['borderColor', 'Borders'],
];

/** A small picture of a style, for the gallery: a header row and four banded rows. */
function swatch(c: Colours): string {
  const row = (bg: string) => `<span style="background:${bg};border-color:${c.borderColor}"></span>`;
  return (
    `<span class="hd-mini" style="border-color:${c.borderColor}">` +
    `<span style="background:${c.headBg};border-color:${c.borderColor}"></span>` +
    row(c.rowBg) + row(c.bandBg) + row(c.rowBg) + row(c.bandBg) +
    '</span>'
  );
}

/**
 * The Table design panel, opened from the toolbar (or the table's right-click menu) while the cursor is
 * in a table. Each change shows at once; everything done while it's open is one step for Undo.
 */
export function makeDesignPanel(host: PanelHost, button: HTMLButtonElement): { wrap: HTMLElement; open(at?: HTMLTableElement): void; close(): void } {
  const wrap = document.createElement('span');
  wrap.className = 'html-pick';
  const panel = document.createElement('div');
  panel.className = 'html-design';
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Table design');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');

  const section = (title: string) => {
    const s = document.createElement('div');
    s.className = 'hd-sec';
    const h = document.createElement('div');
    h.className = 'hd-h';
    h.textContent = title;
    s.appendChild(h);
    panel.appendChild(s);
    return s;
  };

  const gallery = document.createElement('div');
  gallery.className = 'hd-gallery';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hd-style';
    b.title = b.ariaLabel = `${p.name} style`;
    b.innerHTML = swatch(p.colours);
    b.addEventListener('click', () => {
      Object.assign(current, p.colours);
      fill();
      apply();
    });
    gallery.appendChild(b);
  }
  section('Styles').appendChild(gallery);

  const options = section('Options');
  const check = (label: string, key: 'header' | 'banded') => {
    const l = document.createElement('label');
    l.className = 'hd-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => {
      current[key] = box.checked;
      apply();
    });
    l.append(box, ` ${label}`);
    options.appendChild(l);
    return box;
  };
  const headerBox = check('Header row', 'header');
  const bandedBox = check('Banded rows', 'banded');

  const colours = section('Colours and borders');
  const grid = document.createElement('div');
  grid.className = 'hd-grid';
  colours.appendChild(grid);
  const inputs = new Map<keyof Colours, HTMLInputElement>();
  for (const [key, label] of FIELDS) {
    const l = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'color';
    input.addEventListener('input', () => {
      current[key] = input.value;
      apply();
    });
    inputs.set(key, input);
    l.append(input, ` ${label}`);
    grid.appendChild(l);
  }
  const thick = document.createElement('label');
  const thickSel = document.createElement('select');
  for (let px = 0; px <= 4; px++) thickSel.append(new Option(px ? `${px} px` : 'None', String(px)));
  thickSel.addEventListener('change', () => {
    current.borderWidth = Number(thickSel.value);
    apply();
  });
  thick.append(thickSel, ' Border thickness');
  grid.appendChild(thick);

  const foot = document.createElement('div');
  foot.className = 'hd-foot';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove style';
  remove.addEventListener('click', () => {
    const t = target();
    if (!t) return;
    removeStyle(t, host.styler);
    host.changed();
    close(true);
  });
  const done = document.createElement('button');
  done.type = 'button';
  done.textContent = 'Done';
  done.addEventListener('click', () => close(true));
  foot.append(remove, done);
  panel.appendChild(foot);

  let current: TableStyle = { ...DEFAULT_STYLE };
  let table: HTMLTableElement | null = null;
  const target = () => (table ? (table = host.begin(table)) : null);
  function fill(): void {
    headerBox.checked = current.header;
    bandedBox.checked = current.banded;
    for (const [k, input] of inputs) input.value = current[k];
    thickSel.value = String(Math.min(4, current.borderWidth));
  }
  function apply(): void {
    const t = target();
    if (!t) return;
    applyStyle(t, current, host.styler);
    host.changed();
  }

  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  });
  const outside = (e: Event) => {
    if (!wrap.contains(e.target as Node)) close(false);
  };

  /** Opens for the table with the cursor, or for `at` (the table right-clicked). */
  function open(at?: HTMLTableElement): void {
    table = at ?? host.currentTable();
    if (!table) return;
    current = readStyle(table, host.styler.win);
    fill();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // Keep the panel on screen on a narrow window.
    panel.style.left = '0';
    const r = panel.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) panel.style.left = `${window.innerWidth - 8 - r.right}px`;
    panel.focus({ preventScroll: true });
    document.addEventListener('mousedown', outside, true);
    table.ownerDocument.addEventListener('mousedown', outside, true);
  }
  function close(refocus = false): void {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside, true);
    table?.ownerDocument.removeEventListener('mousedown', outside, true);
    table = null;
    host.end();
    if (refocus) host.restore();
  }

  wrap.append(button, panel);
  return { wrap, open, close };
}

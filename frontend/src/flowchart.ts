// Reads and writes the part of Mermaid's flowchart language the visual diagram editor works with:
// shapes (with a label and an outline), and lines between them (with a label, a line style and arrow
// heads). Mermaid lays the diagram out itself, so there are no positions to keep.
//
// Lines the editor doesn't understand but can safely keep (styles, classes, click actions, comments)
// are carried along unchanged and written at the end. Diagrams that use features which would be lost
// or mangled (subgraphs, "&" lists, the newer "@{ ... }" shape syntax) are refused, so they stay
// editable as code only.

export type Direction = 'TD' | 'TB' | 'BT' | 'LR' | 'RL';

export type Shape =
  | 'none' // just the id, drawn as a rectangle showing the id
  | 'rect'
  | 'round'
  | 'stadium'
  | 'subroutine'
  | 'cylinder'
  | 'circle'
  | 'doublecircle'
  | 'diamond'
  | 'hexagon'
  | 'flag'
  | 'parallelogram'
  | 'parallelogram-alt'
  | 'trapezoid'
  | 'trapezoid-alt';

export type LineStyle = 'solid' | 'dotted' | 'thick';
/** The end of a line at the target: an arrow, a circle, a cross, or nothing. */
export type Head = '>' | 'o' | 'x' | '';

export interface FlowNode {
  id: string;
  label: string;
  shape: Shape;
}

export interface FlowEdge {
  from: string;
  to: string;
  label: string;
  style: LineStyle;
  head: Head;
  /** An arrow at the start as well, as in `A <--> B`. */
  both: boolean;
  /** Extra length, from writing the line longer (`--->` is 1). Mermaid draws it with more room. */
  extra: number;
}

export interface Flowchart {
  /** Front matter and init directives that come before the first line, kept as written. */
  prefix: string[];
  keyword: 'flowchart' | 'graph';
  direction: Direction;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Lines kept unchanged and written after the shapes and lines. */
  extras: string[];
}

export type ParseResult = { ok: true; chart: Flowchart } | { ok: false; reason: string };

/** Each shape's opening and closing brackets. Longer openers come first so `((` wins over `(`. */
const BRACKETS: [Shape, string, string][] = [
  ['doublecircle', '(((', ')))'],
  ['circle', '((', '))'],
  ['stadium', '([', '])'],
  ['cylinder', '[(', ')]'],
  ['subroutine', '[[', ']]'],
  ['hexagon', '{{', '}}'],
  ['parallelogram', '[/', '/]'],
  ['trapezoid', '[/', '\\]'],
  ['parallelogram-alt', '[\\', '\\]'],
  ['trapezoid-alt', '[\\', '/]'],
  ['round', '(', ')'],
  ['rect', '[', ']'],
  ['diamond', '{', '}'],
  ['flag', '>', ']'],
];

export const SHAPE_NAMES: Record<Exclude<Shape, 'none'>, string> = {
  rect: 'Rectangle',
  round: 'Rounded',
  stadium: 'Pill',
  subroutine: 'Subroutine',
  cylinder: 'Database',
  circle: 'Circle',
  doublecircle: 'Double circle',
  diamond: 'Decision',
  hexagon: 'Hexagon',
  flag: 'Flag',
  parallelogram: 'Input / output',
  'parallelogram-alt': 'Input / output (left)',
  trapezoid: 'Trapezoid',
  'trapezoid-alt': 'Trapezoid (upside down)',
};

const ID = /^[\p{L}\p{N}_]+/u;
// Mermaid keywords that can't be used as a node id.
const RESERVED = new Set(['end', 'subgraph', 'graph', 'flowchart', 'style', 'class', 'classDef', 'click', 'linkStyle']);
const KEEP = /^(classDef|class|style|linkStyle|click)\s/;

/** Splits a line into statements at semicolons that aren't inside quotes or brackets. */
function statements(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quote = !quote;
    else if (quote) continue;
    else if ('[({'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

class Reader {
  constructor(
    public s: string,
    public i = 0,
  ) {}
  skipSpace() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  rest() {
    return this.s.slice(this.i);
  }
  done() {
    this.skipSpace();
    return this.i >= this.s.length;
  }
}

/** Reads `A`, `A[Label]`, `A(("Label"))` and so on. Returns null if there's no node here. */
function readNode(r: Reader): { id: string; label?: string; shape?: Shape } | null {
  r.skipSpace();
  const m = ID.exec(r.rest());
  if (!m) return null;
  const id = m[0];
  r.i += id.length;
  const after = r.rest();
  for (const [shape, open, close] of BRACKETS) {
    if (!after.startsWith(open)) continue;
    let j = open.length;
    let label: string;
    if (after[j] === '"') {
      const end = after.indexOf('"', j + 1);
      if (end < 0) continue;
      label = after.slice(j + 1, end);
      j = end + 1;
      if (!after.startsWith(close, j)) continue;
    } else {
      const end = after.indexOf(close, j);
      if (end < 0) continue;
      label = after.slice(j, end);
      // The text can't hold the closer's last bracket, or this closer belongs to a later shape:
      // `A[/x\] --> B[/y/]` is a trapezoid, not a parallelogram running to the end.
      if (label.includes(close[close.length - 1])) continue;
      j = end;
    }
    r.i += j + close.length;
    return { id, label: label.trim(), shape };
  }
  return { id };
}

/** Reads a line like `-->`, `-- text -->`, `-.->|text|`, `<==>`. Returns null if there's no line here. */
function readLink(r: Reader): Omit<FlowEdge, 'from' | 'to'> | null {
  r.skipSpace();
  const rest = r.rest();
  const fromEnd = (body: string): { style: LineStyle; extra: number } | null => {
    if (/^-{2,}$/.test(body)) return { style: 'solid', extra: body.length - 2 };
    if (/^-\.+-$/.test(body)) return { style: 'dotted', extra: body.length - 3 };
    if (/^={2,}$/.test(body)) return { style: 'thick', extra: body.length - 2 };
    return null;
  };
  // A label written inside the line: `-- text -->`, `-. text .->`, `== text ==>`.
  const t = /^(<?)(--|-\.|==)\s+(.+?)\s+(-{2,}|\.-+|={2,})([>ox]?)(?=\s|$|[\p{L}\p{N}_])/u.exec(rest);
  if (t) {
    const [all, lt, open, text, close, head] = t;
    const style: LineStyle = open === '==' ? 'thick' : open === '-.' ? 'dotted' : 'solid';
    const matches = (style === 'thick' && close[0] === '=') || (style === 'dotted' && close[0] === '.') || (style === 'solid' && close[0] === '-');
    if (matches) {
      r.i += all.length;
      const extra = Math.max(0, close.length - 2 - (head || style === 'dotted' ? 0 : 1));
      return { label: unquote(text), style, head: head as Head, both: lt === '<', extra };
    }
  }
  const p = /^(<?)(-{2,}|-\.+-|={2,})([>ox]?)/.exec(rest);
  if (!p) return null;
  const kind = fromEnd(p[2]);
  if (!kind) return null;
  r.i += p[0].length;
  let label = '';
  r.skipSpace();
  const pipe = /^\|([^|]*)\|/.exec(r.rest());
  if (pipe) {
    label = unquote(pipe[1].trim());
    r.i += pipe[0].length;
  }
  // `---` and `===` are the shortest lines with no arrow head, so they count as no extra length.
  if (!p[3] && kind.style !== 'dotted') kind.extra = Math.max(0, kind.extra - 1);
  return { label, ...kind, head: p[3] as Head, both: p[1] === '<' };
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseFlowchart(code: string): ParseResult {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  const prefix: string[] = [];
  let i = 0;
  // Front matter: a block between two `---` lines at the very top.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end < 0) return { ok: false, reason: 'The settings block at the top (between --- lines) is not closed.' };
    prefix.push(...lines.slice(0, end + 1));
    i = end + 1;
  }
  // Blank lines, comments and %%{init}%% directives before the first line belong with the prefix.
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('%%'))) {
    if (lines[i].trim()) prefix.push(lines[i]);
    i++;
  }
  const head = /^\s*(flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*;?\s*$/.exec(lines[i] ?? '');
  if (!head) {
    const first = /^\s*(?:flowchart|graph)\s+(.*)$/.exec(lines[i] ?? '');
    if (first) return { ok: false, reason: `The visual editor doesn't understand "${first[1].trim()}" after the diagram type.` };
    return { ok: false, reason: 'The visual editor works with flowcharts only. Other diagram types can be edited as code.' };
  }
  const chart: Flowchart = {
    prefix,
    keyword: head[1] as 'flowchart' | 'graph',
    direction: (head[2] as Direction) ?? 'TD',
    nodes: [],
    edges: [],
    extras: [],
  };
  const byId = new Map<string, FlowNode>();
  const node = (n: { id: string; label?: string; shape?: Shape }) => {
    let found = byId.get(n.id);
    if (!found) {
      found = { id: n.id, label: n.id, shape: 'none' };
      byId.set(n.id, found);
      chart.nodes.push(found);
    }
    if (n.shape) {
      found.shape = n.shape;
      found.label = n.label ?? '';
    }
    return found;
  };

  for (let n = i + 1; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    if (line.startsWith('%%') || KEEP.test(line)) {
      chart.extras.push(lines[n].trimEnd());
      continue;
    }
    if (/^(subgraph|end|direction)\b/.test(line)) return { ok: false, reason: 'This diagram uses groups (subgraph), which the visual editor can\'t show yet.' };
    for (const stmt of statements(line)) {
      if (stmt.includes('@{') || /\w@-/.test(stmt)) return { ok: false, reason: 'This diagram uses Mermaid\'s newer "@{ }" syntax, which the visual editor can\'t show yet.' };
      if (stmt.includes(':::')) return { ok: false, reason: 'This diagram uses ":::" class shortcuts, which the visual editor can\'t show yet.' };
      const r = new Reader(stmt);
      const first = readNode(r);
      if (!first) return { ok: false, reason: `The visual editor couldn't read this line: ${stmt}` };
      if (RESERVED.has(first.id)) return { ok: false, reason: `"${first.id}" can't be used as a shape name.` };
      let prev = node(first);
      while (!r.done()) {
        if (r.rest().startsWith('&')) return { ok: false, reason: 'This diagram uses "&" to join several shapes at once, which the visual editor can\'t show yet.' };
        const link = readLink(r);
        const next = link && readNode(r);
        if (!link || !next) return { ok: false, reason: `The visual editor couldn't read this line: ${stmt}` };
        const to = node(next);
        chart.edges.push({ from: prev.id, to: to.id, ...link });
        prev = to;
      }
    }
  }
  return { ok: true, chart };
}

/** A label in quotes when it holds characters Mermaid would read as syntax. */
function nodeLabel(label: string): string {
  if (label === '') return '" "';
  if (/^[\p{L}\p{N} _.,:!?'’-]+$/u.test(label) && !/^\s|\s$/.test(label)) return label;
  return `"${label.replaceAll('"', '#quot;')}"`;
}

function edgeLabel(label: string): string {
  if (/["|]/.test(label)) return `"${label.replaceAll('"', '#quot;').replaceAll('|', '#124;')}"`;
  return label;
}

function writeNode(n: FlowNode): string {
  if (n.shape === 'none') return n.id;
  const [, open, close] = BRACKETS.find(([s]) => s === n.shape)!;
  return `${n.id}${open}${nodeLabel(n.label)}${close}`;
}

export function writeLink(e: Pick<FlowEdge, 'style' | 'head' | 'both' | 'extra' | 'label'>): string {
  const x = e.extra;
  const body = e.style === 'thick' ? '='.repeat(2 + x) : e.style === 'dotted' ? `-${'.'.repeat(1 + x)}-` : '-'.repeat(2 + x);
  // A line with no arrow head and two characters needs a third to be a line: `---`, `===`.
  const open = e.both && e.head ? '<' : '';
  const line = !e.head && e.style !== 'dotted' ? body + body[0] : body;
  const label = e.label ? `|${edgeLabel(e.label)}|` : '';
  return `${open}${line}${e.head}${label}`;
}

export function writeFlowchart(c: Flowchart): string {
  const out = [...c.prefix, `${c.keyword} ${c.direction}`];
  // Shapes first, so each label is written once, then the lines between them.
  // A shape with no text of its own needs its own line only if no line mentions it.
  const linked = new Set(c.edges.flatMap((e) => [e.from, e.to]));
  for (const n of c.nodes) if (n.shape !== 'none' || !linked.has(n.id)) out.push('    ' + writeNode(n));
  for (const e of c.edges) out.push(`    ${e.from} ${writeLink(e)} ${e.to}`);
  out.push(...c.extras);
  return out.join('\n') + '\n';
}

/** An id not yet used in the chart: n1, n2, ... */
export function newNodeId(c: Flowchart): string {
  const used = new Set(c.nodes.map((n) => n.id));
  for (let k = c.nodes.length + 1; ; k++) if (!used.has('n' + k)) return 'n' + k;
}

/**
 * The id Mermaid gives line `index` in its drawing: `L_A_B_0` for the first line from A to B, then
 * `L_A_B_2`, `L_A_B_3` (Mermaid skips 1).
 */
export function edgeDomId(c: Flowchart, index: number): string {
  const e = c.edges[index];
  const before = c.edges.slice(0, index).filter((x) => x.from === e.from && x.to === e.to).length;
  return `L_${e.from}_${e.to}_${before === 0 ? 0 : before + 1}`;
}

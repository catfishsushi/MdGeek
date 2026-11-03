// The diagram editor: a dialog with two tabs over the same Mermaid code.
// Visual: add shapes, drag from one shape to another to connect them, click a shape or line to change
// its text and look. Mermaid does the layout. Works for flowcharts.
// Code: the Mermaid text with a live preview. Works for every diagram type Mermaid knows.
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { drawDiagram, escapeHtml, mermaidSupport } from './diagram';
import {
  type FlowEdge,
  type Flowchart,
  type Head,
  type LineStyle,
  type Shape,
  SHAPE_NAMES,
  edgeDomId,
  newNodeId,
  parseFlowchart,
  writeFlowchart,
} from './flowchart';

export interface DiagramEditorOptions {
  code: string;
  /** Colours for the code editor, matching the app's source view. */
  look: Extension[];
  onSave: (code: string) => void;
  /** Runs when the dialog closes, saved or not. */
  onClose?: () => void;
}

/** A starting diagram for a new one. */
export const STARTER_DIAGRAM = 'flowchart TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[Do it]\n    B -->|No| D[Skip it]\n';

// Small outlines for the toolbar's add-a-shape buttons.
const SHAPE_ICONS: [Shape, string][] = [
  ['rect', '<rect x="3" y="6" width="18" height="12" rx="1"/>'],
  ['round', '<rect x="3" y="6" width="18" height="12" rx="4"/>'],
  ['stadium', '<rect x="2" y="7" width="20" height="10" rx="5"/>'],
  ['diamond', '<path d="M12 3l9 9-9 9-9-9z"/>'],
  ['circle', '<circle cx="12" cy="12" r="8"/>'],
  ['cylinder', '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/>'],
  ['hexagon', '<path d="M7 5h10l5 7-5 7H7l-5-7z"/>'],
  ['parallelogram', '<path d="M7 6h15l-5 12H2z"/>'],
];

const ENDS: { key: string; label: string; head: Head; both: boolean }[] = [
  { key: 'arrow', label: 'Arrow', head: '>', both: false },
  { key: 'both', label: 'Arrows both ways', head: '>', both: true },
  { key: 'none', label: 'No arrow', head: '', both: false },
  { key: 'circle', label: 'Circle end', head: 'o', both: false },
  { key: 'cross', label: 'Cross end', head: 'x', both: false },
];

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; index: number } | null;

const icon = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export function openDiagramEditor(opts: DiagramEditorOptions): void {
  const dlg = document.createElement('dialog');
  dlg.className = 'dg';
  dlg.setAttribute('aria-label', 'Edit diagram');
  dlg.innerHTML = `
    <header class="dg-head">
      <div class="dg-title">Edit diagram</div>
      <div class="seg" role="tablist">
        <button class="seg-b" role="tab" data-tab="visual">Visual</button>
        <button class="seg-b" role="tab" data-tab="code">Code</button>
      </div>
      <div class="dg-actions">
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn pri" data-act="save">Save</button>
      </div>
    </header>
    <section class="dg-pane dg-visual" role="tabpanel">
      <div class="dg-tools" role="toolbar" aria-label="Diagram tools">
        <span class="dg-k">Add</span>
        ${SHAPE_ICONS.map(([s, i]) => `<button class="dg-tb" data-add="${s}" title="Add ${SHAPE_NAMES[s as Exclude<Shape, 'none'>]}" aria-label="Add ${SHAPE_NAMES[s as Exclude<Shape, 'none'>]}">${icon(i)}</button>`).join('')}
        <span class="dg-gap"></span>
        <button class="dg-tb" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>')}</button>
        <button class="dg-tb" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo">${icon('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>')}</button>
        <label class="dg-dir"><span class="dg-k">Direction</span>
          <select data-field="direction">
            <option value="TD">Top to bottom</option>
            <option value="BT">Bottom to top</option>
            <option value="LR">Left to right</option>
            <option value="RL">Right to left</option>
          </select>
        </label>
      </div>
      <div class="dg-work">
        <div class="dg-canvas" tabindex="-1"></div>
        <aside class="dg-props" aria-live="polite"></aside>
      </div>
    </section>
    <section class="dg-pane dg-code" role="tabpanel" hidden>
      <div class="dg-cm"></div>
      <div class="dg-side">
        <div class="dg-preview"></div>
        <div class="dg-error" role="status"></div>
      </div>
    </section>
    <svg class="dg-rubber" aria-hidden="true"><line/></svg>`;
  document.body.appendChild(dlg);

  const q = <T extends Element>(sel: string) => dlg.querySelector<T>(sel)!;
  const canvas = q<HTMLDivElement>('.dg-canvas');
  const props = q<HTMLElement>('.dg-props');
  const visualPane = q<HTMLElement>('.dg-visual');
  const codePane = q<HTMLElement>('.dg-code');
  const preview = q<HTMLDivElement>('.dg-preview');
  const errorBox = q<HTMLDivElement>('.dg-error');
  const dirSelect = q<HTMLSelectElement>('[data-field="direction"]');
  const rubber = q<SVGSVGElement>('.dg-rubber');
  const rubberLine = rubber.querySelector('line')!;

  let code = opts.code;
  let chart: Flowchart | null = null;
  let reason = '';
  let sel: Selection = null;
  let tab: 'visual' | 'code' = 'visual';
  const undo: string[] = [];
  const redo: string[] = [];
  let cm: EditorView | null = null;
  let closed = false;

  function reparse(): void {
    const r = parseFlowchart(code);
    chart = r.ok ? r.chart : null;
    reason = r.ok ? '' : r.reason;
    const s = sel;
    if (s?.kind === 'node' && !chart?.nodes.some((n) => n.id === s.id)) sel = null;
    if (sel?.kind === 'edge' && !chart?.edges[sel.index]) sel = null;
  }

  /** Changes the chart from the visual tab: remembers the old code for undo, then redraws. */
  function change(edit: (c: Flowchart) => void, opts2: { redraw?: 'now' | 'soon'; keepUndo?: boolean } = {}): void {
    if (!chart) return;
    if (!opts2.keepUndo) {
      undo.push(code);
      redo.length = 0;
    }
    edit(chart);
    code = writeFlowchart(chart);
    if (opts2.redraw === 'soon') drawSoon();
    else void drawVisual();
    updateTools();
  }

  function restore(to: string): void {
    code = to;
    reparse();
    void drawVisual();
    renderProps();
    updateTools();
  }

  // ---------- Drawing ----------

  let drawGen = 0;
  async function drawVisual(): Promise<void> {
    const gen = ++drawGen;
    const r = await drawDiagram(code);
    if (gen !== drawGen || closed) return;
    if ('error' in r) {
      canvas.innerHTML = `<div class="dg-msg dg-bad">${escapeHtml(r.error)}</div>`;
      return;
    }
    canvas.innerHTML = r.svg;
    if (!chart) {
      canvas.insertAdjacentHTML('afterbegin', `<div class="dg-msg">${escapeHtml(reason)} <button class="btn" data-act="to-code">Edit as code</button></div>`);
      return;
    }
    decorate();
  }
  let drawTimer = 0;
  function drawSoon(): void {
    clearTimeout(drawTimer);
    drawTimer = window.setTimeout(() => void drawVisual(), 250);
  }

  /** Marks the drawn shapes and lines so they can be clicked, and shows what's selected. */
  function decorate(): void {
    const svg = canvas.querySelector('svg');
    if (!svg || !chart) return;
    for (const g of svg.querySelectorAll<SVGGElement>('g.node')) {
      // Mermaid names each shape's group "<diagram>-flowchart-<id>-<number>".
      const id = g.dataset.id ?? /-flowchart-(.+)-\d+$/.exec(g.id)?.[1];
      const n = chart.nodes.find((x) => x.id === id);
      if (!n) continue;
      g.dataset.id = n.id;
      g.classList.add('dg-node');
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `Shape: ${n.label || n.id}`);
      g.classList.toggle('dg-sel', sel?.kind === 'node' && sel.id === n.id);
    }
    // Lines are thin, so each gets a wide see-through copy on top that's easy to click.
    chart.edges.forEach((_e, i) => {
      const path = svg.querySelector<SVGPathElement>(`path[data-id="${CSS.escape(edgeDomId(chart!, i))}"]`);
      if (!path) return;
      const hit = path.cloneNode(false) as SVGPathElement;
      hit.removeAttribute('id');
      hit.removeAttribute('style');
      hit.removeAttribute('marker-start');
      hit.removeAttribute('marker-end');
      hit.setAttribute('class', 'dg-hit' + (sel?.kind === 'edge' && sel.index === i ? ' dg-sel' : ''));
      hit.dataset.edge = String(i);
      path.after(hit);
      const label = svg.querySelector(`.edgeLabel [data-id="${CSS.escape(edgeDomId(chart!, i))}"]`);
      label?.closest('.edgeLabel')?.setAttribute('data-edge-index', String(i));
    });
  }

  function select(next: Selection): void {
    sel = next;
    labelTyping = false;
    for (const g of canvas.querySelectorAll('.dg-node')) g.classList.toggle('dg-sel', next?.kind === 'node' && (g as SVGGElement).dataset.id === next.id);
    for (const h of canvas.querySelectorAll<SVGPathElement>('.dg-hit')) h.classList.toggle('dg-sel', next?.kind === 'edge' && h.dataset.edge === String(next.index));
    renderProps();
    updateTools();
  }

  // ---------- The side panel ----------

  const shapeOptions = (current: Shape) =>
    Object.entries(SHAPE_NAMES)
      .map(([k, v]) => `<option value="${k}"${k === current || (current === 'none' && k === 'rect') ? ' selected' : ''}>${v}</option>`)
      .join('');

  function renderProps(): void {
    if (!chart) {
      props.innerHTML = '';
      return;
    }
    if (sel?.kind === 'node') {
      const n = chart.nodes.find((x) => x.id === (sel as { id: string }).id)!;
      const others = chart.nodes.filter((x) => x.id !== n.id);
      props.innerHTML = `
        <h3>Shape</h3>
        <label class="dg-f"><span>Text</span><input data-field="label" value="${escapeHtml(n.label)}"></label>
        <label class="dg-f"><span>Outline</span><select data-field="shape">${shapeOptions(n.shape)}</select></label>
        <label class="dg-f"><span>Connect to</span><select data-field="connect"${others.length ? '' : ' disabled'}>
          <option value="">Choose a shape…</option>
          ${others.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label || o.id)}</option>`).join('')}
        </select></label>
        <div class="dg-row"><button class="btn" data-act="delete">Delete shape</button></div>
        <p class="dg-id">Name in the code: <code>${escapeHtml(n.id)}</code></p>`;
    } else if (sel?.kind === 'edge') {
      const e = chart.edges[sel.index];
      const end = ENDS.find((x) => x.head === e.head && x.both === (e.both && !!e.head))?.key ?? 'arrow';
      const name = (id: string) => escapeHtml(chart!.nodes.find((n) => n.id === id)?.label || id);
      props.innerHTML = `
        <h3>Line</h3>
        <p class="dg-id">${name(e.from)} → ${name(e.to)}</p>
        <label class="dg-f"><span>Text</span><input data-field="label" value="${escapeHtml(e.label)}" placeholder="None"></label>
        <label class="dg-f"><span>Style</span><select data-field="style">
          ${(['solid', 'dotted', 'thick'] as LineStyle[]).map((s) => `<option value="${s}"${s === e.style ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
        </select></label>
        <label class="dg-f"><span>Ends</span><select data-field="ends">
          ${ENDS.map((x) => `<option value="${x.key}"${x.key === end ? ' selected' : ''}>${x.label}</option>`).join('')}
        </select></label>
        <div class="dg-row"><button class="btn" data-act="reverse">Reverse</button><button class="btn" data-act="delete">Delete line</button></div>`;
    } else {
      props.innerHTML = `
        <h3>How to</h3>
        <p>Add a shape with the buttons above. If a shape is selected, the new one is connected to it.</p>
        <p>Drag from one shape to another to connect them, or use <b>Connect to</b> on a selected shape.</p>
        <p>Click a shape or line to change its text and look. Double-click a shape to type its text. Delete removes what's selected.</p>`;
    }
  }

  let labelTyping = false; // one undo step per stretch of typing, not one per letter
  props.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.field !== 'label' || !chart || !sel) return;
    const keepUndo = labelTyping;
    labelTyping = true;
    const s = sel;
    change(
      (c) => {
        if (s.kind === 'node') {
          const n = c.nodes.find((x) => x.id === s.id)!;
          n.label = t.value;
          if (n.shape === 'none') n.shape = 'rect';
        } else c.edges[s.index].label = t.value;
      },
      { redraw: 'soon', keepUndo },
    );
  });
  props.addEventListener('focusout', () => (labelTyping = false));
  props.addEventListener('change', (ev) => {
    const t = ev.target as HTMLSelectElement;
    const s = sel;
    if (!chart || !s) return;
    if (t.dataset.field === 'shape' && s.kind === 'node') change((c) => (c.nodes.find((x) => x.id === s.id)!.shape = t.value as Shape));
    else if (t.dataset.field === 'connect' && s.kind === 'node' && t.value) connect(s.id, t.value);
    else if (t.dataset.field === 'style' && s.kind === 'edge') change((c) => (c.edges[s.index].style = t.value as LineStyle));
    else if (t.dataset.field === 'ends' && s.kind === 'edge') {
      const end = ENDS.find((x) => x.key === t.value)!;
      change((c) => Object.assign(c.edges[s.index], { head: end.head, both: end.both }));
    }
  });
  props.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.target as HTMLElement).dataset.field === 'label') {
      ev.preventDefault();
      canvas.focus();
    }
  });

  // ---------- Actions ----------

  function addShape(shape: Shape): void {
    if (!chart) return;
    const id = newNodeId(chart);
    const from = sel?.kind === 'node' ? sel.id : null;
    change((c) => {
      c.nodes.push({ id, label: SHAPE_NAMES[shape as Exclude<Shape, 'none'>], shape });
      if (from) c.edges.push(newEdge(from, id));
    });
    select({ kind: 'node', id });
    focusLabel();
  }

  const newEdge = (from: string, to: string): FlowEdge => ({ from, to, label: '', style: 'solid', head: '>', both: false, extra: 0 });

  function connect(from: string, to: string): void {
    change((c) => c.edges.push(newEdge(from, to)));
    select({ kind: 'edge', index: chart!.edges.length - 1 });
  }

  function deleteSelected(): void {
    const s = sel;
    if (!chart || !s) return;
    change((c) => {
      if (s.kind === 'node') {
        c.nodes = c.nodes.filter((n) => n.id !== s.id);
        c.edges = c.edges.filter((e) => e.from !== s.id && e.to !== s.id);
        // A style or click line for a removed shape would bring it back as a bare box.
        const mentions = new RegExp(`^\\s*(style|click)\\s+${s.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'u');
        c.extras = c.extras.filter((x) => !mentions.test(x));
      } else c.edges.splice(s.index, 1);
    });
    select(null);
  }

  function focusLabel(): void {
    requestAnimationFrame(() => {
      const input = props.querySelector<HTMLInputElement>('[data-field="label"]');
      input?.focus();
      input?.select();
    });
  }

  function updateTools(): void {
    const on = !!chart;
    for (const b of visualPane.querySelectorAll<HTMLButtonElement>('.dg-tools button, .dg-tools select')) b.disabled = !on;
    q<HTMLButtonElement>('[data-act="undo"]').disabled = !on || undo.length === 0;
    q<HTMLButtonElement>('[data-act="redo"]').disabled = !on || redo.length === 0;
    if (chart) dirSelect.value = chart.direction === 'TB' ? 'TD' : chart.direction;
  }

  dirSelect.addEventListener('change', () => change((c) => (c.direction = dirSelect.value as Flowchart['direction'])));

  dlg.addEventListener('click', (ev) => {
    const b = (ev.target as Element).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.add) addShape(b.dataset.add as Shape);
    else if (b.dataset.tab) showTab(b.dataset.tab as 'visual' | 'code');
    else if (b.dataset.act === 'to-code') showTab('code');
    else if (b.dataset.act === 'delete') deleteSelected();
    else if (b.dataset.act === 'reverse' && sel?.kind === 'edge') {
      const i = sel.index;
      change((c) => Object.assign(c.edges[i], { from: c.edges[i].to, to: c.edges[i].from }));
      renderProps();
    } else if (b.dataset.act === 'undo' && undo.length) {
      redo.push(code);
      restore(undo.pop()!);
    } else if (b.dataset.act === 'redo' && redo.length) {
      undo.push(code);
      restore(redo.pop()!);
    } else if (b.dataset.act === 'save') close(true);
    else if (b.dataset.act === 'cancel') close(false);
  });

  // ---------- Pointer: select, and drag between shapes to connect ----------

  const nodeAt = (el: Element | null) => el?.closest<SVGGElement>('.dg-node') ?? null;

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !chart) return;
    const target = ev.target as Element;
    const node = nodeAt(target);
    if (!node) {
      const edgeEl = target.closest<Element>('.dg-hit, [data-edge-index]');
      const index = edgeEl ? Number((edgeEl as HTMLElement).dataset.edge ?? edgeEl.getAttribute('data-edge-index')) : NaN;
      select(Number.isNaN(index) ? null : { kind: 'edge', index });
      return;
    }
    ev.preventDefault(); // no text selection while dragging
    canvas.focus();
    const from = node.dataset.id!;
    const box = node.getBoundingClientRect();
    const x0 = box.left + box.width / 2;
    const y0 = box.top + box.height / 2;
    let dragging = false;
    const move = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < 6) return;
      dragging = true;
      rubber.classList.add('on');
      rubberLine.setAttribute('x1', String(x0));
      rubberLine.setAttribute('y1', String(y0));
      rubberLine.setAttribute('x2', String(e.clientX));
      rubberLine.setAttribute('y2', String(e.clientY));
      for (const g of canvas.querySelectorAll('.dg-target')) g.classList.remove('dg-target');
      const over = nodeAt(document.elementFromPoint(e.clientX, e.clientY));
      if (over && over !== node) over.classList.add('dg-target');
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      rubber.classList.remove('on');
      for (const g of canvas.querySelectorAll('.dg-target')) g.classList.remove('dg-target');
      if (!dragging) {
        select({ kind: 'node', id: from });
        return;
      }
      const over = e.type === 'pointerup' ? nodeAt(document.elementFromPoint(e.clientX, e.clientY)) : null;
      if (over && over.dataset.id && over.dataset.id !== from) connect(from, over.dataset.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  canvas.addEventListener('dblclick', (ev) => {
    const node = nodeAt(ev.target as Element);
    if (node) {
      select({ kind: 'node', id: node.dataset.id! });
      focusLabel();
    }
  });
  // Keyboard: Tab moves between shapes, Enter or Space selects one.
  canvas.addEventListener('keydown', (ev) => {
    const node = nodeAt(ev.target as Element);
    if (node && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      select({ kind: 'node', id: node.dataset.id! });
      focusLabel();
    }
  });

  dlg.addEventListener('keydown', (ev) => {
    if (tab !== 'visual') return;
    const t = ev.target as HTMLElement;
    if (t.closest('input, select, textarea, .cm-editor')) return;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel) {
      ev.preventDefault();
      deleteSelected();
    } else if (ctrl && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      q<HTMLButtonElement>('[data-act="undo"]').click();
    } else if (ctrl && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) {
      ev.preventDefault();
      q<HTMLButtonElement>('[data-act="redo"]').click();
    }
  });

  // ---------- Code tab ----------

  let previewGen = 0;
  let previewTimer = 0;
  async function drawPreview(): Promise<void> {
    const gen = ++previewGen;
    const r = await drawDiagram(code);
    if (gen !== previewGen || closed) return;
    if ('error' in r) {
      errorBox.textContent = r.error;
      errorBox.hidden = false;
      preview.classList.add('dg-stale'); // keep the last good drawing, faded
    } else {
      errorBox.hidden = true;
      preview.classList.remove('dg-stale');
      preview.innerHTML = r.svg;
    }
  }

  function showTab(next: 'visual' | 'code'): void {
    tab = next;
    for (const b of dlg.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      b.classList.toggle('active', b.dataset.tab === next);
      b.setAttribute('aria-selected', String(b.dataset.tab === next));
    }
    visualPane.hidden = next !== 'visual';
    codePane.hidden = next !== 'code';
    if (next === 'code') {
      if (!cm) {
        cm = new EditorView({
          parent: q('.dg-cm'),
          state: EditorState.create({
            doc: code,
            extensions: [
              history(),
              drawSelection(),
              keymap.of([...defaultKeymap, ...historyKeymap]),
              mermaidSupport,
              ...opts.look,
              EditorView.lineWrapping,
              EditorView.contentAttributes.of({ 'aria-label': 'Mermaid code' }),
              EditorView.updateListener.of((u) => {
                if (!u.docChanged) return;
                code = u.state.doc.toString();
                clearTimeout(previewTimer);
                previewTimer = window.setTimeout(() => void drawPreview(), 300);
              }),
            ],
          }),
        });
      } else if (cm.state.doc.toString() !== code) {
        cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: code } });
      }
      void drawPreview();
      cm.focus();
    } else {
      reparse();
      void drawVisual();
      renderProps();
      updateTools();
    }
  }

  // ---------- Closing ----------

  function close(save: boolean): void {
    if (!save && code !== opts.code && !confirm('Discard your changes to this diagram?')) return;
    closed = true;
    clearTimeout(drawTimer);
    clearTimeout(previewTimer);
    if (save && code !== opts.code) opts.onSave(code);
    cm?.destroy();
    dlg.close();
    dlg.remove();
    opts.onClose?.();
  }
  // Escape asks the dialog to close; route it through the same check as Cancel.
  dlg.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    close(false);
  });

  reparse();
  dlg.showModal();
  showTab(chart ? 'visual' : 'code');
}

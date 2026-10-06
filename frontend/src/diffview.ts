// Side-by-side comparison shown when a file changed on disk while the tab has unsaved edits.
import { diffLines } from 'diff';

interface Row {
  left: string | null;
  right: string | null;
  kind: 'same' | 'change';
}

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Lines the user removed/changed sit next to what the disk version has in their place. */
function buildRows(mine: string, theirs: string): Row[] {
  const rows: Row[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) {
      rows.push({ left: removed[i] ?? null, right: added[i] ?? null, kind: 'change' });
    }
    removed = [];
    added = [];
  };
  for (const part of diffLines(mine, theirs)) {
    const lines = splitLines(part.value);
    if (part.removed) removed.push(...lines);
    else if (part.added) added.push(...lines);
    else {
      flush();
      for (const l of lines) rows.push({ left: l, right: l, kind: 'same' });
    }
  }
  flush();
  return rows;
}

function cell(text: string | null, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'diff-cell' + (text === null ? '' : ' ' + cls);
  el.textContent = text ?? '';
  return el;
}

export type Resolution = 'mine' | 'theirs' | 'cancel';

/** Shows the diff in the modal and resolves with the user's choice. */
export function showDiff(modal: HTMLElement, fileName: string, mine: string, theirs: string): Promise<Resolution> {
  return new Promise((resolve) => {
    const dialog = document.createElement('div');
    dialog.className = 'dialog';

    const head = document.createElement('div');
    head.className = 'dialog-head';
    head.textContent = `Differences in ${fileName}`;

    const diff = document.createElement('div');
    diff.className = 'diff';
    const cols = document.createElement('div');
    cols.className = 'diff-cols';
    cols.innerHTML = '<div>Your version (in this app)</div><div>Version on disk</div>';
    diff.appendChild(cols);
    for (const row of buildRows(mine, theirs)) {
      const r = document.createElement('div');
      r.className = 'diff-row';
      r.append(cell(row.left, row.kind === 'change' ? 'del' : ''), cell(row.right, row.kind === 'change' ? 'add' : ''));
      diff.appendChild(r);
    }

    const foot = document.createElement('div');
    foot.className = 'dialog-foot';
    const done = (r: Resolution) => {
      modal.hidden = true;
      modal.replaceChildren();
      resolve(r);
    };
    for (const [label, r] of [
      ['Cancel', 'cancel'],
      ['Take disk version', 'theirs'],
      ['Keep my version', 'mine'],
    ] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => done(r));
      foot.appendChild(b);
    }

    dialog.append(head, diff, foot);
    modal.replaceChildren(dialog);
    modal.hidden = false;
  });
}

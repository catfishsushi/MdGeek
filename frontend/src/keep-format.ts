// The WYSIWYG editor doesn't keep the file's text: on every edit it writes the whole document out again
// in its own style. Tables get re-padded, dividers redrawn, line endings become "\n", and so on. Saving
// that as-is would rewrite every line of the file for a one-word change.
//
// So each edit is merged back into the original text, the way git merges two branches (a three-way
// merge). The common ancestor is what the editor writes for the file as loaded; one side is the
// original file (which differs from it only in formatting), the other is what the editor writes now
// (which differs only by the user's edits). Lines the user didn't touch keep their original text.
import { diffArrays } from 'diff';

/** For each line of `base`, the index of the same line in `other`, or -1 if it has none. */
function matchLines(base: string[], other: string[]): number[] {
  const match = new Array<number>(base.length).fill(-1);
  let i = 0;
  let j = 0;
  for (const part of diffArrays(base, other)) {
    const n = part.count ?? part.value.length;
    if (part.added) j += n;
    else if (part.removed) i += n;
    else for (let x = 0; x < n; x++) match[i++] = j++;
  }
  return match;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

// Table rows are compared by their cells, ignoring the padding and dash counts the editor adds, so
// editing one cell changes only that row rather than the whole table.
const isRow = (line: string) => line.trimStart().startsWith('|');
const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\||(?<!\\)\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
const loose = (line: string) =>
  isRow(line) ? cellsOf(line).map((c) => c.replace(/-+/g, '-').replace(/\s+/g, ' ')).join('|') : line;
/** A row written without padding: `| a | b |`. */
const compact = (line: string) => `| ${cellsOf(line).join(' | ')} |`;

/**
 * A stretch both sides changed: the original formatted it differently, and the user edited it too.
 * Usually that's a table with a cell edited, which has the same number of rows in all three versions.
 * Then rows the user didn't change keep their original text, and a changed row follows the original's
 * style if that was unpadded. Anything else takes the editor's version.
 */
function mergeChanged(b: string[], o: string[], n: string[]): string[] {
  if (b.length !== o.length || b.length !== n.length) return n;
  return n.map((line, x) => {
    if (loose(line) === loose(b[x])) return o[x];
    if (isRow(line) && isRow(o[x]) && o[x].trim() === compact(o[x])) return compact(line);
    return line;
  });
}

/**
 * The original text with the user's edits applied. `base` is what the editor wrote for the original,
 * `edited` is what it writes now. Where the user changed something the original had formatted
 * differently (say, a cell of a table), the editor's version of that part is used.
 */
export function keepFormatting(original: string, base: string, edited: string): string {
  if (edited === base) return original;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const O = original.replace(/\r\n/g, '\n').split('\n');
  const B = base.split('\n');
  const N = edited.split('\n');
  const toO = matchLines(B, O);
  const toN = matchLines(B, N);

  const out: string[] = [];
  let i = 0; // line in base
  let j = 0; // line in original
  let k = 0; // line in edited
  while (i < B.length || j < O.length || k < N.length) {
    // A line all three share: copy it and move on.
    if (i < B.length && toO[i] === j && toN[i] === k) {
      out.push(O[j]);
      i++, j++, k++;
      continue;
    }
    // Otherwise take the stretch up to the next line all three share, and see which side changed it.
    let s = i + 1;
    while (s < B.length && (toO[s] < 0 || toN[s] < 0)) s++;
    const oEnd = s < B.length ? toO[s] : O.length;
    const nEnd = s < B.length ? toN[s] : N.length;
    const b = B.slice(Math.min(i, B.length), s);
    const o = O.slice(j, oEnd);
    const n = N.slice(k, nEnd);
    // Untouched by the user: keep the original's formatting. Changed only by the user: take the edit.
    out.push(...(sameLines(b, n) ? o : sameLines(b, o) ? n : mergeChanged(b, o, n)));
    i = s;
    j = oEnd;
    k = nEnd;
  }
  return out.join(eol);
}

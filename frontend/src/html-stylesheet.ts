// Reading and changing CSS text in a page's <style> blocks, keeping everything else in the block as it
// was: comments, layout, and rules written by hand. MdGeek writes each of its rules on one line, as
// "selector { property: value; … }", and finds them again by their selector.

const UI = 'data-mdg-ui'; // elements the editor adds to the page, which are never saved

/** One top-level rule: where its selector starts, where its { is, and the end (just past its }). */
export interface CssRule {
  selector: string;
  start: number;
  open: number;
  end: number;
}

/** The top-level rules in a style sheet's text. An @media block counts as one rule. */
export function topRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let depth = 0;
  let start = -1;
  let open = -1;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) j += css[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (depth === 0 && start < 0 && !/\s/.test(ch) && ch !== '}' && ch !== ';') start = i;
    if (ch === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        rules.push({ selector: css.slice(start, open).trim().replace(/\s+/g, ' '), start, open, end: i + 1 });
        start = -1;
      }
    } else if (ch === ';' && depth === 0) {
      start = -1; // an @import or similar
    }
  }
  return rules;
}

/** A rule's declarations, as property → value, in order. */
export function declarations(css: string, rule: CssRule): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of css.slice(rule.open + 1, rule.end - 1).split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (prop && value) out.set(prop, value);
  }
  return out;
}

/** The indent the sheet's rules use, so new rules line up with them. */
function ruleIndent(css: string): string {
  const m = /\n([ \t]*)\S/.exec(css);
  return m ? m[1] : '  ';
}

/**
 * The sheet's text with the rule for `selector` set to these declarations: changed where it is, or added
 * at the end. With no declarations, the rule is taken out.
 */
export function setRule(css: string, selector: string, decls: Map<string, string>): string {
  const rule = topRules(css).find((r) => r.selector === selector);
  const text = `${selector} { ${Array.from(decls, ([k, v]) => `${k}: ${v};`).join(' ')} }`;
  if (rule) {
    if (decls.size) return css.slice(0, rule.start) + text + css.slice(rule.end);
    // Take the line break and indent before the rule too, so no blank line is left.
    const lineStart = css.lastIndexOf('\n', rule.start - 1);
    const from = lineStart >= 0 && !css.slice(lineStart, rule.start).trim() ? lineStart : rule.start;
    return css.slice(0, from) + css.slice(rule.end);
  }
  if (!decls.size) return css;
  return appendLines(css, [text]);
}

/** The sheet's text with these lines added at the end, lined up with its rules. */
export function appendLines(css: string, lines: string[]): string {
  const tail = /\s*$/.exec(css)![0];
  const indent = ruleIndent(css);
  return css.slice(0, css.length - tail.length) + lines.map((l) => `\n${indent}${l}`).join('') + (tail || '\n');
}

/** Takes out every rule whose selector passes the test. */
export function removeRules(css: string, test: (selector: string) => boolean): string {
  for (const r of topRules(css).reverse()) if (test(r.selector)) css = setRule(css, r.selector, new Map());
  return css;
}

/** The page's own <style> blocks in <head>, in order. */
export function headStyleBlocks(doc: Document): HTMLStyleElement[] {
  return Array.from(doc.head.querySelectorAll<HTMLStyleElement>(':scope > style')).filter((s) => !s.hasAttribute(UI));
}

/**
 * A block that applies to the whole page, so its rules can be moved into another such block without
 * changing anything. A block with media="print" or similar applies only sometimes, so it stays apart.
 */
const isPlain = (s: HTMLStyleElement) => Array.from(s.attributes).every((a) => a.name === 'id' || a.name === 'type');

/** The page's style block: the first plain <style> in <head>, or null if it has none. */
export function pageSheet(doc: Document): HTMLStyleElement | null {
  return headStyleBlocks(doc).find(isPlain) ?? null;
}

/**
 * Moves every plain <style> block in <head> into the first one, so the page's CSS is in one place.
 * A rule whose selector the first block already has is merged into that rule (its settings win, as
 * they did coming later), and a comment the first block already has isn't copied twice.
 * Returns true if anything changed.
 */
export function mergeStyleBlocks(doc: Document): boolean {
  const [first, ...rest] = headStyleBlocks(doc).filter(isPlain);
  if (!first || !rest.length) return false;
  let css = first.textContent ?? '';
  for (const block of rest) {
    let more = block.textContent ?? '';
    for (const r of topRules(more).reverse()) {
      if (r.selector.startsWith('@')) continue;
      const mine = topRules(css).find((x) => x.selector === r.selector);
      if (!mine) continue;
      const decls = declarations(css, mine);
      for (const [k, v] of declarations(more, r)) decls.set(k, v);
      css = setRule(css, r.selector, decls);
      more = more.slice(0, r.start) + more.slice(r.end);
    }
    more = more.replace(/\/\*[\s\S]*?\*\//g, (c) => (css.includes(c) ? '' : c));
    const lines = more.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) css = appendLines(css, lines);
    // Take the line break and indent before the block too, so no blank line is left in <head>.
    if (isBlank(block.previousSibling)) block.previousSibling!.remove();
    block.remove();
  }
  first.textContent = css;
  return true;
}

const isBlank = (n: Node | null | undefined) => n?.nodeType === Node.TEXT_NODE && !n.textContent!.trim();

/**
 * Adds a <style> block at the end of <head>, lined up with what's there. `lines` are its rules, one per
 * line. A file that's a piece of a page has nothing in <head>, so there the block goes first, unindented.
 */
export function createStyleBlock(doc: Document, id: string | null, lines: string[]): HTMLStyleElement {
  const head = doc.head;
  const style = doc.createElement('style');
  if (id) style.id = id;
  const own = (n: Node) => !(n.nodeType === Node.ELEMENT_NODE && (n as Element).hasAttribute(UI));
  if (!Array.from(head.childNodes).some(own)) {
    style.textContent = lines.map((l) => `\n  ${l}`).join('') + '\n';
    head.insertBefore(doc.createTextNode('\n'), head.firstChild);
    head.insertBefore(style, head.firstChild);
    return style;
  }
  const first = Array.from(head.childNodes).find(isBlank)?.textContent ?? '\n  ';
  const indent = first.slice(first.lastIndexOf('\n') + 1);
  style.textContent = lines.map((l) => `\n${indent}  ${l}`).join('') + `\n${indent}`;
  // The editor's own hidden elements at the end of <head> aren't saved, so the block goes before them.
  let last = head.lastChild;
  while (last && !own(last)) last = last.previousSibling;
  const closing = isBlank(last) ? last : null;
  const before = closing ?? (last ? last.nextSibling : head.firstChild);
  head.insertBefore(doc.createTextNode(`\n${indent}`), before);
  head.insertBefore(style, before);
  if (!closing) head.insertBefore(doc.createTextNode('\n'), before);
  return style;
}

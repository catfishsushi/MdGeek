// Draws Mermaid diagrams. Mermaid is large, so it's loaded the first time a diagram is shown.
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import DOMPurify from 'dompurify';
import type { Mermaid } from 'mermaid';

let loading: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;
let darkTheme = false;

/** Called when the app theme changes. Diagrams drawn after this use Mermaid's dark or light colours. */
export function setDiagramDark(dark: boolean): void {
  darkTheme = dark;
}
export const diagramDark = () => darkTheme;

function mermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default);
  return loading;
}

export type DrawResult = { svg: string } | { error: string };

/**
 * Draws Mermaid code as an SVG string, or explains why it can't. Mermaid can only draw one diagram at a
 * time, so calls wait their turn.
 */
export function drawDiagram(code: string, dark = darkTheme): Promise<DrawResult> {
  const run = queue.then(async (): Promise<DrawResult> => {
    const m = await mermaid();
    // 'strict' makes Mermaid clean labels of HTML and turn off click actions that run scripts.
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'inherit' });
    const id = `mdg-diagram-${++counter}`;
    try {
      await m.parse(code);
      const { svg } = await m.render(id, code);
      return { svg: cleanSvg(svg) };
    } catch (e) {
      return { error: errorText(e) };
    } finally {
      // Mermaid leaves its scratch element behind when drawing fails.
      document.getElementById('d' + id)?.remove();
      document.getElementById(id)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error:\s*/, '').trim() || 'Mermaid could not read this diagram.';
}

/**
 * A second cleaning pass on Mermaid's output, since it goes straight into the page. Flowchart labels
 * are HTML inside a <foreignObject>, which is allowed only within the SVG.
 */
const purify = DOMPurify();
purify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'foreignobject' && (node as Element).parentElement?.namespaceURI !== 'http://www.w3.org/2000/svg')
    node.parentNode?.removeChild(node);
});
function cleanSvg(svg: string): string {
  return purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject', 'style'],
    ADD_ATTR: ['xmlns', 'dominant-baseline', 'data-id', 'data-edge', 'data-et'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Colours Mermaid code: the diagram type, arrows, labels in brackets, and comments. */
const mermaidMode = StreamLanguage.define<{ start: boolean }>({
  name: 'mermaid',
  startState: () => ({ start: true }),
  token(stream, state) {
    if (stream.sol()) state.start = true;
    if (stream.eatSpace()) return null;
    if (stream.match('%%')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^"[^"]*"?/)) return 'string';
    if (stream.match(/^\|[^|]*\|?/)) return 'string';
    if (stream.match(/^(<?(-{2,}|-\.+-|={2,})[>ox]?|-->|->>|-->>|--x|-x|-\)|--\)|:::)/)) return 'operator';
    if (stream.match(/^[[\](){}<>\/\\]+/)) return 'bracket';
    const word = stream.match(/^[\p{L}\p{N}_-]+/u) as RegExpMatchArray | null;
    if (word) {
      const first = state.start;
      state.start = false;
      if (first && /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|sankey(-beta)?|xychart(-beta)?|block(-beta)?|packet(-beta)?|kanban|architecture(-beta)?|requirementDiagram|C4\w*|radar(-beta)?|treemap(-beta)?)$/.test(word[0]))
        return 'keyword';
      if (/^(subgraph|end|direction|classDef|class|style|linkStyle|click|participant|actor|loop|alt|else|opt|par|and|note|over|section|title|dateFormat|axisFormat|state)$/.test(word[0])) return 'keyword';
      if (/^(TD|TB|BT|LR|RL)$/.test(word[0])) return 'atom';
      return 'variableName';
    }
    state.start = false;
    stream.next();
    return null;
  },
});
export const mermaidSupport = new LanguageSupport(mermaidMode);
/** So code blocks tagged "mermaid" (or "mmd") get the colouring above and show "Mermaid" as their language. */
export const mermaidLanguage = LanguageDescription.of({ name: 'Mermaid', alias: ['mermaid', 'mmd'], support: mermaidSupport });

export const isMermaid = (lang: string | null | undefined) => /^(mermaid|mmd)$/i.test((lang ?? '').trim());

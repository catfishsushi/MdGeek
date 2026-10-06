// Turns Markdown into safe, GitHub-style HTML. Used for HTML export and PDF printing.
// (The live editor is Milkdown/CodeMirror and does not use this.)
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import hljsCss from 'highlight.js/styles/github.css?inline';
import { dirname, resolveLocal } from './paths';

const md = new MarkdownIt({
  html: true, // raw HTML is allowed in the source, then cleaned by DOMPurify below
  linkify: true,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return ''; // markdown-it escapes it
  },
}).use(taskLists, { enabled: false });

export const documentCss = `
${hljsCss}
body { font-family: -apple-system, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.5; color: #1f2328; max-width: 860px; margin: 24px auto; padding: 0 16px; }
h1, h2 { border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
h1, h2, h3, h4, h5, h6 { margin: 24px 0 16px; line-height: 1.25; }
a { color: #0969da; }
code { background: #eff1f3; padding: .2em .4em; border-radius: 6px; font-size: 85%; }
pre { background: #f6f8fa; padding: 16px; overflow: auto; border-radius: 6px; }
pre code { background: none; padding: 0; font-size: 85%; }
blockquote { margin: 0; padding: 0 1em; color: #656d76; border-left: .25em solid #d0d7de; }
table { border-collapse: collapse; }
th, td { border: 1px solid #d0d7de; padding: 6px 13px; }
tr:nth-child(2n) { background: #f6f8fa; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #d0d7de; }
.task-list-item { list-style: none; }
.task-list-item input { margin: 0 .4em 0 -1.4em; }
`;

/**
 * Renders Markdown to sanitized HTML.
 * With localImages, relative image paths are made loadable inside the app (for printing).
 * Exported files keep the original paths, so they work when saved next to the images.
 */
export function renderBody(markdown: string, filePath: string, localImages: boolean): string {
  const dirty = md.render(markdown);
  const clean = DOMPurify.sanitize(dirty, { ADD_ATTR: ['checked', 'disabled'] });
  if (!localImages) return clean;
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  const base = dirname(filePath);
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src');
    if (src) img.setAttribute('src', resolveLocal(base, src));
  });
  return doc.body.innerHTML;
}

/** A complete standalone HTML file. */
export function renderStandalone(markdown: string, filePath: string, title: string): string {
  const esc = title.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc}</title>
<style>${documentCss}</style>
</head>
<body>
${renderBody(markdown, filePath, false)}
</body>
</html>
`;
}

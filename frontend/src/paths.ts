// Small path helpers. The frontend only needs to handle both Windows (C:\a\b) and Linux (/a/b) styles.

const lastSeparator = (p: string) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));

/** Folder part of a path. */
export function dirname(p: string): string {
  const i = lastSeparator(p);
  if (/^[A-Za-z]:$/.test(p.slice(0, i))) return p.slice(0, i + 1); // drive root keeps its slash
  return i <= 0 ? '/' : p.slice(0, i);
}

/** File name part of a path. */
export function basename(p: string): string {
  return p.slice(lastSeparator(p) + 1);
}

function normalize(p: string): string {
  const parts: string[] = [];
  const unified = p.replace(/\\/g, '/');
  const lead = unified.startsWith('/') ? '/' : '';
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Never pop a Windows drive ("C:")
      if (parts.length > 0 && !/^[A-Za-z]:$/.test(parts[parts.length - 1])) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return lead + parts.join('/');
}

const isRemote = (s: string) => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(s) || /^(data|blob|https?|mailto):/i.test(s);
const isAbsolute = (s: string) => s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s);

/**
 * Turns an image link found in a Markdown file into a URL the app can load.
 * Web and data: links are left alone. Local paths go through the Go /localfile handler.
 */
export function resolveLocal(baseDir: string, src: string): string {
  if (isRemote(src)) return src;
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // keep as is
  }
  const abs = isAbsolute(decoded) ? normalize(decoded) : normalize(baseDir + '/' + decoded);
  return '/localfile?p=' + encodeURIComponent(abs);
}

export type LinkTarget = { kind: 'web'; url: string } | { kind: 'local'; path: string };

/**
 * Works out where a link in a Markdown file points. Relative links are taken from the file's
 * folder. Returns null for links within the same page ("#heading") and for unknown schemes.
 */
export function resolveLink(baseDir: string, href: string): LinkTarget | null {
  if (/^(https?|mailto):/i.test(href)) return { kind: 'web', url: href };
  let p = href;
  if (/^file:/i.test(p)) p = p.replace(/^file:\/*/i, '/').replace(/^\/([A-Za-z]:)/, '$1');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[A-Za-z]:[\\/]/.test(p)) return null;
  p = p.replace(/[?#].*$/, ''); // a "#section" or "?query" part isn't part of the file name
  if (p === '') return null;
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep as is
  }
  const abs = isAbsolute(p) ? normalize(p) : normalize(baseDir + '/' + p);
  // Windows paths go back to backslashes so they match paths from the file tree and dialogs.
  return { kind: 'local', path: /^[A-Za-z]:/.test(abs) ? abs.replace(/\//g, '\\') : abs };
}

/** True for the file types MdGeek edits. Matches isMarkdown in app.go. */
export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

/** Whether two paths name the same file. Windows paths ignore case, as Windows does. */
export function samePath(a: string, b: string): boolean {
  return /^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

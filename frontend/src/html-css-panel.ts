// "Edit styles": the page's CSS in a panel beside the WYSIWYG view, like WordPress's "Additional CSS".
// Every change is written straight into the page's <style> block, so the page restyles as you type,
// and the file saves as usual. The page's CSS lives in one <style> block in <head>: if it was spread over
// several, opening the panel moves it into the first. Only blocks for a media type (print) stay apart. Linked stylesheets (<link href="site.css">) are separate files, so they're only listed.
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { lookExtensions, type SourceLook } from './editors';
import { createStyleBlock, headStyleBlocks } from './html-stylesheet';

export interface CssPanelHost {
  doc: Document;
  look: SourceLook;
  /** Called after each edit, once the page's CSS has changed. */
  edited(): void;
  /** Called as the panel opens: puts the page's CSS into one block, if it was spread over several. */
  gather(): void;
}

export interface CssPanel {
  el: HTMLElement;
  isOpen(): boolean;
  open(): void;
  close(): void;
  /** Shows the page's CSS again after something else changed it (table styling, undo). */
  refresh(): void;
  destroy(): void;
}

export function makeCssPanel(host: CssPanelHost, onToggle: (open: boolean) => void): CssPanel {
  const { doc } = host;
  const el = document.createElement('aside');
  el.className = 'html-css';
  el.hidden = true;
  el.setAttribute('aria-label', 'Page styles');

  const head = document.createElement('div');
  head.className = 'hc-head';
  const title = document.createElement('span');
  title.className = 'hc-title';
  title.textContent = 'Page styles';
  const pick = document.createElement('select');
  pick.ariaLabel = 'Style block';
  pick.hidden = true;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'hc-close';
  close.title = close.ariaLabel = 'Close page styles';
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  head.append(title, pick, close);

  const editorHost = document.createElement('div');
  editorHost.className = 'hc-editor';
  const foot = document.createElement('div');
  foot.className = 'hc-foot';
  el.append(head, editorHost, foot);

  let index = 0; // which <style> block is shown
  let applying = false; // true while the panel itself is setting the editor's text
  const blocks = () => headStyleBlocks(doc);

  const view = new EditorView({
    parent: editorHost,
    state: EditorState.create({
      doc: '',
      extensions: [
        history(),
        lineNumbers(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        css(),
        ...lookExtensions(host.look),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || applying) return;
          // A page with no <style> block gets one on the first keystroke.
          const block = blocks()[index] ?? createStyleBlock(doc, null, []);
          block.textContent = u.state.doc.toString();
          host.edited();
        }),
      ],
    }),
  });

  function fillPicker(): void {
    const list = blocks();
    pick.replaceChildren(...list.map((b, i) => new Option(b.id ? `<style id="${b.id}">` : `Style block ${i + 1}`, String(i))));
    pick.hidden = list.length < 2;
    if (index >= list.length) index = 0;
    pick.value = String(index);
  }
  function fillFoot(): void {
    const links = Array.from(doc.querySelectorAll('link[rel~=stylesheet]')).map(
      (l) => l.getAttribute('data-mdg-was-href') ?? l.getAttribute('href') ?? '',
    );
    const notes = ['Changes show on the page as you type.'];
    if (blocks().length > 1)
      notes.push('Blocks with a media setting (such as print-only styles) are kept separate; pick one in the list above.');
    if (!blocks().length) notes.push('This page has no styles yet; typing here adds a <style> block to its <head>.');
    if (links.length) notes.push(`Also uses ${links.join(', ')}, which ${links.length > 1 ? 'are separate files' : 'is a separate file'}.`);
    foot.textContent = notes.join(' ');
  }
  function show(): void {
    const text = blocks()[index]?.textContent ?? '';
    if (text === view.state.doc.toString()) return;
    applying = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    applying = false;
  }

  pick.addEventListener('change', () => {
    index = Number(pick.value);
    show();
    fillFoot();
  });
  close.addEventListener('click', () => panel.close());

  const panel: CssPanel = {
    el,
    isOpen: () => !el.hidden,
    open() {
      host.gather();
      index = 0;
      fillPicker();
      fillFoot();
      show();
      el.hidden = false;
      onToggle(true);
      view.focus();
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      onToggle(false);
    },
    refresh() {
      if (el.hidden) return;
      fillPicker();
      fillFoot();
      show();
    },
    destroy: () => view.destroy(),
  };
  return panel;
}

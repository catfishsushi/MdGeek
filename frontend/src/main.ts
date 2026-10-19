// Fonts are bundled so the app works offline (and its security policy only allows its own fonts).
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource-variable/exo-2/wght.css';
import '@fontsource-variable/pixelify-sans/wght.css';
import '@fontsource-variable/cinzel/wght.css';
import '@fontsource-variable/eb-garamond/wght.css';
import '@fontsource-variable/eb-garamond/wght-italic.css';
import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import './style.css';
import { backend } from './backend';
import { NeedsPermission } from './backend/errors';
import { applyCrepeTheme, createSourceEditor, createWysiwygEditor, EditorHandle } from './editors';
import { showDiff, Resolution } from './diffview';
import { basename, dirname, isMarkdownPath, resolveLink } from './paths';
import { documentCss, renderPrintable, renderStandalone } from './render';
import { Tree, TreeItem } from './tree';

type View = 'wysiwyg' | 'source';
type ThemeSetting = 'light' | 'dark' | 'retro' | 'scifi' | 'fantasy';

interface Tab {
  path: string;
  content: string; // what the editor currently holds
  savedContent: string; // what we last wrote to or read from disk
  modTime: number; // disk modified time when we last read or wrote
  view: View;
  conflict: { disk: string; diskModTime: number } | null;
  saveTimer: number | null;
  saving: boolean;
  needsPermission: boolean; // the browser must be asked, from a click, before this file can be saved
  scroll: number; // where the editor was scrolled to (0 to 1) when this tab was last hidden
}

/** Two files shown side by side. In the tab bar they're one joined tab. */
interface Split {
  left: Tab;
  right: Tab;
}

/** One entry in the tab bar: a single file, or a split pair. */
type Entry = Tab | Split;

/**
 * One side of the editing area. The right one shows only while a split tab is the current one.
 * A file is open in at most one entry, so it can never show on both sides.
 */
interface Pane {
  el: HTMLElement;
  docHeadEl: HTMLElement;
  bannerEl: HTMLElement;
  editorEl: HTMLElement;
  active: Tab | null; // the file this side should show
  shown: Tab | null; // the file the editor was last built for; differs from active until it's rebuilt
  editor: EditorHandle | null;
  mountToken: number;
}

const AUTOSAVE_MS = 800;
const POLL_MS = 2000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsEl = $('tabs');
const panesEl = $('panes');
const emptyEl = $('empty');
const toastEl = $('toast');
const modalEl = $('modal');

function makePane(): Pane {
  const el = $<HTMLTemplateElement>('pane-tpl').content.firstElementChild!.cloneNode(true) as HTMLElement;
  panesEl.appendChild(el);
  const part = (cls: string) => el.querySelector<HTMLElement>(cls)!;
  const pane: Pane = {
    el,
    docHeadEl: part('.dochead'),
    bannerEl: part('.banner'),
    editorEl: part('.editor'),
    active: null,
    shown: null,
    editor: null,
    mountToken: 0,
  };
  // Clicking or typing in a side makes it the one the toolbar and shortcuts act on.
  el.addEventListener('pointerdown', () => focusPane(pane), true);
  el.addEventListener('focusin', () => focusPane(pane));
  return pane;
}

const panes = [makePane(), makePane()] as const;
let entries: Entry[] = [];
let current: Entry | null = null; // the tab bar entry being shown
let focused: Pane = panes[0];
let defaultView: View = 'wysiwyg';

const isSplitEntry = (e: Entry): e is Split => 'left' in e;
const filesOf = (e: Entry): Tab[] => (isSplitEntry(e) ? [e.left, e.right] : [e]);
const isSplit = () => !!current && isSplitEntry(current);
const allTabs = () => entries.flatMap(filesOf);
/** The tab bar entry a file is in, or undefined once it's closed. */
const entryOf = (tab: Tab) => entries.find((e) => filesOf(e).includes(tab));

// ---------- split divider ----------
// The bar between the two sides follows the separator pattern: drag it with the mouse or a finger, or
// focus it and use the arrow keys (Shift for bigger steps), Home and End. Double-click or Enter puts
// it back in the middle. The position is remembered between sessions.

/** The left (or, stacked on a narrow screen, the top) side's share of the space, as the user set it. */
let splitRatio = 0.5;

const splitter = document.createElement('div');
splitter.className = 'splitter';
splitter.tabIndex = 0;
splitter.hidden = true;
splitter.title = 'Drag to resize. Double-click to make both sides equal.';
splitter.setAttribute('role', 'separator');
splitter.setAttribute('aria-label', 'Resize the two sides');
splitter.setAttribute('aria-valuemin', '0');
splitter.setAttribute('aria-valuemax', '100');
panesEl.insertBefore(splitter, panes[1].el);

const isStacked = () => getComputedStyle(panesEl).flexDirection === 'column';

/**
 * Sizes the two sides for a ratio and returns the ratio actually used. Neither side gets smaller than
 * 280px wide (120px tall when stacked), or half the space if there isn't room for that.
 */
function applySplit(ratio: number): number {
  const stacked = isStacked();
  const size = stacked ? panesEl.clientHeight : panesEl.clientWidth;
  const min = size > 0 ? Math.min(0.5, (stacked ? 120 : 280) / size) : 0;
  const r = Math.min(1 - min, Math.max(min, ratio));
  panes[0].el.style.flexGrow = String(r);
  panes[1].el.style.flexGrow = String(1 - r);
  splitter.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
  splitter.setAttribute('aria-valuenow', String(Math.round(r * 100)));
  return r;
}

function setSplit(ratio: number): void {
  splitRatio = applySplit(ratio);
  backend.setSetting('splitRatio', splitRatio.toFixed(3)).catch(() => {});
}

splitter.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  panesEl.classList.add('resizing');
});
splitter.addEventListener('pointermove', (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  const box = panesEl.getBoundingClientRect();
  splitRatio = applySplit(isStacked() ? (e.clientY - box.top) / box.height : (e.clientX - box.left) / box.width);
});
// Fires when the button is released, and also if the drag is interrupted.
splitter.addEventListener('lostpointercapture', () => {
  splitter.classList.remove('dragging');
  panesEl.classList.remove('resizing');
  setSplit(splitRatio);
});
splitter.addEventListener('dblclick', () => setSplit(0.5));
splitter.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 0.1 : 0.02;
  const stacked = isStacked();
  const moves: Record<string, number> = {
    [stacked ? 'ArrowUp' : 'ArrowLeft']: splitRatio - step,
    [stacked ? 'ArrowDown' : 'ArrowRight']: splitRatio + step,
    Home: 0,
    End: 1,
    Enter: 0.5,
  };
  if (!(e.key in moves)) return;
  e.preventDefault();
  setSplit(moves[e.key]);
});
// Re-fit to the window, without forgetting the position the user picked.
window.addEventListener('resize', () => {
  if (isSplit()) applySplit(splitRatio);
});

const isDirty = (t: Tab) => t.content !== t.savedContent;

// ---------- small helpers ----------

let toastTimer: number | undefined;
type ToastAction = { label: string; run: () => void };
/** The "new version" notice, kept so other messages can't make it disappear for good. */
let updateNotice: [string, ToastAction] | null = null;
/** Shows a short message. With an action, it shows a button too and stays until clicked. */
function toast(msg: string, action?: ToastAction): void {
  toastEl.textContent = msg;
  window.clearTimeout(toastTimer);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', () => {
      toastEl.hidden = true;
      action.run();
      if (updateNotice && action !== updateNotice[1]) toast(...updateNotice);
    });
    toastEl.append(' ', b);
  } else {
    // A short message hides after a moment, then brings back the "new version" notice if one was
    // showing, so a passing message can't wipe it out.
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
      if (updateNotice) toast(...updateNotice);
    }, 3500);
  }
  toastEl.hidden = false;
}

// ---------- theme ----------

/** The themes, in menu order. Adding one takes an entry here plus a `.th-<id>` block in style.css. */
// `dark` themes load the editors' dark styles; style.css recolors the rest.
const THEMES: { id: ThemeSetting; label: string; swatch: [string, string]; dark: boolean }[] = [
  { id: 'light', label: 'Light', swatch: ['#FFFFFF', '#2F54EB'], dark: false },
  { id: 'dark', label: 'Dark', swatch: ['#14161B', '#8FA8FF'], dark: true },
  { id: 'retro', label: 'Retro', swatch: ['#141C78', '#FFD23F'], dark: true },
  { id: 'scifi', label: 'SciFi', swatch: ['#07101A', '#3FD0F0'], dark: true },
  { id: 'fantasy', label: 'Fantasy', swatch: ['#EAD9B0', '#8B1E1E'], dark: false },
];
const THEME_ORDER = THEMES.map((t) => t.id);
const THEME_NAMES = Object.fromEntries(THEMES.map((t) => [t.id, t.label])) as Record<ThemeSetting, string>;
const isTheme = (v: string): v is ThemeSetting => (THEME_ORDER as string[]).includes(v);

// Light until the saved choice arrives from the saved settings (see loadSavedTheme).
let themeSetting: ThemeSetting = 'light';

const isDark = () => THEMES.find((t) => t.id === themeSetting)?.dark ?? false;

// The theme drop-down is built by hand because a native <select> list can't be styled. It follows the
// listbox pattern: arrow keys, Home/End, Enter or Space to pick, Esc or Tab to close.
const themeBtn = $<HTMLButtonElement>('theme-btn');
const themeMenu = $('theme-menu');
const themeLabel = $('theme-label');
const CHECK_SVG =
  '<svg class="ck" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const themeOptions = THEMES.map((t) => {
  const opt = document.createElement('div');
  opt.className = 'opt';
  opt.id = 'theme-opt-' + t.id;
  opt.setAttribute('role', 'option');
  opt.tabIndex = -1;
  opt.dataset.theme = t.id;
  const sw = document.createElement('span');
  sw.className = 'sw';
  sw.style.background = `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)`;
  const name = document.createElement('span');
  name.textContent = t.label;
  opt.append(sw, name);
  opt.insertAdjacentHTML('beforeend', CHECK_SVG);
  opt.addEventListener('click', () => pickTheme(t.id));
  themeMenu.appendChild(opt);
  return opt;
});

const isThemeMenuOpen = () => !themeMenu.hidden;

function openThemeMenu(focus: 'current' | 'first' | 'last' = 'current'): void {
  themeMenu.hidden = false;
  themeBtn.setAttribute('aria-expanded', 'true');
  themeBtn.classList.add('open');
  const i = focus === 'first' ? 0 : focus === 'last' ? themeOptions.length - 1 : THEME_ORDER.indexOf(themeSetting);
  themeOptions[i].focus();
}

function closeThemeMenu(refocus: boolean): void {
  if (!isThemeMenuOpen()) return;
  themeMenu.hidden = true;
  themeBtn.setAttribute('aria-expanded', 'false');
  themeBtn.classList.remove('open');
  if (refocus) themeBtn.focus();
}

function pickTheme(id: ThemeSetting): void {
  closeThemeMenu(true);
  if (id === themeSetting) return;
  themeSetting = id;
  backend.setSetting('theme', themeSetting).catch(() => toast('Could not save the theme choice'));
  applyTheme(true);
}

themeBtn.addEventListener('click', () => (isThemeMenuOpen() ? closeThemeMenu(true) : openThemeMenu()));
themeBtn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    openThemeMenu(e.key === 'ArrowDown' ? 'current' : 'last');
  }
});
themeMenu.addEventListener('keydown', (e) => {
  const i = themeOptions.indexOf(document.activeElement as HTMLDivElement);
  const n = themeOptions.length;
  const go = (j: number) => {
    e.preventDefault();
    themeOptions[(j + n) % n].focus();
  };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(n - 1);
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (i >= 0) pickTheme(themeOptions[i].dataset.theme as ThemeSetting);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeThemeMenu(true);
  } else if (e.key === 'Tab') {
    closeThemeMenu(false);
  }
});
// A click anywhere outside the button and menu closes it.
document.addEventListener('pointerdown', (e) => {
  if (isThemeMenuOpen() && !$('theme-dd').contains(e.target as Node)) closeThemeMenu(false);
});

function applyTheme(remount: boolean): void {
  const root = document.documentElement;
  for (const t of THEME_ORDER) root.classList.toggle('th-' + t, t === themeSetting);
  applyCrepeTheme(isDark());
  themeLabel.textContent = THEME_NAMES[themeSetting];
  for (const opt of themeOptions) {
    const on = opt.dataset.theme === themeSetting;
    opt.classList.toggle('on', on);
    opt.setAttribute('aria-selected', String(on));
  }
  if (remount) for (const p of panes) void mountEditor(p, p.editor?.getScroll());
}

/** Applies the theme and split position saved in the settings, if any. Runs before any file is opened. */
async function loadSavedTheme(): Promise<void> {
  try {
    const saved = await backend.getSetting('theme');
    if (isTheme(saved)) themeSetting = saved;
  } catch {
    // no saved theme; keep the default
  }
  try {
    const r = parseFloat(await backend.getSetting('splitRatio'));
    if (r > 0 && r < 1) splitRatio = r;
  } catch {
    // no saved split position; keep the middle
  }
  applyTheme(false);
}

// ---------- tabs, splits and editors ----------

/** The path bar above a document: where the file is, and whether it's saved. */
function renderDocHead(pane: Pane): void {
  const tab = pane.active;
  pane.docHeadEl.hidden = !tab;
  if (!tab) return;
  const crumb = pane.docHeadEl.querySelector<HTMLElement>('.crumb')!;
  crumb.replaceChildren();
  crumb.title = tab.path;
  const parts = crumbParts(tab.path);
  parts.forEach((part, i) => {
    if (i > 0) {
      const sl = document.createElement('span');
      sl.className = 'sl';
      sl.textContent = '/';
      crumb.append(sl);
    }
    const el = document.createElement(i === parts.length - 1 ? 'b' : 'span');
    el.textContent = part;
    crumb.append(el);
  });
  renderStatus(pane);
}

/** The file's folders from the listed folder it's in (or just its own folder), then its name. */
function crumbParts(path: string): string[] {
  const root = tree.rootFor(path);
  const rel = root ? path.slice(root.length) : basename(path);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const top = basename(root ?? dirname(path));
  return top ? [top, ...parts] : parts;
}

function renderStatus(pane: Pane): void {
  const tab = pane.active;
  if (!tab) return;
  const [state, text] = tab.conflict
    ? ['warn', 'Changed on disk']
    : tab.needsPermission
      ? ['warn', 'Not saved: needs permission']
      : isDirty(tab)
        ? ['dirty', 'Unsaved changes']
        : ['', 'Saved'];
  pane.docHeadEl.querySelector('.doc-status')!.className = 'doc-status ' + state;
  pane.docHeadEl.querySelector('.doc-status-text')!.textContent = text;
}

const SPLIT_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';

/** The tab bar: one tab per file, a joined tab per split pair, then the split button. */
function renderTabs(): void {
  for (const pane of panes) renderStatus(pane);
  tabsEl.replaceChildren(...entries.map(entryElement));
  // Only a single file can be split. A split tab is already split; Ctrl+\ pulls it apart.
  if (current && !isSplitEntry(current)) {
    const split = document.createElement('button');
    split.className = 'split';
    split.innerHTML = SPLIT_SVG;
    const label = 'Split view: pick a file to show beside this one (Ctrl+\\)';
    split.title = label;
    split.setAttribute('aria-label', label);
    split.setAttribute('aria-haspopup', 'menu');
    split.setAttribute('aria-expanded', String(!splitMenu.hidden));
    split.addEventListener('click', () => splitAction());
    tabsEl.appendChild(split);
  }
  renderFocus();
}

/** A file's name, its "unsaved" or "changed on disk" mark, and its close button. */
function fileParts(tab: Tab): HTMLElement[] {
  const name = document.createElement('span');
  name.textContent = basename(tab.path);
  const parts: HTMLElement[] = [name];
  if (tab.conflict) {
    const c = document.createElement('span');
    c.className = 'conflict';
    c.textContent = '!';
    c.title = 'Changed on disk';
    parts.push(c);
  } else if (isDirty(tab)) {
    const d = document.createElement('span');
    d.className = 'dirty';
    d.textContent = '●';
    d.title = 'Not saved yet';
    parts.push(d);
  }
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Close (Ctrl+W)';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    void closeTab(tab);
  });
  parts.push(close);
  return parts;
}

function entryElement(entry: Entry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tab' + (entry === current ? ' active' : '');
  el.draggable = true;
  if (isSplitEntry(entry)) {
    // A joined tab: each half shows its own file, and clicking one works in that side.
    el.classList.add('joined');
    el.title = `${entry.left.path}\n${entry.right.path}\nCtrl+\\ to separate`;
    const half = (tab: Tab) => {
      const h = document.createElement('span');
      h.className = 'half';
      h.dataset.path = tab.path;
      h.append(...fileParts(tab));
      h.addEventListener('click', (e) => {
        e.stopPropagation();
        activate(tab);
      });
      h.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.stopPropagation();
          void closeTab(tab);
        }
      });
      return h;
    };
    // The split icon between the names separates the pair into two ordinary tabs.
    const join = document.createElement('button');
    join.className = 'join';
    join.innerHTML = SPLIT_SVG;
    join.title = 'Separate into two tabs (Ctrl+\\)';
    join.setAttribute('aria-label', 'Separate into two tabs');
    join.addEventListener('click', (e) => {
      e.stopPropagation();
      separate(entry);
    });
    el.append(half(entry.left), join, half(entry.right));
  } else {
    el.title = entry.path;
    el.append(...fileParts(entry));
    el.addEventListener('click', () => activate(entry));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) void closeTab(entry);
    });
  }

  // Dragging reorders the tab bar. A split pair moves as one.
  const key = filesOf(entry)[0].path;
  el.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/mdgeek-tab', key));
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('text/mdgeek-tab')) {
      e.preventDefault();
      el.classList.add('drag-over');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const dragged = allTabs().find((t) => t.path === e.dataTransfer?.getData('text/mdgeek-tab'));
    const from = dragged && entryOf(dragged);
    if (from && from !== entry) {
      entries.splice(entries.indexOf(from), 1);
      entries.splice(entries.indexOf(entry), 0, from);
    }
    renderTabs();
  });
  return el;
}

function renderBanner(pane: Pane): void {
  const { bannerEl } = pane;
  bannerEl.replaceChildren();
  const tab = pane.active;
  if (tab?.needsPermission && !tab.conflict) {
    renderPermissionBanner(pane, tab);
    return;
  }
  if (!tab || !tab.conflict) {
    bannerEl.hidden = true;
    return;
  }
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = `${basename(tab.path)} was changed outside MdGeek while you have unsaved edits. Autosave is paused.`;
  bannerEl.appendChild(msg);
  const buttons: [string, () => void][] = [
    ['Review differences', () => void reviewConflict(tab)],
    ['Keep my version', () => void resolveConflict(tab, 'mine')],
    ['Take disk version', () => void resolveConflict(tab, 'theirs')],
  ];
  for (const [label, fn] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    bannerEl.appendChild(b);
  }
  bannerEl.hidden = false;
}

/** A file opened from File Explorer (or a remembered folder) needs the user's OK before it can be saved. */
function renderPermissionBanner(pane: Pane, tab: Tab): void {
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = `MdGeek needs permission to save ${basename(tab.path)}. Your edits are kept until then.`;
  const allow = document.createElement('button');
  allow.textContent = 'Allow';
  allow.addEventListener('click', async () => {
    if (!(await backend.allowSaving(tab.path))) {
      toast('Saving was not allowed. Click Allow to ask again.');
      return;
    }
    tab.needsPermission = false;
    renderChrome();
    await saveNow(tab);
  });
  pane.bannerEl.append(msg, allow);
  pane.bannerEl.hidden = false;
}

function renderChrome(): void {
  const any = entries.length > 0;
  emptyEl.hidden = any;
  panesEl.hidden = !any;
  panesEl.classList.toggle('split', isSplit());
  panes[1].el.hidden = !isSplit();
  splitter.hidden = !isSplit();
  if (isSplit()) applySplit(splitRatio);
  else for (const p of panes) p.el.style.flexGrow = ''; // one file fills the width again
  for (const pane of panes) {
    renderDocHead(pane);
    renderBanner(pane);
  }
  renderTabs();
}

/**
 * Marks the side in use and points the toolbar at it. Redraws nothing else, because it runs as a click
 * starts: rebuilding the tabs then would remove the button being clicked.
 */
function renderFocus(): void {
  for (const pane of panes) pane.el.classList.toggle('focused', pane === focused);
  const active = focused.active;
  tabsEl.querySelectorAll<HTMLElement>('.half').forEach((h) => h.classList.toggle('on', h.dataset.path === active?.path));
  $('btn-export-html').toggleAttribute('disabled', !active);
  $('btn-export-pdf').toggleAttribute('disabled', !active);
  document.querySelectorAll<HTMLElement>('#view-toggle button').forEach((b) => {
    b.classList.toggle('active', !!active && b.dataset.view === active.view);
    b.setAttribute('aria-pressed', String(!!active && b.dataset.view === active.view));
    b.toggleAttribute('disabled', !active);
  });
  document.title = active ? `${basename(active.path)} - MdGeek` : 'MdGeek';
  tree.setActive(active?.path ?? null);
}

function focusPane(pane: Pane): void {
  if (focused === pane || !pane.active) return;
  focused = pane;
  renderFocus();
}

/** (Re)creates a side's editor for its file. Each mount gets a fresh host element. */
async function mountEditor(pane: Pane, scroll?: number): Promise<void> {
  const token = ++pane.mountToken;
  if (pane.shown && pane.editor) pane.shown.scroll = pane.editor.getScroll();
  pane.editor?.destroy();
  pane.editor = null;
  pane.editorEl.replaceChildren();
  const tab = pane.active;
  pane.shown = tab;
  renderChrome();
  if (!tab) return;

  const host = document.createElement('div');
  host.className = 'host';
  pane.editorEl.appendChild(host);
  const onChange = (text: string) => onEdit(tab, text);

  let handle: EditorHandle;
  try {
    handle =
      tab.view === 'source'
        ? createSourceEditor(host, tab.content, isDark(), onChange)
        : await createWysiwygEditor(host, tab.content, tab.path, onChange, (href) => void followLink(tab, href));
  } catch (e) {
    toast('Could not open editor: ' + e);
    return;
  }
  if (token !== pane.mountToken) {
    handle.destroy(); // another mount started while this one was loading
    return;
  }
  pane.editor = handle;
  const at = scroll ?? tab.scroll;
  if (at) requestAnimationFrame(() => handle.setScroll(at));
  if (pane === focused) handle.focus();
}

/** Shows the current tab bar entry: one file across the whole width, or a split pair side by side. */
function refresh(): void {
  const [left, right] = current ? filesOf(current) : [];
  panes[0].active = left ?? null;
  panes[1].active = right ?? null;
  if (!focused.active) focused = panes[0];
  // Note every place in a document before any editor is rebuilt, since a file can move between sides.
  for (const p of panes) if (p.shown !== p.active && p.shown && p.editor) p.shown.scroll = p.editor.getScroll();
  for (const p of panes) if (p.shown !== p.active) void mountEditor(p);
  renderChrome();
}

/** Shows a file's tab. If it's half of a split, the split shows and that side is the one in use. */
function activate(tab: Tab): void {
  const entry = entryOf(tab);
  if (!entry) return;
  current = entry;
  focused = isSplitEntry(entry) && entry.right === tab ? panes[1] : panes[0];
  refresh();
}

/** Joins a single file's tab with the current one. The current file stays on the left. */
function joinWith(tab: Tab): void {
  const cur = current;
  if (!cur || isSplitEntry(cur) || cur === tab || entryOf(tab) !== tab) return;
  entries.splice(entries.indexOf(tab), 1);
  const split: Split = { left: cur, right: tab };
  entries.splice(entries.indexOf(cur), 1, split);
  current = split;
  focused = panes[1];
  refresh();
}

/** Turns a split back into two ordinary tabs, keeping the side in use on screen. */
function separate(split: Split): void {
  entries.splice(entries.indexOf(split), 1, split.left, split.right);
  if (current === split) {
    current = focused === panes[1] ? split.right : split.left;
    focused = panes[0];
  }
  refresh();
}

/** The split button and Ctrl+\: on a single file, opens the menu for picking what goes beside it. On a split, separates it. */
function splitAction(): void {
  if (!current) return;
  if (isSplitEntry(current)) separate(current);
  else if (splitMenu.hidden) openSplitMenu();
  else closeSplitMenu(true);
}

// ---------- split menu ----------
// Lists the other open files, plus "Open file…". The pick joins the current file in a split tab, on the
// right. It follows the menu button pattern: arrow keys, Home/End, Enter or Space to pick, Esc or Tab to
// close. It lives outside the tab bar, which scrolls sideways and would clip it.

const splitMenu = document.createElement('div');
splitMenu.className = 'menu split-menu';
splitMenu.setAttribute('role', 'menu');
splitMenu.setAttribute('aria-label', 'Show beside');
splitMenu.hidden = true;
$('app').appendChild(splitMenu);

const splitButton = () => tabsEl.querySelector<HTMLElement>('.split');

function openSplitMenu(): void {
  const btn = splitButton();
  if (!btn) return;
  // Files already in another split stay where they are.
  const singles = entries.filter((e): e is Tab => !isSplitEntry(e) && e !== current);
  const items: [string, () => void][] = singles.map((t) => [basename(t.path), () => joinWith(t)]);
  items.push(['Open file…', () => void pickFileBeside()]);
  const head = document.createElement('div');
  head.className = 'menu-h';
  head.setAttribute('aria-hidden', 'true');
  head.textContent = 'Show beside';
  const opts = items.map(([label, run]) => {
    const opt = document.createElement('div');
    opt.className = 'opt';
    opt.setAttribute('role', 'menuitem');
    opt.tabIndex = -1;
    opt.textContent = label;
    opt.title = label;
    opt.addEventListener('click', () => {
      closeSplitMenu(false);
      run();
    });
    return opt;
  });
  splitMenu.replaceChildren(head, ...opts);
  // Right-aligned under the button, as the theme menu is.
  const r = btn.getBoundingClientRect();
  splitMenu.style.top = `${r.bottom + 6}px`;
  splitMenu.style.right = `${document.documentElement.clientWidth - r.right}px`;
  splitMenu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  opts[0].focus();
}

function closeSplitMenu(refocus: boolean): void {
  if (splitMenu.hidden) return;
  splitMenu.hidden = true;
  // Look the button up again: the tab bar may have been redrawn while the menu was open.
  const btn = splitButton();
  btn?.setAttribute('aria-expanded', 'false');
  if (refocus) btn?.focus();
}

splitMenu.addEventListener('keydown', (e) => {
  const opts = Array.from(splitMenu.querySelectorAll<HTMLElement>('.opt'));
  const i = opts.indexOf(document.activeElement as HTMLElement);
  const n = opts.length;
  const go = (j: number) => {
    e.preventDefault();
    opts[(j + n) % n].focus();
  };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(n - 1);
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    opts[i]?.click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSplitMenu(true);
  } else if (e.key === 'Tab') {
    closeSplitMenu(false);
  }
});
// A click anywhere outside the menu and its button closes it. The button's own click toggles it.
document.addEventListener('pointerdown', (e) => {
  const t = e.target as Node;
  if (!splitMenu.hidden && !splitMenu.contains(t) && !splitButton()?.contains(t)) closeSplitMenu(false);
});
window.addEventListener('resize', () => closeSplitMenu(false));

function switchView(view: View): void {
  const pane = focused;
  const tab = pane.active;
  if (!tab || tab.view === view) return;
  tab.view = view;
  defaultView = view;
  void mountEditor(pane, pane.editor?.getScroll());
}

// ---------- opening files ----------

/** Reads a file into a new tab, not yet in the tab bar. Returns null (after saying why) if it can't be read. */
async function loadTab(path: string): Promise<Tab | null> {
  try {
    const data = await backend.readFile(path);
    return {
      path,
      content: data.content,
      savedContent: data.content,
      modTime: data.modTime,
      view: defaultView,
      conflict: null,
      saveTimer: null,
      saving: false,
      needsPermission: false,
      scroll: 0,
    };
  } catch (e) {
    toast(`Could not open ${basename(path)}: ${e}`);
    return null;
  }
}

/** Opens a file in its own tab across the full width. A file that's already open is shown where it is. */
async function openFile(path: string): Promise<void> {
  const existing = allTabs().find((t) => t.path === path);
  if (existing) {
    activate(existing);
    return;
  }
  const tab = await loadTab(path);
  if (!tab || allTabs().some((t) => t.path === path)) return; // opened twice at once; keep the first
  entries.push(tab);
  activate(tab);
}

/** "Open file…" in the split menu: the first file picked goes beside the current one, any others get their own tabs. */
async function pickFileBeside(): Promise<void> {
  const beside = current;
  let paths: string[];
  try {
    paths = (await backend.pickFiles()).filter((p) => isMarkdownPath(p));
  } catch (e) {
    toast('Could not open: ' + e);
    return;
  }
  if (!paths.length) return;
  const [first, ...rest] = paths;
  const tab = allTabs().find((t) => t.path === first) ?? (await loadTab(first));
  if (!tab) return;
  if (!entryOf(tab)) entries.push(tab);
  for (const p of rest) {
    if (allTabs().some((t) => t.path === p)) continue;
    const t = await loadTab(p);
    if (t) entries.push(t);
  }
  for (const p of paths) if (!tree.shows(p)) await tree.add([{ path: p, isDir: false }]);
  // Join only if the file is on its own and the current tab is still the one the menu was opened from.
  if (current === beside && entryOf(tab) === tab) joinWith(tab);
  else activate(tab);
}

/** Ctrl+Click on a link: Markdown files open in a tab, anything else in its default app. */
async function followLink(tab: Tab, href: string): Promise<void> {
  const target = resolveLink(dirname(tab.path), href);
  if (!target) return;
  if (target.kind === 'local' && isMarkdownPath(target.path)) {
    await openFile(target.path);
    return;
  }
  try {
    await backend.openLink(target.kind === 'web' ? target.url : target.path);
  } catch (e) {
    toast(`Could not open ${href}: ${e}`);
  }
}

/** Folders replace what the left pane shows. Files open in tabs and are listed in the pane unless already shown there. */
async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (await backend.isDir(p)) {
      await tree.setRoot(p);
    } else {
      await openFile(p);
      const opened = allTabs().some((t) => t.path === p);
      if (opened && isMarkdownPath(p) && !tree.shows(p)) await tree.add([{ path: p, isDir: false }]);
    }
  }
}

/** Files and folders dropped on the left pane are listed there. Only Markdown files can be listed. */
async function addToSidebar(paths: string[]): Promise<void> {
  const items: TreeItem[] = [];
  let skipped = 0;
  for (const p of paths) {
    const isDir = await backend.isDir(p);
    if (isDir || isMarkdownPath(p)) items.push({ path: p, isDir });
    else skipped++;
  }
  await tree.add(items);
  if (skipped) toast(`Skipped ${skipped} file${skipped > 1 ? 's' : ''}: only Markdown files and folders can be listed.`);
}

/** Closes a file. Closing half of a split leaves the other file as an ordinary tab in the same place. */
async function closeTab(tab: Tab): Promise<void> {
  if (tab.conflict) {
    const res = await reviewConflict(tab);
    if (res === 'cancel') return;
  } else {
    await saveNow(tab);
    if (isDirty(tab)) return; // the save failed; keep the tab so nothing is lost
  }
  if (tab.saveTimer !== null) window.clearTimeout(tab.saveTimer);
  const entry = entryOf(tab);
  if (!entry) return; // already closed while it was saving
  const i = entries.indexOf(entry);
  if (isSplitEntry(entry)) {
    const other = entry.left === tab ? entry.right : entry.left;
    entries.splice(i, 1, other);
    if (current === entry) current = other;
  } else {
    entries.splice(i, 1);
    if (current === entry) current = entries[Math.min(i, entries.length - 1)] ?? null;
  }
  refresh();
}

// ---------- autosave and conflicts ----------

function onEdit(tab: Tab, text: string): void {
  const wasDirty = isDirty(tab);
  tab.content = text;
  if (wasDirty !== isDirty(tab)) renderTabs();
  if (tab.saveTimer !== null) window.clearTimeout(tab.saveTimer);
  if (!tab.conflict && !tab.needsPermission) tab.saveTimer = window.setTimeout(() => void saveNow(tab), AUTOSAVE_MS);
}

async function saveNow(tab: Tab): Promise<void> {
  if (tab.saveTimer !== null) {
    window.clearTimeout(tab.saveTimer);
    tab.saveTimer = null;
  }
  if (tab.conflict || tab.needsPermission || tab.saving || !isDirty(tab)) return;
  tab.saving = true;
  try {
    // Make sure nobody else changed the file since we last looked.
    let diskTime: number | null = null;
    try {
      diskTime = await backend.statFile(tab.path);
    } catch {
      // The file was deleted; saving will recreate it.
    }
    if (diskTime !== null && diskTime !== tab.modTime) {
      await handleDiskChange(tab);
      return;
    }
    const content = tab.content;
    tab.modTime = await backend.writeFile(tab.path, content);
    tab.savedContent = content;
  } catch (e) {
    if (e instanceof NeedsPermission) {
      tab.needsPermission = true;
      renderChrome();
    } else {
      toast(`Could not save ${basename(tab.path)}: ${e}`);
    }
  } finally {
    tab.saving = false;
    renderTabs();
  }
}

/** The file on disk differs from what we last saw. Reload quietly, or flag a conflict. */
async function handleDiskChange(tab: Tab): Promise<void> {
  let disk;
  try {
    disk = await backend.readFile(tab.path);
  } catch {
    return; // deleted or unreadable; leave the tab as is
  }
  if (disk.content === tab.content) {
    tab.savedContent = disk.content;
    tab.modTime = disk.modTime;
    renderTabs();
    return;
  }
  if (!isDirty(tab)) {
    tab.content = tab.savedContent = disk.content;
    tab.modTime = disk.modTime;
    toast(`${basename(tab.path)} changed on disk and was reloaded.`);
    await reloadIfShown(tab);
    return;
  }
  if (tab.saveTimer !== null) {
    window.clearTimeout(tab.saveTimer);
    tab.saveTimer = null;
  }
  tab.conflict = { disk: disk.content, diskModTime: disk.modTime };
  renderChrome();
  toast(`${basename(tab.path)} was changed outside MdGeek.`);
}

/** After a tab's text was replaced from disk: rebuilds the editor showing it, if one is. */
async function reloadIfShown(tab: Tab): Promise<void> {
  const pane = panes.find((p) => p.shown === tab);
  if (pane) await mountEditor(pane, pane.editor?.getScroll());
  else renderTabs();
}

async function reviewConflict(tab: Tab): Promise<Resolution> {
  if (!tab.conflict) return 'cancel';
  const res = await showDiff(modalEl, basename(tab.path), tab.content, tab.conflict.disk);
  if (res !== 'cancel') await resolveConflict(tab, res);
  return res;
}

async function resolveConflict(tab: Tab, choice: 'mine' | 'theirs'): Promise<void> {
  const c = tab.conflict;
  if (!c) return;
  tab.conflict = null;
  tab.modTime = c.diskModTime;
  if (choice === 'theirs') {
    tab.content = tab.savedContent = c.disk;
    await reloadIfShown(tab);
  } else {
    renderChrome();
    await saveNow(tab); // overwrites the disk version with ours
  }
}

async function pollDisk(): Promise<void> {
  for (const tab of allTabs()) {
    if (tab.saving || tab.conflict) continue;
    try {
      const mt = await backend.statFile(tab.path);
      if (mt !== tab.modTime && !tab.saving) await handleDiskChange(tab);
    } catch {
      // file missing right now; ignore
    }
  }
}
window.setInterval(() => void pollDisk(), POLL_MS);
window.addEventListener('focus', () => void pollDisk());

async function flushAll(): Promise<void> {
  await Promise.all(allTabs().map((t) => saveNow(t)));
}
window.addEventListener('blur', () => void flushAll());

backend.onClose(flushAll, () => allTabs().some(isDirty));

// A new version of the browser app is ready. Switching reloads the page, so save everything first and
// stay on this version if anything couldn't be saved.
backend.onUpdateReady((apply) => {
  updateNotice = [
    'A new version of MdGeek is ready.',
    {
      label: 'Reload',
      run: async () => {
        await flushAll();
        if (allTabs().some(isDirty)) {
          toast("Couldn't save everything, so MdGeek didn't reload.");
          return;
        }
        apply();
      },
    },
  ];
  toast(...updateNotice);
});

// ---------- export ----------

async function exportHtml(): Promise<void> {
  const active = focused.active;
  if (!active) return;
  const name = basename(active.path).replace(/\.(md|markdown)$/i, '');
  const html = renderStandalone(active.content, name);
  try {
    const saved = await backend.saveExport(name + '.html', html);
    if (saved) toast('Exported to ' + saved);
  } catch (e) {
    toast('Export failed: ' + e);
  }
}

async function exportPdf(): Promise<void> {
  const active = focused.active;
  if (!active) return;
  const root = $('print-root');
  root.innerHTML = `<style>${documentCss}</style>` + (await renderPrintable(active.content, active.path));
  // Wait for images so they appear in the PDF (but not forever).
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.race([
    Promise.all(images.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })))),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  window.addEventListener('afterprint', () => root.replaceChildren(), { once: true });
  window.print(); // choose "Save as PDF" in the print dialog
}

// ---------- toolbar, keys, startup ----------

async function pickFiles(): Promise<void> {
  let paths: string[];
  try {
    paths = await backend.pickFiles();
  } catch (e) {
    toast('Could not open: ' + e);
    return;
  }
  if (paths.length) await openPaths(paths);
}

async function pickFolder(): Promise<void> {
  let dir: string;
  try {
    dir = await backend.pickFolder();
  } catch (e) {
    toast('Could not open: ' + e);
    return;
  }
  if (dir) await tree.setRoot(dir);
}

$('btn-open-file').addEventListener('click', () => void pickFiles());
$('btn-open-folder').addEventListener('click', () => void pickFolder());
$('btn-empty-file').addEventListener('click', () => void pickFiles());
$('btn-empty-folder').addEventListener('click', () => void pickFolder());
$('btn-export-html').addEventListener('click', () => void exportHtml());
$('btn-export-pdf').addEventListener('click', () => void exportPdf());
$('btn-refresh').addEventListener('click', () => void tree.refresh());
$('btn-close-folder').addEventListener('click', () => void tree.clear());
document.querySelectorAll<HTMLElement>('#view-toggle button').forEach((b) =>
  b.addEventListener('click', () => switchView(b.dataset.view as View)),
);

window.addEventListener(
  'keydown',
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    // Shortcuts act on the file in use (in a split, the side last clicked or typed in).
    const active = focused.active;
    if (key === 'o') {
      e.preventDefault();
      void (e.shiftKey ? pickFolder() : pickFiles());
    } else if (key === 's' && active) {
      e.preventDefault();
      void saveNow(active);
    } else if (key === 'w' && active) {
      e.preventDefault();
      void closeTab(active);
    } else if (key === 'e' && active) {
      e.preventDefault();
      switchView(active.view === 'wysiwyg' ? 'source' : 'wysiwyg');
    } else if (e.key === 'Tab' && entries.length > 1 && current) {
      e.preventDefault();
      const step = e.shiftKey ? -1 : 1;
      const next = entries[(entries.indexOf(current) + step + entries.length) % entries.length];
      activate(filesOf(next)[0]);
    } else if (e.code === 'Backslash' && current) {
      e.preventDefault();
      splitAction();
    }
  },
  true,
);

const tree = new Tree(
  $('tree'),
  { sidebar: $('sidebar'), title: $('sidebar-title'), count: $('sidebar-count'), where: $('sidebar-where') },
  (p) => void openFile(p),
  (items) => void backend.rememberItems(items),
);

backend.onOpenPaths((paths) => void openPaths(paths));

// Files dropped from File Explorer: on the left pane they're listed there, anywhere else they open in
// their own tabs. The x and y are page coordinates, so the page can tell which part of the window got the drop.
const sidebar = $('sidebar');
backend.onFileDrop((x, y, paths) => {
  sidebar.classList.remove('drop-over');
  if (document.elementFromPoint(x, y)?.closest('#sidebar')) void addToSidebar(paths);
  else void openPaths(paths);
});
sidebar.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) sidebar.classList.add('drop-over');
});
sidebar.addEventListener('dragleave', (e) => {
  if (!sidebar.contains(e.relatedTarget as Node | null)) sidebar.classList.remove('drop-over');
});

// Backstop: no link anywhere in the app may open a popup window or navigate the app window.
// The editor handles the links it knows about before this runs.
window.open = () => null;
for (const type of ['click', 'auxclick'] as const) {
  document.addEventListener(type, (e) => {
    if ((e.target as Element).closest?.('a[href]')) e.preventDefault();
  });
}
// The browser version needs the File System Access API, which only Edge and Chrome on a computer have.
if (import.meta.env.MODE === 'web' && !('showDirectoryPicker' in window)) {
  emptyEl.querySelector('h2')!.textContent = 'MdGeek needs Edge or Chrome on a computer.';
  emptyEl.querySelector('.hint')?.remove();
  emptyEl.querySelector('.acts')?.remove();
  for (const id of ['btn-open-file', 'btn-open-folder']) $<HTMLButtonElement>(id).disabled = true;
}

// Hovering over the logo shows which version is running, to tell whether an update has arrived.
document.querySelector<HTMLElement>('.brand')!.title = `MdGeek version ${__APP_VERSION__}`;

applyTheme(false);
renderChrome();
void loadSavedTheme()
  .then(async () => {
    const items = await backend.rememberedItems();
    if (items.length) await tree.restore(items);
  })
  .then(() => backend.startupPaths().then(openPaths));

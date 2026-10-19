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

/**
 * One side of the editing area. There are always two; the right one shows only in split view, which
 * is on whenever it has tabs. A file is open in at most one pane.
 */
interface Pane {
  el: HTMLElement;
  tabsEl: HTMLElement;
  docHeadEl: HTMLElement;
  bannerEl: HTMLElement;
  editorEl: HTMLElement;
  tabs: Tab[];
  active: Tab | null; // the tab picked in this pane
  shown: Tab | null; // the tab the editor was last built for; differs from active until it's rebuilt
  editor: EditorHandle | null;
  mountToken: number;
}

const AUTOSAVE_MS = 800;
const POLL_MS = 2000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
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
    tabsEl: part('.tabs'),
    docHeadEl: part('.dochead'),
    bannerEl: part('.banner'),
    editorEl: part('.editor'),
    tabs: [],
    active: null,
    shown: null,
    editor: null,
    mountToken: 0,
  };
  // Clicking or typing in a pane makes it the one the toolbar and shortcuts act on.
  el.addEventListener('pointerdown', () => focusPane(pane), true);
  el.addEventListener('focusin', () => focusPane(pane));
  return pane;
}

const panes = [makePane(), makePane()] as const;
let focused: Pane = panes[0];
let defaultView: View = 'wysiwyg';

const isSplit = () => panes[1].tabs.length > 0;
const allTabs = () => [...panes[0].tabs, ...panes[1].tabs];
/** The pane a tab is in, or undefined once it's closed. */
const paneOf = (tab: Tab) => panes.find((p) => p.tabs.includes(tab));
const otherPane = (pane: Pane) => (pane === panes[0] ? panes[1] : panes[0]);

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

/** Applies the theme saved in the settings, if any. Runs before any file is opened. */
async function loadSavedTheme(): Promise<void> {
  try {
    const saved = await backend.getSetting('theme');
    if (isTheme(saved)) themeSetting = saved;
  } catch {
    // no saved theme; keep the default
  }
  applyTheme(false);
}

// ---------- panes, tabs and editor ----------

/** The path bar above the document: where the file is, and whether it's saved. */
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

/** Tabs in both panes, plus each pane's "move to the other side" button. */
function renderTabs(): void {
  for (const pane of panes) {
    renderStatus(pane);
    pane.tabsEl.replaceChildren(...pane.tabs.map((tab) => tabElement(pane, tab)));
    if (!pane.tabs.length) continue;
    const split = document.createElement('button');
    split.className = 'split';
    split.innerHTML = SPLIT_SVG;
    const label = !isSplit()
      ? 'Split view: pick a file to show beside this one (Ctrl+\\)'
      : pane === panes[0]
        ? 'Move to the right side (Ctrl+\\)'
        : 'Move to the left side (Ctrl+\\)';
    split.title = label;
    split.setAttribute('aria-label', label);
    if (!isSplit()) {
      split.setAttribute('aria-haspopup', 'menu');
      split.setAttribute('aria-expanded', String(!splitMenu.hidden));
    }
    split.addEventListener('click', () => splitAction(pane));
    pane.tabsEl.appendChild(split);
  }
}

function tabElement(pane: Pane, tab: Tab): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tab' + (tab === pane.active ? ' active' : '');
  el.title = tab.path;
  el.draggable = true;

  const name = document.createElement('span');
  name.textContent = basename(tab.path);
  el.appendChild(name);
  if (tab.conflict) {
    const c = document.createElement('span');
    c.className = 'conflict';
    c.textContent = '!';
    c.title = 'Changed on disk';
    el.appendChild(c);
  } else if (isDirty(tab)) {
    const d = document.createElement('span');
    d.className = 'dirty';
    d.textContent = '●';
    d.title = 'Not saved yet';
    el.appendChild(d);
  }
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Close (Ctrl+W)';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    void closeTab(tab);
  });
  el.appendChild(close);

  el.addEventListener('click', () => activate(tab));
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) void closeTab(tab);
  });
  el.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/mdgeek-tab', tab.path));
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('text/mdgeek-tab')) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drag-over');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const from = draggedTab(e);
    if (from && from !== tab) moveTab(from, pane, tab);
    else renderTabs();
  });
  return el;
}

const draggedTab = (e: DragEvent) => allTabs().find((t) => t.path === e.dataTransfer?.getData('text/mdgeek-tab'));

// A tab dropped on a pane's tab bar, but not on another tab, goes to the end of that pane.
for (const pane of panes) {
  pane.tabsEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('text/mdgeek-tab')) {
      e.preventDefault();
      pane.tabsEl.classList.add('drop-over');
    }
  });
  pane.tabsEl.addEventListener('dragleave', (e) => {
    if (!pane.tabsEl.contains(e.relatedTarget as Node | null)) pane.tabsEl.classList.remove('drop-over');
  });
  pane.tabsEl.addEventListener('drop', (e) => {
    e.preventDefault();
    pane.tabsEl.classList.remove('drop-over');
    const from = draggedTab(e);
    if (from) moveTab(from, pane);
  });
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
  const any = allTabs().length > 0;
  emptyEl.hidden = any;
  panesEl.hidden = !any;
  panesEl.classList.toggle('split', isSplit());
  panes[1].el.hidden = !isSplit();
  for (const pane of panes) {
    renderDocHead(pane);
    renderBanner(pane);
  }
  renderTabs();
  renderFocus();
}

/**
 * Marks the pane in use and points the toolbar at it. Redraws nothing else, because it runs as a click
 * starts: rebuilding the tabs then would remove the button being clicked.
 */
function renderFocus(): void {
  for (const pane of panes) pane.el.classList.toggle('focused', pane === focused);
  const active = focused.active;
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
  if (focused === pane || !pane.tabs.length) return;
  focused = pane;
  renderFocus();
}

/** (Re)creates a pane's editor for its active tab. Each mount gets a fresh host element. */
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

/**
 * Keeps the panes tidy after tabs open, close or move: the left side is never empty while the right
 * side has tabs, and the split closes when the right side empties. Then rebuilds any editor whose tab
 * changed.
 */
function refresh(): void {
  const [left, right] = panes;
  if (!left.tabs.length && right.tabs.length) {
    left.tabs = right.tabs;
    left.active = right.active;
    right.tabs = [];
    right.active = null;
  }
  if (!focused.tabs.length) focused = left;
  for (const p of panes) if (p.shown !== p.active) void mountEditor(p);
  renderChrome();
}

function activate(tab: Tab): void {
  const pane = paneOf(tab);
  if (!pane) return;
  pane.active = tab;
  focused = pane;
  refresh();
}

/** Takes a tab out of its pane, picking the next tab there if it was the active one. */
function removeFromPane(pane: Pane, tab: Tab): void {
  const i = pane.tabs.indexOf(tab);
  pane.tabs.splice(i, 1);
  if (pane.active === tab) pane.active = pane.tabs[Math.min(i, pane.tabs.length - 1)] ?? null;
}

/** Moves a tab to a pane, before another tab or at the end. Moving it to the other pane also opens it there. */
function moveTab(tab: Tab, to: Pane, before?: Tab): void {
  const from = paneOf(tab);
  if (!from) return;
  const insert = () => {
    const i = before ? to.tabs.indexOf(before) : -1;
    to.tabs.splice(i < 0 ? to.tabs.length : i, 0, tab);
  };
  if (from === to) {
    from.tabs.splice(from.tabs.indexOf(tab), 1);
    insert();
    renderTabs();
    return;
  }
  // Keep its place in the document. The editor showing it may be rebuilt after the new one.
  if (from.shown === tab && from.editor) tab.scroll = from.editor.getScroll();
  removeFromPane(from, tab);
  insert();
  to.active = tab;
  focused = to;
  refresh();
}

/**
 * The split button and Ctrl+\. Without a split, opens the menu for picking what to show on the right.
 * In split view, moves the pane's current tab to the other side.
 */
function splitAction(pane: Pane): void {
  if (!isSplit()) {
    if (splitMenu.hidden) openSplitMenu(pane);
    else closeSplitMenu(true);
    return;
  }
  if (pane.active) moveTab(pane.active, otherPane(pane));
}

// ---------- split menu ----------
// Lists the other open files, plus "Open file…". The pick opens on the right, beside the current file.
// It follows the menu button pattern: arrow keys, Home/End, Enter or Space to pick, Esc or Tab to close.
// It lives outside the tab bar, which scrolls sideways and would clip it.

const splitMenu = document.createElement('div');
splitMenu.className = 'menu split-menu';
splitMenu.setAttribute('role', 'menu');
splitMenu.setAttribute('aria-label', 'Show beside');
splitMenu.hidden = true;
$('app').appendChild(splitMenu);
let splitMenuPane: Pane = panes[0];

const splitButton = (pane: Pane) => pane.tabsEl.querySelector<HTMLElement>('.split');

function openSplitMenu(pane: Pane): void {
  const btn = splitButton(pane);
  if (!btn) return;
  const items: [string, () => void][] = pane.tabs
    .filter((t) => t !== pane.active)
    .map((t) => [basename(t.path), () => moveTab(t, panes[1])]);
  items.push(['Open file…', () => void pickFiles(panes[1])]);
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
  splitMenuPane = pane;
  btn.setAttribute('aria-expanded', 'true');
  opts[0].focus();
}

function closeSplitMenu(refocus: boolean): void {
  if (splitMenu.hidden) return;
  splitMenu.hidden = true;
  // Look the button up again: the tab bar may have been redrawn while the menu was open.
  const btn = splitButton(splitMenuPane);
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
  if (!splitMenu.hidden && !splitMenu.contains(t) && !splitButton(splitMenuPane)?.contains(t)) closeSplitMenu(false);
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

/** Opens a file in a pane (the one in use, unless given). A file that's already open is shown where it is. */
async function openFile(path: string, pane: Pane = focused): Promise<void> {
  const existing = allTabs().find((t) => t.path === path);
  if (existing) {
    activate(existing);
    return;
  }
  try {
    const data = await backend.readFile(path);
    const tab: Tab = {
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
    pane.tabs.push(tab);
    pane.active = tab;
    focused = pane;
    refresh();
  } catch (e) {
    toast(`Could not open ${basename(path)}: ${e}`);
  }
}

/** Ctrl+Click on a link: Markdown files open in a tab, anything else in its default app. */
async function followLink(tab: Tab, href: string): Promise<void> {
  const target = resolveLink(dirname(tab.path), href);
  if (!target) return;
  if (target.kind === 'local' && isMarkdownPath(target.path)) {
    await openFile(target.path, paneOf(tab));
    return;
  }
  try {
    await backend.openLink(target.kind === 'web' ? target.url : target.path);
  } catch (e) {
    toast(`Could not open ${href}: ${e}`);
  }
}

/** Folders replace what the left pane shows. Files open in tabs and are listed in the pane unless already shown there. */
/** With a pane given, files open there, and ones already open elsewhere move there. */
async function openPaths(paths: string[], pane?: Pane): Promise<void> {
  for (const p of paths) {
    if (await backend.isDir(p)) {
      await tree.setRoot(p);
    } else {
      const open = allTabs().find((t) => t.path === p);
      if (open && pane) moveTab(open, pane);
      else await openFile(p, pane);
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

async function closeTab(tab: Tab): Promise<void> {
  if (tab.conflict) {
    const res = await reviewConflict(tab);
    if (res === 'cancel') return;
  } else {
    await saveNow(tab);
    if (isDirty(tab)) return; // the save failed; keep the tab so nothing is lost
  }
  if (tab.saveTimer !== null) window.clearTimeout(tab.saveTimer);
  const pane = paneOf(tab);
  if (!pane) return; // already closed while it was saving
  removeFromPane(pane, tab);
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

/** Shows the "open file" dialog. The files open in the pane given, or the one in use. */
async function pickFiles(pane?: Pane): Promise<void> {
  let paths: string[];
  try {
    paths = await backend.pickFiles();
  } catch (e) {
    toast('Could not open: ' + e);
    return;
  }
  if (paths.length) await openPaths(paths, pane);
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
    // Shortcuts act on the pane in use.
    const { tabs, active } = focused;
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
    } else if (e.key === 'Tab' && tabs.length > 1 && active) {
      e.preventDefault();
      const step = e.shiftKey ? -1 : 1;
      activate(tabs[(tabs.indexOf(active) + step + tabs.length) % tabs.length]);
    } else if (e.code === 'Backslash' && active) {
      e.preventDefault();
      splitAction(focused);
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

// Files dropped from File Explorer: on the left pane they're listed there, anywhere else they open, on
// the side of a split view they were dropped on.
// The x and y are page coordinates, so the page can tell which part of the window got the drop.
const sidebar = $('sidebar');
backend.onFileDrop((x, y, paths) => {
  sidebar.classList.remove('drop-over');
  const target = document.elementFromPoint(x, y);
  if (target?.closest('#sidebar')) {
    void addToSidebar(paths);
    return;
  }
  const pane = panes.find((p) => p.el.contains(target));
  if (pane) focusPane(pane);
  void openPaths(paths);
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

applyTheme(false);
renderChrome();
void loadSavedTheme()
  .then(async () => {
    const items = await backend.rememberedItems();
    if (items.length) await tree.restore(items);
  })
  .then(() => backend.startupPaths().then(openPaths));

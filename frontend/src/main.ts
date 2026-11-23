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
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';
import './mdgeek-dark-slate.css'; // the Dark theme and the .mdGeek wordmark

import { backend, RECENT_MAX, type RecentFile } from './backend';
import { NeedsPermission, NoAccess } from './backend/errors';
import { applyCrepeTheme, createSourceEditor, createWysiwygEditor, EditorHandle, SourceLook } from './editors';
import { showDiff, Resolution } from './diffview';
import { basename, dirname, docKind, isEditablePath, resolveLink } from './paths';
import { createHtmlEditor, printHtml, DOC_ZOOM_EVENT } from './html-editor';
import { documentCss, renderPrintable, renderStandalone } from './render';
import { Tree, TreeItem } from './tree';

type View = 'wysiwyg' | 'source';
type ThemeSetting = 'light' | 'dark' | 'retro' | 'scifi' | 'fantasy' | 'neutral' | 'dusk';

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
  scroll: number; // the file line at the top of the editor when this tab was last hidden (see EditorHandle)
  /** Split into an upper and a lower view of this same file, each scrolling on its own. */
  stacked: boolean;
  stackRatio: number; // the upper view's share of the height
  halfScroll: number[] | null; // each view's place when the editors were last rebuilt, top first
  halfInUse: number; // which view was last clicked or typed in: 0 upper, 1 lower
}

/** Two files shown side by side. In the tab bar they're one joined tab. */
interface Split {
  left: Tab;
  right: Tab;
}

/** One entry in the tab bar: a single file, or a split pair. */
type Entry = Tab | Split;

/** A find bar, and its search in one view of a file. */
interface Find {
  el: HTMLElement;
  input: HTMLInputElement;
  index: number; // the current match, counting from 0
  total: number;
}

/**
 * One side of the editing area. The right one shows only while a split tab is the current one.
 * A file is open in at most one entry, so it can never show on both sides.
 */
interface Pane {
  el: HTMLElement;
  docHeadEl: HTMLElement;
  bannerEl: HTMLElement;
  editorEl: HTMLElement;
  finds: Find[]; // a find bar for each view: the upper (or only) one, then the lower one
  active: Tab | null; // the file this side should show
  shown: Tab | null; // the file the editor was last built for; differs from active until it's rebuilt
  editor: EditorHandle | null; // the editor in use; in an upper/lower split, the half last clicked or typed in
  halves: EditorHandle[]; // every editor in this side, top first: one, or two when the file is split
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
const isWeb = import.meta.env.MODE === 'web';

function makePane(): Pane {
  const el = $<HTMLTemplateElement>('pane-tpl').content.firstElementChild!.cloneNode(true) as HTMLElement;
  panesEl.appendChild(el);
  const part = (cls: string) => el.querySelector<HTMLElement>(cls)!;
  const pane: Pane = {
    el,
    docHeadEl: part('.dochead'),
    bannerEl: part('.banner'),
    editorEl: part('.editor'),
    finds: [],
    active: null,
    shown: null,
    editor: null,
    halves: [],
    mountToken: 0,
  };
  // Clicking or typing in a side makes it the one the toolbar and shortcuts act on.
  el.addEventListener('pointerdown', () => focusPane(pane), true);
  el.addEventListener('focusin', () => focusPane(pane));

  part('.doc-find').addEventListener('click', () => openFind(pane, halfInUse(pane)));
  part('.doc-stack').addEventListener('click', () => toggleStacked(pane));
  // The template's find bar is the upper view's; a copy serves the lower one. mountEditor puts each one
  // above its view.
  const bar = part('.findbar');
  bar.remove();
  pane.finds = [bar, bar.cloneNode(true) as HTMLElement].map((el, i) => {
    const q = <T extends HTMLElement>(cls: string) => el.querySelector<T>(cls)!;
    const find: Find = { el, input: q<HTMLInputElement>('.find-input'), index: 0, total: 0 };
    find.input.addEventListener('input', () => runFind(pane, i, true));
    find.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepFind(pane, i, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeFind(pane, i);
      }
    });
    q('.find-prev').addEventListener('click', () => stepFind(pane, i, -1));
    q('.find-next').addEventListener('click', () => stepFind(pane, i, 1));
    q('.find-close').addEventListener('click', () => closeFind(pane, i));
    return find;
  });

  // The browser version never learns where files really are, so it can't copy the path or open Explorer.
  const reveal = part('.doc-reveal');
  const crumb = part('.crumb');
  if (isWeb) {
    reveal.remove();
  } else {
    reveal.addEventListener('click', () => {
      const tab = pane.active;
      if (tab) backend.showInFolder(tab.path).catch((e) => toast('Could not open File Explorer: ' + e));
    });
    crumb.tabIndex = 0;
    crumb.setAttribute('role', 'button');
    crumb.classList.add('copy');
    const copy = () => {
      const tab = pane.active;
      if (tab)
        backend.copyText(tab.path).then(
          () => toast('Copied the full path'),
          (e) => toast('Could not copy the path: ' + e),
        );
    };
    crumb.addEventListener('click', copy);
    crumb.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        copy();
      }
    });
  }
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
// `dark` themes load the editors' dark styles; style.css recolors the rest. `docColors` themes set the
// document colour variables (--head, --em and so on), which the Source view then uses for its colours.
const THEMES: { id: ThemeSetting; label: string; swatch: [string, string]; dark: boolean; docColors?: boolean }[] = [
  { id: 'light', label: 'Light', swatch: ['#FFFFFF', '#2F54EB'], dark: false },
  { id: 'dark', label: 'Dark', swatch: ['#121821', '#7C9CFF'], dark: true },
  { id: 'retro', label: 'Retro', swatch: ['#141C78', '#FFD23F'], dark: true },
  { id: 'scifi', label: 'SciFi', swatch: ['#07101A', '#3FD0F0'], dark: true },
  { id: 'fantasy', label: 'Fantasy', swatch: ['#EAD9B0', '#8B1E1E'], dark: false },
  { id: 'neutral', label: 'Neutral', swatch: ['#E4E1DA', '#4D6A7A'], dark: false, docColors: true },
  { id: 'dusk', label: 'Dusk', swatch: ['#33322F', '#9DB6C2'], dark: true, docColors: true },
];
const THEME_ORDER = THEMES.map((t) => t.id);
const THEME_NAMES = Object.fromEntries(THEMES.map((t) => [t.id, t.label])) as Record<ThemeSetting, string>;
const isTheme = (v: string): v is ThemeSetting => (THEME_ORDER as string[]).includes(v);

// Light until the saved choice arrives from the saved settings (see loadSavedTheme).
let themeSetting: ThemeSetting = 'light';

const currentTheme = () => THEMES.find((t) => t.id === themeSetting);
const isDark = () => currentTheme()?.dark ?? false;
const sourceLook = (): SourceLook => (currentTheme()?.docColors ? 'themed' : isDark() ? 'dark' : 'light');

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
  try {
    lastWorkPath = await backend.getSetting('lastWorkPath');
  } catch {
    // nothing remembered; New starts where the system dialog chooses
  }
  try {
    if ((await backend.getSetting('sidebarHidden')) === 'true') showSidebar(false, false);
  } catch {
    // no saved setting; the Explorer shows
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
  crumb.title = isWeb ? tab.path : `${tab.path}\nClick to copy the full path`;
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
  pane.docHeadEl.querySelector('.doc-kind')!.textContent = kindOf(tab) === 'html' ? 'HTML' : 'Markdown';
  pane.docHeadEl.querySelector('.doc-stack')!.setAttribute('aria-pressed', String(tab.stacked));
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
  // An HTML file is already HTML, so it has nothing to export as HTML.
  $('btn-export-html').toggleAttribute('disabled', !active || kindOf(active) === 'html');
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
  rememberWorkPath(pane.active.path);
}

/** Whether a tab holds Markdown or HTML. Files with any other extension are edited as Markdown. */
function kindOf(tab: Tab) {
  return docKind(tab.path) ?? 'markdown';
}

/** Notes where each editor in a side is scrolled to, before the editors are rebuilt. */
function noteScroll(pane: Pane): void {
  const tab = pane.shown;
  if (!tab || !pane.editor) return;
  tab.scroll = pane.editor.getScroll();
  if (pane.halves.length === 2) {
    tab.halfScroll = pane.halves.map((h) => h.getScroll());
    tab.halfInUse = pane.halves.indexOf(pane.editor);
  }
}

/**
 * (Re)creates a side's editor for its file. Each mount gets a fresh host element. A file split into
 * upper and lower views gets two editors; an edit in either is copied into the other.
 */
async function mountEditor(pane: Pane, scroll?: number): Promise<void> {
  const token = ++pane.mountToken;
  noteScroll(pane);
  for (const h of pane.halves) h.destroy();
  pane.editor = null;
  pane.halves = [];
  pane.editorEl.replaceChildren();
  pane.editorEl.classList.remove('stacked');
  const tab = pane.active;
  pane.shown = tab;
  const count = tab ? (tab.stacked ? 2 : 1) : 0;
  // A view that's gone takes its search with it.
  pane.finds.forEach((f, i) => {
    if (i >= count) {
      f.el.hidden = true;
      f.total = 0;
    }
  });
  renderChrome();
  if (!tab) return;

  // Each view is its find bar above its editor host.
  const halfEls: HTMLElement[] = [];
  const hosts: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const half = document.createElement('div');
    half.className = 'half';
    const host = document.createElement('div');
    host.className = 'host';
    const find = pane.finds[i];
    const label = !tab.stacked ? 'Find in this file' : i === 0 ? 'Find in the upper view' : 'Find in the lower view';
    find.input.placeholder = label;
    find.input.setAttribute('aria-label', label);
    find.el.setAttribute('aria-label', label);
    half.append(find.el, host);
    halfEls.push(half);
    hosts.push(host);
  }
  if (tab.stacked) {
    pane.editorEl.classList.add('stacked');
    pane.editorEl.append(halfEls[0], stackDivider(pane, tab, halfEls), halfEls[1]);
  } else {
    pane.editorEl.append(halfEls[0]);
  }

  const built: (EditorHandle | null)[] = hosts.map(() => null);
  const build = (host: HTMLElement, i: number): Promise<EditorHandle> | EditorHandle => {
    const onChange = (text: string) => {
      if (text === tab.content) return; // already known: the other half's edit coming back
      onEdit(tab, text);
      built.forEach((h, j) => {
        if (j !== i) h?.setText(text);
      });
    };
    const link = (href: string) => void followLink(tab, href);
    return tab.view === 'source'
      ? createSourceEditor(host, tab.content, sourceLook(), onChange, kindOf(tab))
      : kindOf(tab) === 'html'
        ? createHtmlEditor(host, tab.content, tab.path, onChange, link, sourceLook())
        : createWysiwygEditor(host, tab.content, tab.path, sourceLook(), onChange, link);
  };
  try {
    for (let i = 0; i < hosts.length; i++) built[i] = await build(hosts[i], i);
  } catch (e) {
    for (const h of built) h?.destroy();
    toast('Could not open editor: ' + e);
    return;
  }
  const halves = built as EditorHandle[];
  if (token !== pane.mountToken) {
    for (const h of halves) h.destroy(); // another mount started while this one was loading
    return;
  }
  // An edit made while the second editor was loading isn't in it yet.
  for (const h of halves) h.setText(tab.content);
  pane.halves = halves;
  const inUse = halves.length === 2 ? tab.halfInUse : 0;
  pane.editor = halves[inUse];
  // Clicking or typing in a view (or its find bar) makes it the one Ctrl+F and the toolbar act on.
  halfEls.forEach((el, i) => el.addEventListener('focusin', () => (pane.editor = halves[i])));

  // The half in use goes back to the place asked for; the other one to where it was.
  const at = scroll ?? tab.scroll;
  const places = halves.map((_, i) => (i === inUse ? at : (tab.halfScroll?.[i] ?? at)));
  requestAnimationFrame(() => halves.forEach((h, i) => places[i] && h.setScroll(places[i])));
  // Mark the matches again in the new editors, without moving away from the places just restored.
  halves.forEach((_, i) => {
    if (!pane.finds[i].el.hidden) runFind(pane, i, false);
  });
  const find = pane.finds[inUse];
  if (pane === focused) (find.el.hidden ? pane.editor : find.input).focus();
}

/** Which view is in use: 0 for the upper (or only) one, 1 for the lower one. */
function halfInUse(pane: Pane): number {
  return Math.max(0, pane.halves.indexOf(pane.editor!));
}

/** The Split button in the path bar: shows the file as an upper and a lower view, or back as one. */
function toggleStacked(pane: Pane): void {
  const tab = pane.active;
  if (!tab) return;
  noteScroll(pane);
  tab.stacked = !tab.stacked;
  // Turning it on starts both views at the current place, half and half, with the upper one in use.
  // Turning it off keeps the place of the view that was in use.
  tab.stackRatio = 0.5;
  tab.halfScroll = null;
  tab.halfInUse = 0;
  void mountEditor(pane, tab.scroll);
}

// ---------- upper/lower divider ----------
// The bar between the upper and lower views follows the separator pattern, like the one between two
// files: drag it, or focus it and use the up and down arrow keys (Shift for bigger steps), Home and End.
// Double-click or Enter puts it back in the middle. Each view keeps at least 80px.

function stackDivider(pane: Pane, tab: Tab, views: HTMLElement[]): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'stack-divider';
  bar.tabIndex = 0;
  bar.title = 'Drag to resize. Double-click to make both views equal.';
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-label', 'Resize the upper and lower views');
  bar.setAttribute('aria-orientation', 'horizontal');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const box = pane.editorEl;
  const apply = (ratio: number) => {
    const height = box.clientHeight;
    const min = height > 0 ? Math.min(0.5, 80 / height) : 0;
    tab.stackRatio = Math.min(1 - min, Math.max(min, ratio));
    views[0].style.flexGrow = String(tab.stackRatio);
    views[1].style.flexGrow = String(1 - tab.stackRatio);
    bar.setAttribute('aria-valuenow', String(Math.round(tab.stackRatio * 100)));
  };
  apply(tab.stackRatio);

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    box.classList.add('resizing');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!bar.hasPointerCapture(e.pointerId)) return;
    const r = box.getBoundingClientRect();
    apply((e.clientY - r.top) / r.height);
  });
  bar.addEventListener('lostpointercapture', () => {
    bar.classList.remove('dragging');
    box.classList.remove('resizing');
  });
  bar.addEventListener('dblclick', () => apply(0.5));
  bar.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, number> = {
      ArrowUp: tab.stackRatio - step,
      ArrowDown: tab.stackRatio + step,
      Home: 0,
      End: 1,
      Enter: 0.5,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    apply(moves[e.key]);
  });
  return bar;
}

/** Shows the current tab bar entry: one file across the whole width, or a split pair side by side. */
function refresh(): void {
  const [left, right] = current ? filesOf(current) : [];
  panes[0].active = left ?? null;
  panes[1].active = right ?? null;
  if (!focused.active) focused = panes[0];
  // Note every place in a document before any editor is rebuilt, since a file can move between sides.
  for (const p of panes) if (p.shown !== p.active) noteScroll(p);
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
  rememberWorkPath(tab.path);
}

// ---------- new files ----------
// New asks where to save, starting in the folder of the file last worked on (remembered between
// sessions), then opens the new empty file in a tab.

/** The file last shown or typed in, so New can start in its folder. */
let lastWorkPath = '';

function rememberWorkPath(path: string): void {
  if (path === lastWorkPath) return;
  lastWorkPath = path;
  backend.setSetting('lastWorkPath', path).catch(() => {});
}

async function newFile(): Promise<void> {
  // The file in use now, else the last one remembered, else the folder listed in the Explorer pane.
  const near = focused.active?.path || lastWorkPath || tree.firstFolder() || '';
  let path: string;
  try {
    path = await backend.newFile(near);
  } catch (e) {
    toast('Could not create the file: ' + e);
    return;
  }
  if (!path) return; // cancelled
  await openFile(path);
  if (!allTabs().some((t) => t.path === path)) return;
  // A file inside a listed folder shows up once the folder is read again; any other file is added.
  if (tree.rootFor(path)) await tree.refresh();
  else if (!tree.shows(path)) await tree.add([{ path, isDir: false }]);
}

// ---------- recent files ----------
// The Recent button lists the last RECENT_MAX files opened, newest first, the way File > Open Recent
// works in most apps: opening a file (or switching to it from the left pane, a link, or this list)
// moves it to the top; picking one that was moved or deleted takes it off the list with a message; and
// "Clear recent files" empties it. In the menu, keys 1 to 9 and 0 pick by number. The start screen
// shows the same list.

const recentBtn = $<HTMLButtonElement>('recent-btn');
const recentMenu = $('recent-menu');
const emptyRecent = $('empty-recent');

/**
 * Changes to the list run one after another: each reads the saved list and writes it back, so two at
 * once (opening several files) would otherwise lose one. Afterwards the start screen's copy is redrawn.
 */
let recentQueue: Promise<unknown> = Promise.resolve();
function changeRecent(fn: () => Promise<void>): Promise<void> {
  const run = recentQueue.then(fn).catch(() => {}); // not remembered; nothing else is affected
  recentQueue = run;
  return run.then(renderEmptyRecent);
}
const listRecent = (): Promise<RecentFile[]> => recentQueue.then(() => backend.recentFiles()).catch(() => []);

function noteRecent(path: string): void {
  void changeRecent(() => backend.addRecent(path));
}

/** Opens a file from the list, as Open file does. A file that's no longer there is taken off the list. */
async function openRecent(path: string): Promise<void> {
  try {
    await backend.statFile(path);
  } catch (e) {
    // The browser version asks for access again after a restart; turning that down isn't a missing file.
    if (e instanceof NoAccess) {
      toast(`MdGeek needs your OK to open ${basename(path)}.`);
      return;
    }
    await changeRecent(() => backend.removeRecent(path));
    toast(`${basename(path)} was moved or deleted, so it's been taken off the Recent files list.`);
    return;
  }
  await openPaths([path]);
}

/** The name, with its folder in small text under it. */
function recentLabel(r: RecentFile): HTMLElement {
  const txt = document.createElement('span');
  txt.className = 'txt';
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = r.name;
  txt.append(nm);
  if (r.where) {
    const wh = document.createElement('span');
    wh.className = 'wh';
    wh.textContent = r.where;
    txt.append(wh);
  }
  return txt;
}

/** Fills the Recent menu with the current list, each file numbered 1 to 9 then 0. */
async function fillRecentMenu(): Promise<void> {
  const list = await listRecent();
  const head = document.createElement('div');
  head.className = 'menu-h';
  head.setAttribute('aria-hidden', 'true');
  head.textContent = 'Recent files';
  const items: HTMLElement[] = list.slice(0, RECENT_MAX).map((r, i) => {
    const opt = document.createElement('div');
    opt.className = 'opt';
    opt.setAttribute('role', 'menuitem');
    opt.tabIndex = -1;
    opt.title = r.where ? r.path : r.name;
    const num = document.createElement('span');
    num.className = 'num';
    num.setAttribute('aria-hidden', 'true');
    num.textContent = String((i + 1) % 10);
    opt.append(num, recentLabel(r));
    opt.addEventListener('click', () => void openRecent(r.path));
    return opt;
  });
  const rest: HTMLElement[] = [];
  if (items.length) {
    const clear = document.createElement('div');
    clear.className = 'opt clear';
    clear.setAttribute('role', 'menuitem');
    clear.tabIndex = -1;
    clear.textContent = 'Clear recent files';
    clear.addEventListener('click', () => void changeRecent(() => backend.clearRecent()));
    rest.push(clear);
  } else {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'Files you open will be listed here.';
    rest.push(none);
  }
  recentMenu.replaceChildren(head, ...items, ...rest);
}

// ---------- toolbar menus ----------
// File and Recent each open a menu under their button. Both follow the menu button pattern: Enter, Space
// or the arrow keys open it; arrow keys, Home and End move through it; Enter or Space picks; Esc or Tab
// closes it, as does a click anywhere else.

/** Wires a button to the menu under it. fill, if given, rebuilds the menu's items each time it opens. */
function dropdown(btn: HTMLButtonElement, menu: HTMLElement, fill?: () => Promise<void>): void {
  // Bumped on every open and close, so a slow fill that finishes after the menu was closed is dropped.
  let token = 0;
  const items = () =>
    Array.from(menu.querySelectorAll<HTMLElement>('.opt')).filter((o) => !(o as HTMLButtonElement).disabled);
  const close = (refocus: boolean) => {
    token++;
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  };
  const open = async (focus: 'first' | 'last') => {
    const t = ++token;
    await fill?.();
    if (t !== token) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const opts = items();
    (opts.length ? opts[focus === 'first' ? 0 : opts.length - 1] : menu).focus();
  };

  btn.addEventListener('click', () => (menu.hidden ? void open('first') : close(true)));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      void open(e.key === 'ArrowDown' ? 'first' : 'last');
    }
  });
  menu.tabIndex = -1; // so focus has somewhere to go when the menu has no items
  menu.addEventListener('keydown', (e) => {
    const opts = items();
    const i = opts.indexOf(document.activeElement as HTMLElement);
    const n = opts.length;
    const go = (j: number) => {
      e.preventDefault();
      if (n) opts[(j + n) % n].focus();
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
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  });
  // Picking an item closes the menu first (in the capture phase, before the item's own click handler),
  // so a dialog the item opens starts with the menu already gone and focus back on the button.
  menu.addEventListener(
    'click',
    (e) => {
      if ((e.target as Element).closest('.opt')) close(true);
    },
    true,
  );
  document.addEventListener('pointerdown', (e) => {
    if (!btn.parentElement!.contains(e.target as Node)) close(false);
  });
}

dropdown($<HTMLButtonElement>('file-btn'), $('file-menu'));
dropdown(recentBtn, recentMenu, fillRecentMenu);
// In the Recent menu, keys 1 to 9 and 0 open the file with that number.
recentMenu.addEventListener('keydown', (e) => {
  if (!/^[0-9]$/.test(e.key) || e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  recentMenu.querySelectorAll<HTMLElement>('.opt:not(.clear)')[(Number(e.key) + 9) % 10]?.click();
});

/** The list on the start screen (shown when no file is open). Hidden while it's empty. */
async function renderEmptyRecent(): Promise<void> {
  const list = await listRecent();
  const ul = emptyRecent.querySelector('ul');
  if (!ul) return; // removed: this browser can't open files
  ul.replaceChildren(
    ...list.map((r) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.title = r.where ? r.path : r.name;
      b.append(...recentLabel(r).childNodes);
      b.addEventListener('click', () => void openRecent(r.path));
      li.append(b);
      return li;
    }),
  );
  emptyRecent.hidden = !list.length;
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

// ---------- find ----------
// Each view has its own find bar above it: each side of a two-file split, and each of the upper and
// lower views of one file, so each is searched on its own. Ctrl+F opens the one for the view in use.

function openFind(pane: Pane, i: number): void {
  const find = pane.finds[i];
  if (!pane.active || !pane.halves[i]) return;
  const wasOpen = !find.el.hidden;
  find.el.hidden = false;
  find.input.focus();
  find.input.select();
  if (!wasOpen) runFind(pane, i, true);
}

/** Searches again for what's in the box. Starts from the first match if restart, else keeps the place. */
function runFind(pane: Pane, i: number, restart: boolean): void {
  const find = pane.finds[i];
  const editor = pane.halves[i];
  find.total = editor?.find(find.input.value) ?? 0;
  find.index = restart ? 0 : Math.min(find.index, Math.max(0, find.total - 1));
  if (find.total) editor?.showMatch(find.index, restart);
  renderFindCount(find);
}

function stepFind(pane: Pane, i: number, step: number): void {
  const find = pane.finds[i];
  if (!find.total) return;
  find.index = (find.index + step + find.total) % find.total;
  pane.halves[i]?.showMatch(find.index);
  renderFindCount(find);
}

function renderFindCount(find: Find): void {
  find.el.querySelector('.find-count')!.textContent = find.total
    ? `${find.index + 1} of ${find.total}`
    : find.input.value
      ? 'No results'
      : '';
}

/** Closes a find bar, leaving the current match selected in its view. */
function closeFind(pane: Pane, i: number): void {
  const find = pane.finds[i];
  const editor = pane.halves[i];
  if (find.el.hidden) return;
  find.el.hidden = true;
  if (find.total) editor?.selectMatch(find.index);
  editor?.find('');
  find.total = 0;
  editor?.focus();
}

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
    noteRecent(path);
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
      stacked: false,
      stackRatio: 0.5,
      halfScroll: null,
      halfInUse: 0,
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
    noteRecent(path);
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
    paths = (await backend.pickFiles()).filter((p) => isEditablePath(p));
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

/** Ctrl+Click on a link: Markdown and HTML files open in a tab, anything else in its default app. */
async function followLink(tab: Tab, href: string): Promise<void> {
  const target = resolveLink(dirname(tab.path), href);
  if (!target) return;
  if (target.kind === 'local' && isEditablePath(target.path)) {
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
      if (opened && isEditablePath(p) && !tree.shows(p)) await tree.add([{ path: p, isDir: false }]);
    }
  }
}

/** Files and folders dropped on the left pane are listed there. Only Markdown and HTML files can be listed. */
async function addToSidebar(paths: string[]): Promise<void> {
  const items: TreeItem[] = [];
  let skipped = 0;
  for (const p of paths) {
    const isDir = await backend.isDir(p);
    if (isDir || isEditablePath(p)) items.push({ path: p, isDir });
    else skipped++;
  }
  await tree.add(items);
  if (items.length) showSidebar(true);
  if (skipped) toast(`Skipped ${skipped} file${skipped > 1 ? 's' : ''}: only Markdown and HTML files and folders can be listed.`);
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
  // The marks are tied to the old text, so find again; scrolling would pull the view away from typing.
  for (const p of panes)
    if (p.shown === tab)
      p.finds.forEach((f, i) => {
        if (!f.el.hidden) runFind(p, i, false);
      });
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
  if (kindOf(active) === 'html') return;
  const html = await renderStandalone(active.content, name);
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
  if (kindOf(active) === 'html') {
    await printHtml(active.content, active.path).catch((e) => toast('Export failed: ' + e));
    return;
  }
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
  if (dir) {
    await tree.setRoot(dir);
    showSidebar(true);
  }
}

/** Shows or hides the Explorer pane, and remembers the choice for next time if save is true. */
function showSidebar(show: boolean, save = true): void {
  const btn = $('btn-sidebar');
  $('sidebar').hidden = !show;
  btn.setAttribute('aria-expanded', String(show));
  btn.title = `${show ? 'Hide' : 'Show'} the Explorer pane (Ctrl+Shift+E)`;
  if (save) backend.setSetting('sidebarHidden', String(!show)).catch(() => {});
}
$('btn-sidebar').addEventListener('click', () => showSidebar($('sidebar').hidden));

$('btn-new-file').addEventListener('click', () => void newFile());
$('btn-empty-new').addEventListener('click', () => void newFile());
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
    if (key === 'e' && e.shiftKey) {
      e.preventDefault();
      showSidebar($('sidebar').hidden);
    } else if (key === 'n' && !e.shiftKey) {
      e.preventDefault();
      void newFile();
    } else if (key === 'o') {
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
    } else if (key === 'f' && !e.shiftKey && active) {
      e.preventDefault();
      openFind(focused, halfInUse(focused));
    } else if (e.key === 'Tab' && entries.length > 1 && current) {
      e.preventDefault();
      const step = e.shiftKey ? -1 : 1;
      const next = entries[(entries.indexOf(current) + step + entries.length) % entries.length];
      activate(filesOf(next)[0]);
    } else if (e.code === 'Backslash' && e.shiftKey && active) {
      e.preventDefault();
      toggleStacked(focused);
    } else if (e.code === 'Backslash' && current) {
      e.preventDefault();
      splitAction();
    }
  },
  true,
);

// ---------- text size ----------
// The toolbar's A− / A+ buttons, or Ctrl + = / Ctrl + - (Ctrl + 0 resets), make the document text
// bigger or smaller. (Ctrl + mouse wheel was tried and taken out: on Linux, zooming in worked but
// zooming out just scrolled, and a wheel that behaves differently each way is confusing.)
// Only the document changes (WYSIWYG, Source, diff and HTML views); the toolbar and Explorer stay as they are. It sets --doc-zoom, which style.css multiplies the document's font sizes by, and
// the size is saved like the theme so it survives a restart. HTML pages zoom as a whole instead (see
// DOC_ZOOM_EVENT in html-editor.ts).

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
let docZoom = 1;
let zoomSaveTimer: number | undefined;

function setDocZoom(z: number, save = true): void {
  z = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
  if (z === docZoom) return;
  docZoom = z;
  document.documentElement.style.setProperty('--doc-zoom', String(z));
  window.dispatchEvent(new Event(DOC_ZOOM_EVENT)); // open HTML pages zoom to match
  showZoom();
  if (!save) return;
  if (fullScreen) toast(`Text size ${Math.round(z * 100)}%`); // the toolbar, which shows it, is hidden
  // Quick clicks or a held key make many changes in a row; only the last one is written to the settings file.
  window.clearTimeout(zoomSaveTimer);
  zoomSaveTimer = window.setTimeout(() => {
    backend.setSetting('docZoom', String(docZoom)).catch(() => toast('Could not save the text size'));
  }, 400);
}

// The toolbar's text size group: A− and A+ step the size, and the middle button shows it and resets it.
const zoomOutBtn = $<HTMLButtonElement>('btn-zoom-out');
const zoomInBtn = $<HTMLButtonElement>('btn-zoom-in');
const zoomResetBtn = $<HTMLButtonElement>('btn-zoom-reset');
function showZoom(): void {
  zoomResetBtn.textContent = `${Math.round(docZoom * 100)}%`;
  zoomOutBtn.disabled = docZoom <= ZOOM_MIN;
  zoomInBtn.disabled = docZoom >= ZOOM_MAX;
}
zoomOutBtn.addEventListener('click', () => setDocZoom(docZoom - ZOOM_STEP));
zoomInBtn.addEventListener('click', () => setDocZoom(docZoom + ZOOM_STEP));
zoomResetBtn.addEventListener('click', () => setDocZoom(1));

window.addEventListener(
  'keydown',
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+') setDocZoom(docZoom + ZOOM_STEP);
    else if (e.key === '-' || e.key === '_') setDocZoom(docZoom - ZOOM_STEP);
    else if (e.key === '0' && !e.shiftKey) setDocZoom(1);
    else return;
    e.preventDefault();
  },
  true,
);

backend
  .getSetting('docZoom')
  .then((v) => {
    const z = parseFloat(v);
    if (z > 0) setDocZoom(z, false);
  })
  .catch(() => {}); // nothing saved; keep 100%

// ---------- full screen ----------
// F11 or the toolbar button gives the screen to the document: the window goes full screen and the
// toolbar and tab row hide. F11 again, Esc, or the button in the top right corner come back out. Esc
// only leaves full screen when nothing else wanted it: a menu, the find bar, a dialog, or one of the
// editor's pop-ups closes first.

let fullScreen = false;
const exitFullBtn = $<HTMLButtonElement>('btn-exit-full');

function setFullScreen(on: boolean): void {
  if (fullScreen === on) return;
  fullScreen = on;
  $('app').classList.toggle('full', on);
  exitFullBtn.hidden = !on;
  void backend.setFullScreen(on);
  if (isSplit()) applySplit(splitRatio); // the panes just got taller
  // The button just pressed has gone, so typing carries on in the document.
  const at = document.activeElement;
  if (!at || at === document.body || at === exitFullBtn || $('toolbar').contains(at)) focused.editor?.focus();
}

/**
 * Something open that Esc should close before it leaves full screen. The WYSIWYG editor's pop-ups
 * (the / menu, the format bar over a selection, link boxes) are marked data-show; its block handle is
 * too, whenever the mouse is over the text, but Esc doesn't close that.
 */
const escHasWork = () =>
  !!document.querySelector(
    'dialog[open], .menu:not([hidden]), #modal:not([hidden]), [data-show="true"]:not(.milkdown-block-handle)',
  );

$('btn-full').addEventListener('click', () => setFullScreen(true));
exitFullBtn.addEventListener('click', () => setFullScreen(false));
backend.onFullScreenExit(() => setFullScreen(false));

// Noted as the key goes down, before a menu or pop-up closes itself and the page no longer shows it was open.
let escBusy = false;
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape') escBusy = escHasWork();
    else if (e.key === 'F11' && !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) {
      e.preventDefault();
      setFullScreen(!fullScreen);
    }
  },
  true,
);
// Find bars and menus stop Esc on their way, so it only gets here when they didn't use it. (The
// WYSIWYG editor marks every Esc as used, even when it does nothing with it, so that mark isn't checked.)
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !fullScreen || escBusy) return;
  e.preventDefault();
  setFullScreen(false);
});

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

// Backstop: a drop the page doesn't claim is opened by the web view itself, in place of the whole app,
// which leaves only the dropped page on screen with no toolbar and no way back. The desktop app
// already gets the dropped paths from the window (above), so the page claims every file or link drop
// that reaches it here. Drops inside the editors are left alone: they move text and blocks there, and
// the web view never opens a page for a drop on text being edited.
const carriesFileOrLink = (e: DragEvent) => {
  const types = e.dataTransfer?.types ?? [];
  return types.includes('Files') || types.includes('text/uri-list');
};
const outsideEditors = (e: DragEvent) => !(e.target as Element | null)?.closest?.('.ProseMirror, .cm-content');
window.addEventListener('dragover', (e) => {
  if (carriesFileOrLink(e) && outsideEditors(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (carriesFileOrLink(e) && outsideEditors(e)) e.preventDefault();
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
// Browsers keep Ctrl+N for a new window, so only the desktop app offers it.
if (isWeb) $('btn-new-file').querySelector('.key')?.remove();
// The browser version needs the File System Access API, which only Edge and Chrome on a computer have.
if (import.meta.env.MODE === 'web' && !('showDirectoryPicker' in window)) {
  emptyEl.querySelector('h2')!.textContent = 'MdGeek needs Edge or Chrome on a computer.';
  emptyEl.querySelector('.hint')?.remove();
  emptyEl.querySelector('.acts')?.remove();
  for (const id of ['file-btn', 'recent-btn']) $<HTMLButtonElement>(id).disabled = true;
  emptyRecent.remove();
} else {
  void renderEmptyRecent();
}

// ---------- version panel ----------
// The logo opens a small panel with the running version and, in the browser version, "Check for
// updates". The desktop app is updated by installing a new version, so it shows the version only.

const aboutBtn = $<HTMLButtonElement>('about-btn');
const aboutMenu = $('about-menu');
const checkBtn = $<HTMLButtonElement>('btn-check-updates');
$('about-version').textContent = `Version ${__APP_VERSION__}`;
aboutBtn.title = `MdGeek version ${__APP_VERSION__}` + (isWeb ? '. Click to check for updates.' : '');
checkBtn.hidden = !isWeb;

function closeAboutMenu(refocus: boolean): void {
  if (aboutMenu.hidden) return;
  aboutMenu.hidden = true;
  aboutBtn.setAttribute('aria-expanded', 'false');
  if (refocus) aboutBtn.focus();
}

aboutBtn.addEventListener('click', () => {
  if (!aboutMenu.hidden) return closeAboutMenu(true);
  aboutMenu.hidden = false;
  aboutBtn.setAttribute('aria-expanded', 'true');
  if (isWeb) checkBtn.focus();
});
aboutMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAboutMenu(true);
  } else if (e.key === 'Tab') {
    closeAboutMenu(false);
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!$('about-dd').contains(e.target as Node)) closeAboutMenu(false);
});

checkBtn.addEventListener('click', async () => {
  closeAboutMenu(true);
  checkBtn.disabled = true;
  toast('Checking for updates…');
  try {
    const result = await backend.checkForUpdate();
    // 'found': the "new version" notice with its Reload button takes over the message area.
    if (result === 'latest') toast(`You have the latest version: ${__APP_VERSION__}.`);
    else if (result === 'offline') toast("Couldn't reach the MdGeek website to check. Try again when you're online.");
  } finally {
    checkBtn.disabled = false;
  }
});

applyTheme(false);
renderChrome();
void loadSavedTheme()
  .then(async () => {
    const items = await backend.rememberedItems();
    if (items.length) await tree.restore(items);
  })
  .then(() => backend.startupPaths().then(openPaths));

// Fonts are bundled so the app works offline (and its security policy only allows its own fonts).
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource-variable/exo-2/wght.css';
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
type ThemeSetting = 'light' | 'dark' | 'scifi';

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
}

const AUTOSAVE_MS = 800;
const POLL_MS = 2000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsEl = $('tabs');
const bannerEl = $('banner');
const editorEl = $('editor');
const emptyEl = $('empty');
const toastEl = $('toast');
const modalEl = $('modal');

let tabs: Tab[] = [];
let active: Tab | null = null;
let editor: EditorHandle | null = null;
let mountToken = 0;
let defaultView: View = 'wysiwyg';

const isDirty = (t: Tab) => t.content !== t.savedContent;

// ---------- small helpers ----------

let toastTimer: number | undefined;
/** Shows a short message. With an action, it shows a button too and stays until clicked. */
function toast(msg: string, action?: { label: string; run: () => void }): void {
  toastEl.textContent = msg;
  window.clearTimeout(toastTimer);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', () => {
      toastEl.hidden = true;
      action.run();
    });
    toastEl.append(' ', b);
  } else {
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3500);
  }
  toastEl.hidden = false;
}

// ---------- theme ----------

/** The themes, in menu order. Adding one takes an entry here plus a `.th-<id>` block in style.css. */
const THEMES: { id: ThemeSetting; label: string; swatch: [string, string] }[] = [
  { id: 'light', label: 'Light', swatch: ['#FFFFFF', '#2F54EB'] },
  { id: 'dark', label: 'Dark', swatch: ['#14161B', '#8FA8FF'] },
  { id: 'scifi', label: 'SciFi', swatch: ['#07101A', '#3FD0F0'] },
];
const THEME_ORDER = THEMES.map((t) => t.id);
const THEME_NAMES = Object.fromEntries(THEMES.map((t) => [t.id, t.label])) as Record<ThemeSetting, string>;
const isTheme = (v: string): v is ThemeSetting => (THEME_ORDER as string[]).includes(v);

// Light until the saved choice arrives from the saved settings (see loadSavedTheme).
let themeSetting: ThemeSetting = 'light';

// SciFi is built on the dark theme: the editors use its styles and style.css recolors the rest.
const isDark = () => themeSetting === 'dark' || themeSetting === 'scifi';

const themeSelect = $<HTMLSelectElement>('theme-select');
for (const t of THEME_ORDER) themeSelect.add(new Option(THEME_NAMES[t], t));

function applyTheme(remount: boolean): void {
  const root = document.documentElement;
  for (const t of THEME_ORDER) root.classList.toggle('th-' + t, t === themeSetting);
  applyCrepeTheme(isDark());
  themeSelect.value = themeSetting;
  if (remount) void mountEditor(editor?.getScroll());
}

themeSelect.addEventListener('change', () => {
  themeSetting = themeSelect.value as ThemeSetting;
  backend.setSetting('theme', themeSetting).catch(() => toast('Could not save the theme choice'));
  applyTheme(true);
});

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

// ---------- tabs and editor ----------

function renderTabs(): void {
  tabsEl.replaceChildren();
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === active ? ' active' : '');
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
        el.classList.add('drag-over');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = tabs.find((t) => t.path === e.dataTransfer?.getData('text/mdgeek-tab'));
      if (from && from !== tab) {
        tabs.splice(tabs.indexOf(from), 1);
        tabs.splice(tabs.indexOf(tab), 0, from);
      }
      renderTabs();
    });
    tabsEl.appendChild(el);
  }
}

function renderBanner(): void {
  bannerEl.replaceChildren();
  const tab = active;
  if (tab?.needsPermission && !tab.conflict) {
    renderPermissionBanner(tab);
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
function renderPermissionBanner(tab: Tab): void {
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
    renderBanner();
    await saveNow(tab);
  });
  bannerEl.append(msg, allow);
  bannerEl.hidden = false;
}

function renderChrome(): void {
  renderTabs();
  renderBanner();
  emptyEl.hidden = tabs.length > 0;
  editorEl.hidden = tabs.length === 0;
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

/** (Re)creates the editor for the active tab. Each mount gets a fresh host element. */
async function mountEditor(scroll?: number): Promise<void> {
  const token = ++mountToken;
  editor?.destroy();
  editor = null;
  editorEl.replaceChildren();
  renderChrome();
  const tab = active;
  if (!tab) return;

  const host = document.createElement('div');
  host.className = 'host';
  editorEl.appendChild(host);
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
  if (token !== mountToken) {
    handle.destroy(); // another mount started while this one was loading
    return;
  }
  editor = handle;
  if (scroll !== undefined) requestAnimationFrame(() => handle.setScroll(scroll));
  handle.focus();
}

function activate(tab: Tab): void {
  if (active === tab) return;
  active = tab;
  void mountEditor();
}

function switchView(view: View): void {
  if (!active || active.view === view) return;
  active.view = view;
  defaultView = view;
  void mountEditor(editor?.getScroll());
}

// ---------- opening files ----------

async function openFile(path: string): Promise<void> {
  const existing = tabs.find((t) => t.path === path);
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
    };
    tabs.push(tab);
    active = tab;
    await mountEditor();
  } catch (e) {
    toast(`Could not open ${basename(path)}: ${e}`);
  }
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
      const opened = tabs.some((t) => t.path === p);
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
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  if (active === tab) {
    active = tabs[Math.min(i, tabs.length - 1)] ?? null;
    await mountEditor();
  } else {
    renderChrome();
  }
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
      renderBanner();
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
    if (tab === active) await mountEditor(editor?.getScroll());
    else renderTabs();
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
    if (tab === active) await mountEditor(editor?.getScroll());
    else renderTabs();
  } else {
    renderChrome();
    await saveNow(tab); // overwrites the disk version with ours
  }
}

async function pollDisk(): Promise<void> {
  for (const tab of tabs) {
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
  await Promise.all(tabs.map((t) => saveNow(t)));
}
window.addEventListener('blur', () => void flushAll());

backend.onClose(flushAll, () => tabs.some(isDirty));

// A new version of the browser app is ready. Switching reloads the page, so save everything first and
// stay on this version if anything couldn't be saved.
backend.onUpdateReady((apply) =>
  toast('A new version of MdGeek is ready.', {
    label: 'Reload',
    run: async () => {
      await flushAll();
      if (tabs.some(isDirty)) {
        toast("Couldn't save everything, so MdGeek didn't reload.");
        return;
      }
      apply();
    },
  }),
);

// ---------- export ----------

async function exportHtml(): Promise<void> {
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
$('btn-export-html').addEventListener('click', () => void exportHtml());
$('btn-export-pdf').addEventListener('click', () => void exportPdf());
$('btn-refresh').addEventListener('click', () => void tree.refresh());
document.querySelectorAll<HTMLElement>('#view-toggle button').forEach((b) =>
  b.addEventListener('click', () => switchView(b.dataset.view as View)),
);

window.addEventListener(
  'keydown',
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
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
    }
  },
  true,
);

const tree = new Tree(
  $('tree'),
  $('sidebar-title'),
  (p) => void openFile(p),
  (items) => void backend.rememberItems(items),
);

backend.onOpenPaths((paths) => void openPaths(paths));

// Files dropped from File Explorer: on the left pane they're listed there, anywhere else they open.
// The x and y are page coordinates, so the page can tell which part of the window got the drop.
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
  emptyEl.querySelector('p')!.textContent = 'MdGeek needs Edge or Chrome on a computer.';
  emptyEl.querySelector('.hint')?.remove();
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

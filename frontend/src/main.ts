import './style.css';
import { EventsEmit, EventsOn } from '../wailsjs/runtime/runtime';
import {
  IsDir,
  OpenLink,
  PickFiles,
  PickFolder,
  ReadFile,
  SaveExport,
  StartupPaths,
  StatFile,
  WriteFile,
} from '../wailsjs/go/main/App';
import { applyCrepeTheme, createSourceEditor, createWysiwygEditor, EditorHandle } from './editors';
import { showDiff, Resolution } from './diffview';
import { basename, dirname, resolveLink } from './paths';
import { documentCss, renderBody, renderStandalone } from './render';
import { Tree } from './tree';

type View = 'wysiwyg' | 'source';
type ThemeSetting = 'auto' | 'light' | 'dark';

interface Tab {
  path: string;
  content: string; // what the editor currently holds
  savedContent: string; // what we last wrote to or read from disk
  modTime: number; // disk modified time when we last read or wrote
  view: View;
  conflict: { disk: string; diskModTime: number } | null;
  saveTimer: number | null;
  saving: boolean;
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
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3500);
}

// ---------- theme ----------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themeSetting: ThemeSetting = 'auto';
try {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark' || saved === 'auto') themeSetting = saved;
} catch {
  // storage unavailable; keep the default
}

const isDark = () => (themeSetting === 'auto' ? darkQuery.matches : themeSetting === 'dark');

function applyTheme(remount: boolean): void {
  document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
  applyCrepeTheme(isDark());
  $('btn-theme').textContent = 'Theme: ' + themeSetting;
  if (remount) void mountEditor(editor?.getScroll());
}

$('btn-theme').addEventListener('click', () => {
  themeSetting = themeSetting === 'auto' ? 'light' : themeSetting === 'light' ? 'dark' : 'auto';
  try {
    localStorage.setItem('theme', themeSetting);
  } catch {
    // ignore
  }
  applyTheme(true);
});
darkQuery.addEventListener('change', () => {
  if (themeSetting === 'auto') applyTheme(true);
});

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

function renderChrome(): void {
  renderTabs();
  renderBanner();
  emptyEl.hidden = tabs.length > 0;
  editorEl.hidden = tabs.length === 0;
  $('btn-export-html').toggleAttribute('disabled', !active);
  $('btn-export-pdf').toggleAttribute('disabled', !active);
  document.querySelectorAll<HTMLElement>('#view-toggle button').forEach((b) => {
    b.classList.toggle('active', !!active && b.dataset.view === active.view);
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
    const data = await ReadFile(path);
    const tab: Tab = {
      path,
      content: data.content,
      savedContent: data.content,
      modTime: data.modTime,
      view: defaultView,
      conflict: null,
      saveTimer: null,
      saving: false,
    };
    tabs.push(tab);
    if (!tree.rootPath) void tree.setRoot(dirname(path));
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
  if (target.kind === 'local' && /\.(md|markdown)$/i.test(target.path)) {
    await openFile(target.path);
    return;
  }
  try {
    await OpenLink(target.kind === 'web' ? target.url : target.path);
  } catch (e) {
    toast(`Could not open ${href}: ${e}`);
  }
}

async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (await IsDir(p)) await tree.setRoot(p);
    else await openFile(p);
  }
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
  if (!tab.conflict) tab.saveTimer = window.setTimeout(() => void saveNow(tab), AUTOSAVE_MS);
}

async function saveNow(tab: Tab): Promise<void> {
  if (tab.saveTimer !== null) {
    window.clearTimeout(tab.saveTimer);
    tab.saveTimer = null;
  }
  if (tab.conflict || tab.saving || !isDirty(tab)) return;
  tab.saving = true;
  try {
    // Make sure nobody else changed the file since we last looked.
    let diskTime: number | null = null;
    try {
      diskTime = await StatFile(tab.path);
    } catch {
      // The file was deleted; saving will recreate it.
    }
    if (diskTime !== null && diskTime !== tab.modTime) {
      await handleDiskChange(tab);
      return;
    }
    const content = tab.content;
    tab.modTime = await WriteFile(tab.path, content);
    tab.savedContent = content;
  } catch (e) {
    toast(`Could not save ${basename(tab.path)}: ${e}`);
  } finally {
    tab.saving = false;
    renderTabs();
  }
}

/** The file on disk differs from what we last saw. Reload quietly, or flag a conflict. */
async function handleDiskChange(tab: Tab): Promise<void> {
  let disk;
  try {
    disk = await ReadFile(tab.path);
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
      const mt = await StatFile(tab.path);
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

// The Go side holds the window open until we have saved everything.
EventsOn('request-close', async () => {
  await flushAll();
  EventsEmit('close-ready');
});

// ---------- export ----------

async function exportHtml(): Promise<void> {
  if (!active) return;
  const name = basename(active.path).replace(/\.(md|markdown)$/i, '');
  const html = renderStandalone(active.content, active.path, name);
  try {
    const saved = await SaveExport(name + '.html', html);
    if (saved) toast('Exported to ' + saved);
  } catch (e) {
    toast('Export failed: ' + e);
  }
}

async function exportPdf(): Promise<void> {
  if (!active) return;
  const root = $('print-root');
  root.innerHTML = `<style>${documentCss}</style>` + renderBody(active.content, active.path, true);
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
  const paths = await PickFiles();
  if (paths?.length) await openPaths(paths);
}

async function pickFolder(): Promise<void> {
  const dir = await PickFolder();
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

const tree = new Tree($('tree'), $('sidebar-title'), (p) => void openFile(p));

EventsOn('open-paths', (paths: string[]) => void openPaths(paths));

// Backstop: no link anywhere in the app may open a popup window or navigate the app window.
// The editor handles the links it knows about before this runs.
window.open = () => null;
for (const type of ['click', 'auxclick'] as const) {
  document.addEventListener(type, (e) => {
    if ((e.target as Element).closest?.('a[href]')) e.preventDefault();
  });
}
applyTheme(false);
renderChrome();
void StartupPaths().then(openPaths);

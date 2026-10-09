// The browser build: files are reached through the File System Access API (Chrome and Edge only).
//
// The browser never tells a page real disk paths. It hands out "handles" to the files and folders
// the user picks or drops. The rest of the app works with path strings, so each picked item gets a
// made-up top-level path ("/notes" for a folder called notes) and everything inside it is reached
// by walking down from that handle ("/notes/sub/todo.md").
import type { Backend, Entry } from './index';
import { NeedsPermission, NoAccess } from './errors';
import { loadHandles, saveHandles } from './handle-store';

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

// Kept before main.ts replaces window.open to stop links opening popups.
const openWindow = window.open.bind(window);

/**
 * The service worker that lets MdGeek be installed and run offline. Browsers only allow one on https
 * or localhost, so it's skipped when index.html is opened straight from disk.
 */
const swRegistration: Promise<ServiceWorkerRegistration | null> =
  'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')
    ? navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => {
        console.warn('MdGeek: could not set up offline use', e);
        return null;
      })
    : Promise.resolve(null);

/** Picked and dropped items, by the top-level name they were given. */
const roots = new Map<string, Handle>();

/** Every path register() handed out, with its handle, so the left pane can be saved without lookups. */
const registered = new Map<string, Handle>();

const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);
const isCancel = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

function segments(path: string): string[] {
  return path.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
}

/** Gives a picked or dropped item a top-level path, or returns the one it already has. */
async function register(handle: Handle): Promise<string> {
  const path = await pathFor(handle);
  registered.set(path, handle);
  return path;
}

async function pathFor(handle: Handle): Promise<string> {
  for (const [name, h] of roots) {
    if (await h.isSameEntry(handle)) return '/' + name;
    // A file inside a folder that's already open gets its path inside that folder.
    if (h.kind === 'directory') {
      const inner = await h.resolve(handle).catch(() => null);
      if (inner) return ['', name, ...inner].join('/');
    }
  }
  let name = handle.name;
  for (let n = 2; roots.has(name); n++) name = `${handle.name} (${n})`;
  roots.set(name, handle);
  return '/' + name;
}

/**
 * Makes sure the browser lets MdGeek read this picked or dropped item. After a restart it has to ask
 * again, which only works right after a click, so this throws NoAccess when it can't ask.
 */
async function ensureReadable(h: Handle): Promise<void> {
  if ((await h.queryPermission({ mode: 'read' })) === 'granted') return;
  const state = await h.requestPermission({ mode: 'read' }).catch(() => 'prompt' as const);
  if (state !== 'granted') throw new NoAccess(h.name);
}

/** Finds the handle for a path. Throws "not found" if anything along the way doesn't exist. */
async function lookup(path: string): Promise<Handle> {
  const [first, ...rest] = segments(path);
  let h = first === undefined ? undefined : roots.get(first);
  if (!h) throw new Error('file not found');
  await ensureReadable(h);
  for (const seg of rest) {
    if (h.kind !== 'directory') throw new Error('file not found');
    if (seg === '..') throw new Error('file not found');
    h = await h.getDirectoryHandle(seg).catch(() => (h as FileSystemDirectoryHandle).getFileHandle(seg));
  }
  return h;
}

async function lookupFile(path: string): Promise<FileSystemFileHandle> {
  const h = await lookup(path);
  if (h.kind !== 'file') throw new Error('that is a folder');
  return h;
}

/**
 * Asks for permission to save, if the browser hasn't given it yet. The browser only shows that prompt
 * right after a click, so a save that runs on its own (autosave) can fail here with NeedsPermission.
 */
async function ensureWritable(h: Handle): Promise<void> {
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return;
  const state = await h.requestPermission({ mode: 'readwrite' }).catch(() => 'prompt' as const);
  if (state !== 'granted') throw new NeedsPermission();
}

/** Whether a remembered item was deleted or moved. Only checkable once the browser allows access. */
async function isGone(h: Handle): Promise<boolean> {
  if ((await h.queryPermission({ mode: 'read' })) !== 'granted') return false;
  try {
    if (h.kind === 'file') await h.getFile();
    else await h.entries().next();
    return false;
  } catch (e) {
    return e instanceof DOMException && e.name === 'NotFoundError';
  }
}

/** The file to save to. A file deleted since it was opened is created again, as the desktop app does. */
async function fileForWrite(path: string): Promise<FileSystemFileHandle> {
  try {
    return await lookupFile(path);
  } catch {
    const segs = segments(path);
    const name = segs.pop();
    const dir = await lookup('/' + segs.join('/'));
    if (!name || dir.kind !== 'directory') throw new Error('file not found');
    await ensureWritable(dir);
    return dir.getFileHandle(name, { create: true });
  }
}

/** Images shown in the editor, kept so the same image isn't read again on every redraw. */
const imageCache = new Map<string, { modTime: number; url: string }>();

function setting(key: string): string {
  try {
    return localStorage.getItem('mdgeek.' + key) ?? '';
  } catch {
    return ''; // storage blocked; fall back to defaults
  }
}

export const webBackend: Backend = {
  // A page has no command line. Files from File Explorer arrive through onOpenPaths instead.
  startupPaths: async () => [],

  async listDir(dir) {
    const h = await lookup(dir);
    if (h.kind !== 'directory') throw new Error('not a folder');
    const entries: Entry[] = [];
    for await (const [name, child] of h.entries()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = dir.replace(/\/$/, '') + '/' + name;
      if (child.kind === 'directory') entries.push({ name, path, isDir: true });
      else if (isMarkdown(name)) entries.push({ name, path, isDir: false });
    }
    return entries.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1,
    );
  },

  async isDir(path) {
    try {
      return (await lookup(path)).kind === 'directory';
    } catch {
      return false;
    }
  },

  async readFile(path) {
    const file = await (await lookupFile(path)).getFile();
    return { content: await file.text(), modTime: file.lastModified };
  },

  async statFile(path) {
    return (await (await lookupFile(path)).getFile()).lastModified;
  },

  // createWritable writes to a temporary copy and only replaces the file on close(), so a crash
  // can't leave a half-written file.
  async writeFile(path, content) {
    const h = await fileForWrite(path);
    await ensureWritable(h);
    const w = await h.createWritable();
    await w.write(content);
    await w.close();
    return (await h.getFile()).lastModified;
  },

  async pickFiles() {
    let handles: FileSystemFileHandle[];
    try {
      handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
      });
    } catch (e) {
      if (isCancel(e)) return [];
      throw e;
    }
    // Ask now, while the click still counts, so autosave doesn't hit a permission prompt later.
    for (const h of handles) await h.requestPermission({ mode: 'readwrite' }).catch(() => undefined);
    return Promise.all(handles.map(register));
  },

  async pickFolder() {
    try {
      return await register(await window.showDirectoryPicker({ mode: 'readwrite' }));
    } catch (e) {
      if (isCancel(e)) return '';
      throw e;
    }
  },

  async saveExport(defaultName, content) {
    let h: FileSystemFileHandle;
    try {
      h = await window.showSaveFilePicker({ suggestedName: defaultName });
    } catch (e) {
      if (isCancel(e)) return '';
      throw e;
    }
    const w = await h.createWritable();
    await w.write(content);
    await w.close();
    return h.name;
  },

  async openLink(target) {
    if (/^(https?|mailto):/i.test(target)) {
      openWindow(target, '_blank', 'noopener,noreferrer');
      return;
    }
    throw new Error('the browser version can only open Markdown files and web links');
  },

  getSetting: async (key) => setting(key),

  async setSetting(key, value) {
    localStorage.setItem('mdgeek.' + key, value);
  },

  async imageUrl(path) {
    try {
      const file = await (await lookupFile(path)).getFile();
      const cached = imageCache.get(path);
      if (cached?.modTime === file.lastModified) return cached.url;
      if (cached) URL.revokeObjectURL(cached.url);
      const url = URL.createObjectURL(file);
      imageCache.set(path, { modTime: file.lastModified, url });
      return url;
    } catch {
      return ''; // not inside an opened folder, so the browser can't reach it
    }
  },

  // A page can't hold the window open while it saves. Saving starts as soon as the page is hidden,
  // and if anything is still unsaved the browser shows its "Leave site?" prompt.
  onClose(flush, hasUnsaved) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush();
    });
    window.addEventListener('beforeunload', (e) => {
      if (!hasUnsaved()) return;
      void flush();
      e.preventDefault();
    });
  },

  // The installed app is registered for .md files (manifest.webmanifest). Files opened with it from
  // File Explorer arrive here, both at startup and while it's already open.
  onOpenPaths(fn) {
    window.launchQueue?.setConsumer(async ({ files }) => {
      if (!files.length) return;
      const paths: string[] = [];
      for (const h of files) paths.push(await register(h as Handle));
      fn(paths);
    });
  },

  onFileDrop(fn) {
    window.addEventListener(
      'dragover',
      (e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
      },
      true,
    );
    window.addEventListener(
      'drop',
      (e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        // The handles must all be requested before the first await, while the drop data is readable.
        const pending = Array.from(e.dataTransfer.items)
          .filter((it) => it.kind === 'file')
          .map((it) => it.getAsFileSystemHandle());
        const { clientX: x, clientY: y } = e;
        void Promise.all(pending).then(async (handles) => {
          const paths: string[] = [];
          for (const h of handles) if (h) paths.push(await register(h as Handle));
          fn(x, y, paths);
        });
      },
      true,
    );
  },

  async allowSaving(path) {
    const h = await fileForWrite(path).catch(() => null);
    if (!h) return false;
    try {
      await ensureWritable(h);
      return true;
    } catch {
      return false;
    }
  },

  async rememberedItems() {
    const items: { path: string; isDir: boolean }[] = [];
    let dropped = false;
    for (const h of (await loadHandles()) as Handle[]) {
      // Deleted or moved since last time: quietly left out.
      if (await isGone(h)) {
        dropped = true;
        continue;
      }
      items.push({ path: await register(h), isDir: h.kind === 'directory' });
    }
    if (dropped) await this.rememberItems(items);
    return items;
  },

  async rememberItems(items) {
    const handles = items.map((it) => registered.get(it.path)).filter((h): h is Handle => !!h);
    await saveHandles(handles);
  },

  onUpdateReady(fn) {
    void swRegistration.then((reg) => {
      if (!reg) return;
      // Only an update if a version is already running; the very first install needs no reload.
      const offer = (worker: ServiceWorker) => {
        if (!navigator.serviceWorker.controller) return;
        fn(() => {
          navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
          worker.postMessage({ type: 'activate-now' });
        });
      };
      const watch = (worker: ServiceWorker | null) => {
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed') offer(worker);
        });
      };
      if (reg.waiting) offer(reg.waiting);
      watch(reg.installing); // a download that started before this code ran
      reg.addEventListener('updatefound', () => watch(reg.installing));
      // The browser checks for a new version when the app starts. An app left open for days would
      // miss it, so check again every hour, and whenever the window comes back into view (at most
      // every five minutes).
      let lastCheck = Date.now();
      const check = () => {
        lastCheck = Date.now();
        void reg.update().catch(() => undefined);
      };
      window.setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastCheck > 5 * 60 * 1000) check();
      });
    });
  },
};

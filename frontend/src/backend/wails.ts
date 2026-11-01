// The desktop build: every call goes to the Go code in app.go, links.go, and settings.go.
import { ClipboardSetText, EventsEmit, EventsOn, OnFileDrop } from '../../wailsjs/runtime/runtime';
import * as Go from '../../wailsjs/go/main/App';
import { basename, dirname } from '../paths';
import { RECENT_MAX, type Backend } from './index';

// The Recent files list is a JSON array of paths in settings.json, newest first.
async function recentPaths(): Promise<string[]> {
  try {
    const list: unknown = JSON.parse((await Go.GetSetting('recentFiles')) || '[]');
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return []; // a damaged setting just means an empty list
  }
}
const saveRecent = (paths: string[]) => Go.SetSetting('recentFiles', JSON.stringify(paths.slice(0, RECENT_MAX)));
// Windows paths ignore case, so "C:/Notes/a.md" and "c:/notes/A.md" are the same file.
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const wailsBackend: Backend = {
  startupPaths: () => Go.StartupPaths(),
  listDir: (dir) => Go.ListDir(dir),
  isDir: (path) => Go.IsDir(path),
  readFile: (path) => Go.ReadFile(path),
  statFile: (path) => Go.StatFile(path),
  writeFile: (path, content) => Go.WriteFile(path, content),
  pickFiles: async () => (await Go.PickFiles()) ?? [],
  pickFolder: () => Go.PickFolder(),
  newFile: (near) => Go.NewFile(near),
  saveExport: (name, content) => Go.SaveExport(name, content),
  openLink: (target) => Go.OpenLink(target),
  async copyText(text) {
    if (!(await ClipboardSetText(text))) throw new Error('the clipboard is not available');
  },
  showInFolder: (path) => Go.ShowInFolder(path),
  getSetting: (key) => Go.GetSetting(key),
  setSetting: (key, value) => Go.SetSetting(key, value),
  // Served by the localFiles handler in app.go.
  imageUrl: (path) => '/localfile?p=' + encodeURIComponent(path),

  // The Go side holds the window open until we answer "close-ready".
  onClose(flush) {
    EventsOn('request-close', async () => {
      await flush();
      EventsEmit('close-ready');
    });
  },
  onOpenPaths(fn) {
    EventsOn('open-paths', fn);
  },
  onFileDrop(fn) {
    OnFileDrop(fn, false);
  },
  // The desktop app is updated by installing a new version.
  onUpdateReady() {},
  checkForUpdate: async () => 'latest',
  allowSaving: async () => true,
  // The desktop app starts with an empty left pane, as it always has.
  rememberedItems: async () => [],
  rememberItems: async () => {},

  recentFiles: async () => (await recentPaths()).map((path) => ({ path, name: basename(path), where: dirname(path) })),
  async addRecent(path) {
    await saveRecent([path, ...(await recentPaths()).filter((p) => !samePath(p, path))]);
  },
  async removeRecent(path) {
    await saveRecent((await recentPaths()).filter((p) => !samePath(p, path)));
  },
  clearRecent: () => saveRecent([]),
};

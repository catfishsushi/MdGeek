// The desktop build: every call goes to the Go code in app.go, links.go, and settings.go.
import { EventsEmit, EventsOn, OnFileDrop } from '../../wailsjs/runtime/runtime';
import * as Go from '../../wailsjs/go/main/App';
import type { Backend } from './index';

export const wailsBackend: Backend = {
  startupPaths: () => Go.StartupPaths(),
  listDir: (dir) => Go.ListDir(dir),
  isDir: (path) => Go.IsDir(path),
  readFile: (path) => Go.ReadFile(path),
  statFile: (path) => Go.StatFile(path),
  writeFile: (path, content) => Go.WriteFile(path, content),
  pickFiles: async () => (await Go.PickFiles()) ?? [],
  pickFolder: () => Go.PickFolder(),
  saveExport: (name, content) => Go.SaveExport(name, content),
  openLink: (target) => Go.OpenLink(target),
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
};

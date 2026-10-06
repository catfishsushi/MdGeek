// Everything the app needs from outside the page: files, dialogs, settings, links, and window events.
// The desktop build (Wails) gets these from Go; the browser build (npm run build:web) gets them
// from the browser's File System Access API. The rest of the frontend only talks to `backend`.
import { wailsBackend } from './wails';
import { webBackend } from './web';

/** One item in the sidebar file tree. */
export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

/** A file's text plus its modified time, used to spot outside changes. */
export interface FileData {
  content: string;
  modTime: number;
}

export interface Backend {
  /** Files or folders the app was started with ("Open with"). */
  startupPaths(): Promise<string[]>;
  /** Subfolders and Markdown files directly inside dir, folders first. */
  listDir(dir: string): Promise<Entry[]>;
  isDir(path: string): Promise<boolean>;
  readFile(path: string): Promise<FileData>;
  /** The file's modified time. Fails if the file is gone. */
  statFile(path: string): Promise<number>;
  /** Saves text, creating the file if needed, and returns the new modified time. */
  writeFile(path: string, content: string): Promise<number>;
  /** Shows the "open file" dialog. Returns [] if cancelled. */
  pickFiles(): Promise<string[]>;
  /** Shows the "open folder" dialog. Returns "" if cancelled. */
  pickFolder(): Promise<string>;
  /** Asks where to save an exported file and writes it. Returns where it went, or "" if cancelled. */
  saveExport(defaultName: string, content: string): Promise<string>;
  /** Opens a web link, or a local file that isn't Markdown, outside the app. */
  openLink(target: string): Promise<void>;
  getSetting(key: string): Promise<string>;
  setSetting(key: string, value: string): Promise<void>;
  /** A URL the page can load an image from, for an image at this path. */
  imageUrl(path: string): Promise<string> | string;
  /** Runs flush before the window closes. hasUnsaved says whether closing now would lose edits. */
  onClose(flush: () => Promise<void>, hasUnsaved: () => boolean): void;
  /** Files sent to an already-running app (a second "Open with"). */
  onOpenPaths(fn: (paths: string[]) => void): void;
  /** Files dropped onto the window from File Explorer, with the page position of the drop. */
  onFileDrop(fn: (x: number, y: number, paths: string[]) => void): void;
}

// Vite replaces import.meta.env.MODE with a fixed string at build time, so each build keeps only one.
export const backend: Backend = import.meta.env.MODE === 'web' ? webBackend : wailsBackend;

// Parts of the File System Access API that TypeScript's built-in browser types don't include yet.
// Chrome and Edge support them; see https://developer.mozilla.org/docs/Web/API/File_System_API

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface Window {
  showOpenFilePicker(options?: { multiple?: boolean; types?: FilePickerAcceptType[] }): Promise<FileSystemFileHandle[]>;
  showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker(options?: { suggestedName?: string; types?: FilePickerAcceptType[] }): Promise<FileSystemFileHandle>;
  /** Files sent to the installed app from File Explorer. Missing outside installed apps and in other browsers. */
  launchQueue?: LaunchQueue;
}

interface LaunchParams {
  files: FileSystemHandle[];
}

interface LaunchQueue {
  setConsumer(fn: (params: LaunchParams) => void): void;
}

interface FileSystemHandle {
  queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface DataTransferItem {
  getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
}

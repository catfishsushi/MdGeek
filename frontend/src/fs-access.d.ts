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
}

interface FileSystemHandle {
  queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface DataTransferItem {
  getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
}

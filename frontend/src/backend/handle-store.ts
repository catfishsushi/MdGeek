// Keeps the left pane's files and folders, and the Recent files list, between sessions. They're saved as the browser's file and
// folder handles, which IndexedDB can store but localStorage (strings only) can't. If storage is
// blocked or broken, MdGeek just starts with an empty left pane.
const DB = 'mdgeek';
const STORE = 'handles';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Which saved list: the left pane's items, or the Recent files. */
export type ListKey = 'sidebar' | 'recent';

/** The saved handles, in order. [] if there are none or storage isn't available. */
export async function loadHandles(key: ListKey): Promise<FileSystemHandle[]> {
  try {
    const list = await run<unknown>('readonly', (s) => s.get(key));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveHandles(key: ListKey, list: FileSystemHandle[]): Promise<void> {
  try {
    await run('readwrite', (s) => s.put(list, key));
  } catch {
    // Not remembered next time; nothing else is affected.
  }
}

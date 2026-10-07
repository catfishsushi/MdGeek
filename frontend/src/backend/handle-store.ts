// Keeps the left pane's files and folders between sessions. They're saved as the browser's file and
// folder handles, which IndexedDB can store but localStorage (strings only) can't. If storage is
// blocked or broken, MdGeek just starts with an empty left pane.
const DB = 'mdgeek';
const STORE = 'handles';
const KEY = 'sidebar';

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

/** The saved handles, in left pane order. [] if there are none or storage isn't available. */
export async function loadHandles(): Promise<FileSystemHandle[]> {
  try {
    const list = await run<unknown>('readonly', (s) => s.get(KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveHandles(list: FileSystemHandle[]): Promise<void> {
  try {
    await run('readwrite', (s) => s.put(list, KEY));
  } catch {
    // Not remembered next time; nothing else is affected.
  }
}

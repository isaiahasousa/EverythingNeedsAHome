/**
 * Autosave. Projects normally live in localStorage; one with large images can outgrow its quota
 * (about 5 MB), so it moves to IndexedDB and localStorage keeps a small marker pointing there.
 * Every storage call can throw (private windows, blocked site data), so each one is guarded.
 */

export const STORAGE_KEY = 'everythingneedsahome.project.v1';
/** Autosave key used before the rename; read once so earlier work carries over. */
export const LEGACY_KEY = 'boxsmith.project.v1';

const DB_NAME = 'everythingneedsahome';
const DB_STORE = 'autosave';

/**
 * Where the last autosave went: 'dropped-images' means only a copy without its images fitted;
 * 'paused' means saving is off because an existing save could not be read (it is kept untouched).
 */
export type SaveOutcome = 'local' | 'indexeddb' | 'dropped-images' | 'failed' | 'paused';

let paused = false;

/** Stop autosaving for this page load, so a save that could not be read is not overwritten. */
export function pauseAutosave() {
  paused = true;
}

interface Marker {
  storedIn: 'indexeddb';
  savedAt: number;
}

const isMarker = (v: unknown): v is Marker => !!v && typeof v === 'object' && (v as Marker).storedIn === 'indexeddb';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB is blocked'));
    } catch (e) {
      reject(e);
    }
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
  } finally {
    db.close();
  }
}

/** The saved project JSON, if it fits in localStorage. Null when nothing is saved or it lives in IndexedDB. */
export function readLocal(): unknown {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return isMarker(v) ? null : v;
  } catch {
    return null;
  }
}

/** True when the last autosave went to IndexedDB, so `readIndexedDb` has the real project. */
export function savedInIndexedDb(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return !!raw && raw.length < 200 && isMarker(JSON.parse(raw));
  } catch {
    return false;
  }
}

/**
 * The project kept in IndexedDB. 'missing' means the store answered and has no copy (site data was
 * cleared); 'error' means it could not be read this time, so the copy may still be there.
 */
export async function readIndexedDb(): Promise<{ status: 'ok'; value: unknown } | { status: 'missing' | 'error' }> {
  let raw: string | undefined;
  try {
    raw = await idb('readonly', (s) => s.get(STORAGE_KEY) as IDBRequest<string | undefined>);
  } catch {
    return { status: 'error' };
  }
  if (typeof raw !== 'string') return { status: 'missing' };
  try {
    return { status: 'ok', value: JSON.parse(raw) };
  } catch {
    return { status: 'missing' };
  }
}

/**
 * Save `project` (any JSON-able value). `slim` builds a smaller copy without images, used only when
 * neither store takes the full project.
 */
export function persist(project: unknown, slim: () => unknown): Promise<SaveOutcome> {
  // One save at a time, in order: an older save finishing late must not overwrite a newer one.
  const run = () => persistNow(project, slim);
  const next = queue.then(run, run);
  queue = next.catch(() => 'failed' as const);
  return next;
}

let queue: Promise<SaveOutcome> = Promise.resolve('local');

async function persistNow(project: unknown, slim: () => unknown): Promise<SaveOutcome> {
  if (paused) return 'paused';
  const json = JSON.stringify(project);
  const hadIndexedDbCopy = savedInIndexedDb();
  try {
    localStorage.setItem(STORAGE_KEY, json);
    // A full copy fits locally again; free the stale IndexedDB copy.
    if (hadIndexedDbCopy) await idb('readwrite', (s) => s.delete(STORAGE_KEY)).catch(() => {});
    return 'local';
  } catch {
    // Over quota (or storage is blocked): try IndexedDB below.
  }
  try {
    await idb('readwrite', (s) => s.put(json, STORAGE_KEY));
    const marker: Marker = { storedIn: 'indexeddb', savedAt: Date.now() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(marker));
    } catch {
      // Without the marker the next visit falls back to an older local copy; still better than nothing.
    }
    return 'indexeddb';
  } catch {
    // IndexedDB unavailable too.
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim()));
    return 'dropped-images';
  } catch {
    return 'failed';
  }
}

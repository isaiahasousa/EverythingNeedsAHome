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
 * 'paused' means saving is off because an existing save could not be read (it is kept untouched);
 * 'superseded' means a newer save started first and this one stood aside.
 */
export type SaveOutcome = 'local' | 'indexeddb' | 'dropped-images' | 'failed' | 'paused' | 'superseded';

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

/**
 * The IndexedDB connection, kept open once used: a save started while the page is closing must begin
 * synchronously, and opening a connection never finishes in time.
 */
let connection: Promise<IDBDatabase> | null = null;
let openConnection: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => {
          const db = req.result;
          const forget = () => {
            if (openConnection === db) openConnection = null;
            connection = null;
          };
          // Step aside for another tab that upgrades the database; the next save reconnects.
          db.onversionchange = () => {
            db.close();
            forget();
          };
          db.onclose = forget;
          openConnection = db;
          resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB is blocked'));
      } catch (e) {
        reject(e);
      }
    });
    connection.catch(() => (connection = null));
  }
  return connection;
}

/**
 * Run one request in its own transaction, committed as soon as it is done (a page closing can't wait).
 * `wanted` is asked once the connection is open, right before the transaction starts.
 */
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, wanted = () => true): Promise<T | undefined> {
  const db = await openDb();
  if (!wanted()) return undefined;
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    (tx as IDBTransaction & { commit?: () => void }).commit?.();
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
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
  // One save at a time, in order, and only the newest one writes: an older save finishing late must
  // not overwrite a newer one.
  const generation = ++latest;
  const run = () => persistNow(project, slim, generation);
  const next = queue.then(run, run);
  queue = next.catch(() => 'failed' as const);
  return next;
}

let queue: Promise<SaveOutcome> = Promise.resolve('local');
/** The newest save asked for: an older one still waiting to run stands aside. */
let latest = 0;
/**
 * The newest save whose copy has landed. An older save finishing later must not point localStorage at
 * IndexedDB, or delete the IndexedDB copy, over it.
 */
let finished = 0;

const writeMarker = () => {
  const marker: Marker = { storedIn: 'indexeddb', savedAt: Date.now() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(marker));
  } catch {
    // Without the marker the next visit falls back to an older local copy; still better than nothing.
  }
};

async function persistNow(project: unknown, slim: () => unknown, generation: number): Promise<SaveOutcome> {
  if (paused) return 'paused';
  if (generation !== latest) return 'superseded';
  const json = JSON.stringify(project);
  const hadIndexedDbCopy = savedInIndexedDb();
  try {
    localStorage.setItem(STORAGE_KEY, json);
    finished = generation;
    // A full copy fits locally again; free the stale IndexedDB copy, unless a newer save is under way.
    if (hadIndexedDbCopy || openConnection) await idb('readwrite', (s) => s.delete(STORAGE_KEY), () => generation === latest).catch(() => {});
    return 'local';
  } catch {
    // Over quota (or storage is blocked): try IndexedDB below.
  }
  try {
    await idb('readwrite', (s) => s.put(json, STORAGE_KEY));
    // Point localStorage at the copy, even if a newer save is waiting: until that one lands this is the
    // newest copy there is.
    if (finished > generation) return 'superseded';
    writeMarker();
    finished = generation;
    return 'indexeddb';
  } catch {
    // IndexedDB unavailable too.
  }
  if (finished > generation) return 'superseded';
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim()));
    finished = generation;
    return 'dropped-images';
  } catch {
    return 'failed';
  }
}

/**
 * Save while the page is being hidden, reloaded or closed. Nothing asynchronous finishes then, so the
 * write starts in this call: localStorage, or for a project too big for it, the IndexedDB connection an
 * earlier save or load opened. (With no connection open, a queued save is the best left to try.)
 */
export function persistBeforeUnload(project: unknown, slim: () => unknown) {
  if (paused) return;
  const generation = ++latest;
  const json = JSON.stringify(project);
  try {
    localStorage.setItem(STORAGE_KEY, json);
    finished = generation;
    return;
  } catch {
    // Over quota: IndexedDB below.
  }
  if (openConnection) {
    try {
      // Transactions run in the order they are made, so this lands after any earlier save's.
      const tx = openConnection.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(json, STORAGE_KEY);
      (tx as IDBTransaction & { commit?: () => void }).commit?.();
      writeMarker();
      finished = generation;
      return;
    } catch {
      // The connection closed; fall back to a queued save below.
    }
  }
  const run = () => persistNow(project, slim, generation);
  queue = queue.then(run, run).catch(() => 'failed' as const);
}

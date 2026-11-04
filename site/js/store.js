// The files, kept in this browser (IndexedDB) once loaded, so the next visit
// needs no download and no token. Nothing here ever leaves the machine.

const DB = "llm-aggrefact-viewer", STORE = "files";

function open() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: "name" });
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
    rq.onblocked = () => reject(new Error("browser storage is busy in another tab"));
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("storage transaction aborted"));
    });
  } finally {
    db.close();
  }
}

/** files: [{name, split, buffer}] replace whatever was stored. */
export const save = (files) => tx("readwrite", (s) => {
  s.clear();
  for (const f of files) s.put({ name: f.name, split: f.split, buffer: f.buffer, size: f.buffer.byteLength, savedAt: Date.now() });
});

/** -> [{name, split, buffer, size, savedAt}] (empty if nothing is stored or storage is unavailable). */
export async function load() {
  try { return await tx("readonly", (s) => s.getAll()); }
  catch { return []; }
}

export const clear = () => tx("readwrite", (s) => s.clear());

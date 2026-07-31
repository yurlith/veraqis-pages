// VERAQIS Studio — ProjectStore.
//
// The only module that touches IndexedDB. UI code never opens a database.
//
// Nothing is persisted unless the user explicitly saves. A plain analysis lives
// in memory and disappears on reload — a storage-privacy test asserts that after
// an analysis without Save, IndexedDB contains no project.
//
// Falls back to an in-memory store when IndexedDB is unavailable (private
// browsing disables it in some browsers), so the app degrades rather than fails.

import { StudioError, ERR, toStudioError } from './errors.js';
import { serializeProject, validateProject, parseProjectFile, PROJECT_SCHEMA_VERSION } from './project.js';

const DB_NAME = 'veraqis-studio';
const DB_VERSION = 1;
const STORE = 'projects';
const SETTINGS_KEY = 'veraqis-studio-settings';

/* ------------------------------------------------------------ memory fallback */

class MemoryBackend {
  constructor() { this.map = new Map(); this.kind = 'memory'; this.durable = false; }
  async list() { return [...this.map.values()].map(summaryOf).sort(byUpdated); }
  async get(id) { return this.map.get(id) || null; }
  async put(p) { this.map.set(p.id, p); return p.id; }
  async del(id) { this.map.delete(id); }
  async clear() { this.map.clear(); }
  async usage() { return { projects: this.map.size, bytes: null, quotaBytes: null }; }
}

/* ------------------------------------------------------------- IndexedDB */

class IdbBackend {
  constructor(db) { this.db = db; this.kind = 'indexeddb'; this.durable = true; }

  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = this.db.transaction(STORE, mode); }
      catch (e) { return reject(toStudioError(e, ERR.STORAGE_FAILED)); }
      const store = tx.objectStore(STORE);
      let out;
      try { out = fn(store); } catch (e) { return reject(toStudioError(e, ERR.STORAGE_FAILED)); }
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(new StudioError(ERR.STORAGE_FAILED, { detail: String(tx.error && tx.error.message) }));
      tx.onabort = () => reject(new StudioError(ERR.STORAGE_FAILED, { detail: 'the storage transaction was aborted (quota?)' }));
    });
  }

  async list() {
    const all = await this._tx('readonly', (s) => s.getAll());
    return (all || []).map(summaryOf).sort(byUpdated);
  }
  async get(id) { return (await this._tx('readonly', (s) => s.get(id))) || null; }
  async put(p) { await this._tx('readwrite', (s) => s.put(p)); return p.id; }
  async del(id) { await this._tx('readwrite', (s) => s.delete(id)); }
  async clear() { await this._tx('readwrite', (s) => s.clear()); }

  async usage() {
    const all = await this._tx('readonly', (s) => s.getAll());
    let bytes = 0;
    for (const p of all || []) { try { bytes += JSON.stringify(p).length; } catch { /* skip */ } }
    let quotaBytes = null;
    try {
      const est = await navigator.storage.estimate();
      quotaBytes = est.quota || null;
    } catch { /* estimate unsupported */ }
    return { projects: (all || []).length, bytes, quotaBytes };
  }
}

const byUpdated = (a, b) => String(b.updated).localeCompare(String(a.updated));

function summaryOf(p) {
  return {
    id: p.id,
    name: (p.source && p.source.name) || 'unnamed',
    size: (p.source && p.source.size) || 0,
    created: p.created,
    updated: p.updated,
    verdict: (p.analysis && p.analysis.verdict) || null,
    counts: (p.analysis && p.analysis.counts) || null,
    imported: !!p.imported,
    schemaVersion: p.schemaVersion,
  };
}

/* ------------------------------------------------------------------- public */

export class ProjectStore {
  constructor(backend) { this.backend = backend; }

  static async open() {
    if (typeof indexedDB === 'undefined') return new ProjectStore(new MemoryBackend());
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(STORE)) {
            const s = d.createObjectStore(STORE, { keyPath: 'id' });
            s.createIndex('updated', 'updated');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('the database is blocked by another tab'));
      });
      return new ProjectStore(new IdbBackend(db));
    } catch {
      // Private browsing, disabled storage, or a blocked upgrade. Degrade.
      return new ProjectStore(new MemoryBackend());
    }
  }

  get kind() { return this.backend.kind; }
  get durable() { return this.backend.durable; }

  listProjects() { return this.backend.list(); }
  loadProject(id) { return this.backend.get(id); }

  async saveProject(project) {
    if (!project || !project.id) throw new StudioError(ERR.PROJECT_SCHEMA_INVALID, { detail: 'the project has no id' });
    if (project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
      throw new StudioError(ERR.VERSION_MISMATCH, {
        detail: `project schema v${project.schemaVersion}, this build writes v${PROJECT_SCHEMA_VERSION}`,
      });
    }
    const copy = { ...project, updated: new Date().toISOString() };
    await this.backend.put(copy);
    return copy;
  }

  deleteProject(id) { return this.backend.del(id); }
  clearAllProjects() { return this.backend.clear(); }
  getStorageUsage() { return this.backend.usage(); }

  /** Ask the browser to make storage durable. Advisory; never required. */
  async requestPersistence() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return { granted: false, reason: 'not supported by this browser' };
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (already) return { granted: true, reason: 'already granted' };
      const granted = await navigator.storage.persist();
      return { granted, reason: granted ? 'granted' : 'the browser declined' };
    } catch (e) {
      return { granted: false, reason: String(e && e.message).slice(0, 120) };
    }
  }

  /** Serialise a project for download. Never includes archive bytes. */
  async exportProject(id) {
    const p = typeof id === 'string' ? await this.backend.get(id) : id;
    if (!p) throw new StudioError(ERR.STORAGE_FAILED, { detail: 'no such project' });
    return serializeProject(p);
  }

  /** Import from a File. Treated as untrusted; validated then rebuilt. */
  async importProject(file) {
    const { project, unknownFields } = await parseProjectFile(file);
    return { project, unknownFields };
  }

  /** Import from an already-parsed object (used by tests). */
  importParsed(obj) {
    const v = validateProject(obj);
    if (!v.ok) throw new StudioError(ERR.PROJECT_SCHEMA_INVALID, { detail: v.errors.join('; ') });
    return v;
  }
}

/* ----------------------------------------------------------------- settings */

export const DEFAULT_SETTINGS = {
  verifyCrc: true,
  fingerprintMode: 'fast',        // none | fast | full
  autoSaveProjects: false,        // saving is explicit by default
  showAdvanced: false,
  tableDensity: 'comfortable',
  entriesPerPage: 200,            // measured: 10k rows stalls Firefox 487 ms
  largeFileConfirmMB: 512,
  reportDetail: 'standard',
  experimentalRecoveryVisible: false,
};

/** Settings are preferences, not user data; localStorage is appropriate and is
 *  never given a filename or any analysis content. */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, k)
          && typeof parsed[k] === typeof DEFAULT_SETTINGS[k]) {
        out[k] = parsed[k];
      }
    }
    return out;
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return true; }
  catch { return false; }
}

export function resetSettings() {
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* nothing to remove */ }
  return { ...DEFAULT_SETTINGS };
}

/** Remove every trace Studio can create. Used by "Delete all local data". */
export async function deleteAllLocalData(store) {
  const result = { projects: false, settings: false, caches: false, opfs: false, errors: [] };
  try { await store.clearAllProjects(); result.projects = true; }
  catch (e) { result.errors.push('projects: ' + (e && e.message)); }
  try { localStorage.removeItem(SETTINGS_KEY); result.settings = true; }
  catch (e) { result.errors.push('settings: ' + (e && e.message)); }
  try {
    if (globalThis.caches) {
      for (const k of await caches.keys()) if (k.startsWith('veraqis-')) await caches.delete(k);
      result.caches = true;
    }
  } catch (e) { result.errors.push('caches: ' + (e && e.message)); }
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) {
        if (name.startsWith('veraqis-')) await root.removeEntry(name, { recursive: true });
      }
      result.opfs = true;
    }
  } catch { /* OPFS unavailable or empty */ }
  // The caches just cleared held the application shell, which is our code rather
  // than the user's data. Ask the service worker to re-prime it so offline use
  // survives a "delete everything" — otherwise the app quietly loses the ability
  // to run without a network until its next update.
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration('/studio/');
    const sw = reg && (reg.active || navigator.serviceWorker.controller);
    if (sw) {
      sw.postMessage({ type: 'PRIME' });
      result.shellReprimed = true;
    }
  } catch { /* no service worker; offline was never available anyway */ }
  return result;
}

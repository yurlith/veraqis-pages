// VERAQIS Studio — the lifetime of a verified output.
//
// A Blob URL is a live handle into the browser's memory that survives until it
// is revoked or the document goes away. An extracted file is the most sensitive
// thing Studio ever holds, so its handle is owned by exactly one place — this
// module — with one rule:
//
//     At most one prepared output exists at a time, and it is revoked the moment
//     it stops being the answer to the question the user asked.
//
// "Stops being the answer" covers: a new extraction, a different project, a
// different source file, a cancellation, a cleared workspace, a worker crash,
// the page unloading, and simply sitting unused past its time-to-live.
//
// A Blob URL is never written to IndexedDB, localStorage, sessionStorage, a
// report, a project file or the service-worker cache. A test asserts that.
//
// Touches the DOM only to click a link it creates and removes.

import { DEFAULT_EXTRACTION_POLICY } from './policy.js';

export const OUTPUT_STATE = {
  NONE: 'NONE',
  READY: 'READY',
  DOWNLOADED: 'DOWNLOADED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
};

export class OutputRegistry {
  /**
   * @param {object} [policy]
   * @param {(info:{state:string, reason:string})=>void} [onChange]
   */
  constructor(policy = DEFAULT_EXTRACTION_POLICY, onChange = () => {}) {
    this.policy = policy;
    this.onChange = onChange;
    /** @type {{url:string, filename:string, size:number, entryId:string, taskId:string|null,
     *           projectId:string|null, sourceKey:string|null, createdAt:number,
     *           state:string, ttlTimer:any}|null} */
    this.current = null;
    this._unloadBound = null;
  }

  get state() { return this.current ? this.current.state : OUTPUT_STATE.NONE; }
  get hasOutput() { return !!(this.current && this.current.state === OUTPUT_STATE.READY); }

  /**
   * Take ownership of a verified output. Any previous one is revoked first —
   * there is never a moment when two prepared outputs exist and the UI has to
   * decide which the download button means.
   *
   * @param {Blob} blob
   * @param {{filename:string, entryId:string, taskId?:string, projectId?:string, sourceKey?:string}} meta
   */
  adopt(blob, meta) {
    this.revoke('replaced by a newer extraction');
    let url;
    try { url = URL.createObjectURL(blob); }
    catch (e) { throw new Error('the verified output could not be prepared for download: ' + (e && e.message)); }

    this.current = {
      url,
      filename: meta.filename,
      size: blob.size,
      entryId: meta.entryId,
      taskId: meta.taskId || null,
      projectId: meta.projectId || null,
      sourceKey: meta.sourceKey || null,
      createdAt: Date.now(),
      state: OUTPUT_STATE.READY,
      ttlTimer: null,
    };

    // Time-to-live: an output nobody downloaded is not kept indefinitely just
    // because nothing went wrong.
    this.current.ttlTimer = setTimeout(() => {
      if (this.current && this.current.state === OUTPUT_STATE.READY) {
        this.current.state = OUTPUT_STATE.EXPIRED;
        this.revoke('the prepared output expired');
      }
    }, this.policy.blobUrlTtlMs);

    this._armUnload();
    this.onChange({ state: OUTPUT_STATE.READY, reason: '' });
    return this.current;
  }

  /**
   * Start the download. Revocation is deferred by a grace period, because
   * revoking synchronously can cancel the download the click just began.
   * @returns {boolean} whether a download was started
   */
  download(doc = document) {
    if (!this.hasOutput) return false;
    const c = this.current;
    try {
      const a = doc.createElement('a');
      a.href = c.url;
      a.download = c.filename;
      a.rel = 'noopener';
      doc.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      return false;
    }
    c.state = OUTPUT_STATE.DOWNLOADED;
    this.onChange({ state: OUTPUT_STATE.DOWNLOADED, reason: '' });
    setTimeout(() => {
      if (this.current === c) this.revoke('the download was started');
    }, this.policy.blobUrlRevokeDelayMs);
    return true;
  }

  /** Revoke and forget. Safe to call repeatedly and when nothing is held. */
  revoke(reason = '') {
    const c = this.current;
    if (!c) return false;
    if (c.ttlTimer) clearTimeout(c.ttlTimer);
    try { URL.revokeObjectURL(c.url); } catch { /* already gone */ }
    this.current = null;
    this._disarmUnload();
    this.onChange({ state: OUTPUT_STATE.REVOKED, reason });
    return true;
  }

  /**
   * Revoke if the output no longer belongs to what is on screen.
   * Called on every project change, source-file change and workspace reset, so
   * a stale enabled download button cannot survive any of them.
   */
  revokeIfStale({ projectId, sourceKey }) {
    const c = this.current;
    if (!c) return false;
    if (projectId !== undefined && c.projectId !== null && c.projectId !== projectId) {
      return this.revoke('the open project changed');
    }
    if (sourceKey !== undefined && c.sourceKey !== null && c.sourceKey !== sourceKey) {
      return this.revoke('the selected source file changed');
    }
    return false;
  }

  /** Describe the held output without exposing its URL. */
  describe() {
    const c = this.current;
    if (!c) return { state: OUTPUT_STATE.NONE };
    return {
      state: c.state, filename: c.filename, size: c.size,
      entryId: c.entryId, ageMs: Date.now() - c.createdAt,
    };
  }

  _armUnload() {
    if (this._unloadBound || typeof addEventListener !== 'function') return;
    this._unloadBound = () => this.revoke('the page was unloaded');
    addEventListener('pagehide', this._unloadBound);
    addEventListener('beforeunload', this._unloadBound);
  }

  _disarmUnload() {
    if (!this._unloadBound || typeof removeEventListener !== 'function') return;
    removeEventListener('pagehide', this._unloadBound);
    removeEventListener('beforeunload', this._unloadBound);
    this._unloadBound = null;
  }
}

/**
 * A cheap identity for "the file currently selected", used to notice that the
 * user picked a different one. Not a security check — `verifySourceBinding` in
 * project.js is — just enough to invalidate a prepared output promptly.
 */
export function sourceKeyOf(file) {
  if (!file) return null;
  return `${file.name}|${file.size}|${file.lastModified || 0}`;
}

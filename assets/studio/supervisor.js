// VERAQIS Studio — main-thread worker supervisor.
//
// Owns the worker's lifecycle so the UI never has to: version handshake,
// capability report, one active task, cancellation, timeout, crash recovery and
// idle disposal. A crash marks the task interrupted and offers a retry — it
// never reports a partial result as success.

import {
  PROTOCOL_VERSION, REQ, RES, newTaskId,
  isValidResponse, TASK_TIMEOUT_MS, IDLE_DISPOSE_MS,
} from './protocol.js';
import { StudioError, ERR, errorFromJSON } from './errors.js';

const WORKER_URL = '/assets/studio/worker.js';

export class WorkerSupervisor {
  constructor(opts = {}) {
    this.workerUrl = opts.workerUrl || WORKER_URL;
    this.worker = null;
    this.ready = null;            // Promise<{protocol, engines}>
    this.active = null;           // { taskId, resolve, reject, onProgress, timer }
    this.engines = [];
    this.protocol = null;
    this.crashCount = 0;
    this.onStatus = opts.onStatus || (() => {});
    this._idleTimer = null;
  }

  _status(state, detail = '') { this.onStatus({ state, detail, crashes: this.crashCount }); }

  _spawn() {
    if (this.worker) return this.ready;
    this._status('starting');
    let settle;
    this.ready = new Promise((res, rej) => { settle = { res, rej }; });
    this._settleReady = settle;
    this._readySettled = false;

    let w;
    try {
      w = new Worker(this.workerUrl, { type: 'module' });
    } catch (e) {
      const err = new StudioError(ERR.BROWSER_UNSUPPORTED, { detail: 'module workers are unavailable: ' + (e && e.message) });
      this._status('unavailable', err.userMessage);
      this.ready = Promise.reject(err);
      return this.ready;
    }
    this.worker = w;

    w.onmessage = (ev) => {
      const m = ev.data;
      if (!isValidResponse(m)) return;    // ignore anything malformed or spoofed

      if (m.type === RES.READY) {
        this.protocol = m.protocol;
        this.engines = m.engines || [];
        if (m.protocol !== PROTOCOL_VERSION) {
          // A stale cached worker is the realistic cause. Refuse it rather than
          // speaking a protocol we do not understand.
          const err = new StudioError(ERR.VERSION_MISMATCH, {
            detail: `page speaks protocol v${PROTOCOL_VERSION}, worker speaks v${m.protocol}`,
          });
          this._status('version-mismatch', err.userMessage);
          this._readySettled = true;
          settle.rej(err);
          this.terminate();
          return;
        }
        this._status('ready');
        this._readySettled = true;
        settle.res({ protocol: m.protocol, engines: this.engines });
        return;
      }

      const a = this.active;
      if (!a || m.taskId !== a.taskId) return;   // late message from a finished task

      if (m.type === RES.PROGRESS) { a.onProgress(m); return; }

      if (m.type === RES.RESULT) { this._finish(); a.resolve(m.result); return; }
      if (m.type === RES.CANCELLED) { this._finish(); a.reject(new StudioError(ERR.CANCELLED)); return; }
      if (m.type === RES.ERROR) { this._finish(); a.reject(errorFromJSON(m.error)); return; }
    };

    // A hard worker failure: the script threw at load, or the worker died.
    w.onerror = () => { this._handleCrash('the analysis worker failed'); };
    w.onmessageerror = () => { this._handleCrash('an analysis message could not be deserialised'); };

    return this.ready;
  }

  _handleCrash(detail) {
    this.crashCount++;
    const a = this.active;
    // If the worker died before its handshake, `ready` is still pending. Reject
    // it, or every caller awaiting start()/analyze() would hang forever — which
    // is exactly what the crash-recovery test caught.
    const settle = this._settleReady;
    const wasPending = settle && !this._readySettled;
    this._finish();
    // Drop the dead worker; the next task spawns a fresh one. Nothing is reused,
    // so a corrupted internal state cannot leak into the retry.
    this.terminate();
    this._status('crashed', detail);
    const err = new StudioError(ERR.WORKER_CRASH, { detail });
    if (wasPending) { this._readySettled = true; settle.rej(err); }
    if (a) a.reject(err);
  }

  _finish() {
    if (this.active && this.active.timer) clearTimeout(this.active.timer);
    this.active = null;
    this._status('idle');
    this._armIdleDisposal();
  }

  _armIdleDisposal() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (!this.active) this.terminate();
    }, IDLE_DISPOSE_MS);
  }

  /** Ensure a live worker and return its handshake. */
  async start() { return this._spawn(); }

  async capabilities() {
    await this._spawn();
    return { protocol: this.protocol, engines: this.engines };
  }

  /**
   * Run one analysis. Rejects with a StudioError; never resolves with a partial
   * result.
   * @returns {Promise<object>}
   */
  async analyze(file, options, onProgress = () => {}) {
    if (this.active) {
      throw new StudioError(ERR.INTERNAL_ERROR, { detail: 'another analysis is already running' });
    }
    await this._spawn();
    if (this._idleTimer) clearTimeout(this._idleTimer);

    const taskId = newTaskId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._handleCrash('the analysis did not report progress within the timeout');
      }, TASK_TIMEOUT_MS);
      this.active = { taskId, resolve, reject, onProgress, timer };
      this._status('running');
      try {
        // The File is passed by reference-semantics structured clone. Its bytes
        // are not copied and never leave the device.
        this.worker.postMessage({ type: REQ.ANALYZE, taskId, file, options: options || {} });
      } catch (e) {
        this._finish();
        reject(new StudioError(ERR.INTERNAL_ERROR, { detail: 'could not hand the file to the worker: ' + (e && e.message) }));
      }
    });
  }

  cancel() {
    if (!this.active || !this.worker) return false;
    this.worker.postMessage({ type: REQ.CANCEL, taskId: this.active.taskId });
    return true;
  }

  terminate() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this.active && this.active.timer) clearTimeout(this.active.timer);
    if (this.worker) { try { this.worker.terminate(); } catch { /* already gone */ } }
    this.worker = null;
    this.ready = null;
    this.protocol = null;
    this.active = null;
  }
}

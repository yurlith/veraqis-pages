// VERAQIS Studio — analysis worker (protocol v1).
//
// A task runner, not a single-purpose wrapper: it announces its protocol version
// and capabilities, accepts identified tasks, reports typed errors, and can be
// cancelled and disposed. All heavy work happens here so the UI thread stays
// responsive.
//
// The File handle arrives by structured clone. A File is a reference to bytes on
// disk, not a copy — nothing large crosses the boundary and nothing is uploaded.

import { PROTOCOL_VERSION, REQ, RES, PROGRESS_INTERVAL_MS } from './protocol.js';
import { selectEngine, listEngines } from './engine.js';
import { StudioError, ERR, toStudioError } from './errors.js';
import { detectSync } from './capabilities.js';

/** taskId -> AbortController. One task at a time is the policy; the map makes
 *  a stray CANCEL for a finished task harmless rather than a crash. */
const running = new Map();

const send = (msg) => self.postMessage(msg);

send({ type: RES.READY, protocol: PROTOCOL_VERSION, engines: listEngines() });

self.onmessage = async (ev) => {
  const msg = ev.data;
  // A worker is same-origin, but a malformed message must not throw here — that
  // would take the worker down and look like a crash.
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  const { type, taskId } = msg;

  if (type === REQ.CANCEL) {
    const c = running.get(taskId);
    if (c) c.abort();
    return;
  }

  if (type === REQ.DISPOSE) {
    for (const c of running.values()) c.abort();
    running.clear();
    send({ type: RES.DISPOSED, taskId: taskId || 'dispose' });
    return;
  }

  if (type === REQ.CAPABILITIES) {
    send({ type: RES.CAPABILITIES, taskId, protocol: PROTOCOL_VERSION, platform: detectSync(), engines: listEngines() });
    return;
  }

  if (type === REQ.INIT) {
    send({ type: RES.READY, taskId, protocol: PROTOCOL_VERSION, engines: listEngines() });
    return;
  }

  if (type === REQ.ANALYZE) {
    if (typeof taskId !== 'string' || !taskId) return;
    if (running.has(taskId)) return;                       // ignore a duplicate id
    const controller = new AbortController();
    running.set(taskId, controller);

    let lastPost = 0;
    const onProgress = (p) => {
      const now = Date.now();
      if (now - lastPost < PROGRESS_INTERVAL_MS && p.stage !== 'identify') return;
      lastPost = now;
      send({ type: RES.PROGRESS, taskId, stage: p.stage, done: p.done, total: p.total, message: p.message || null });
    };

    try {
      const file = msg.file;
      if (!file || typeof file.slice !== 'function' || typeof file.size !== 'number') {
        throw new StudioError(ERR.FILE_ACCESS, { detail: 'no readable file was provided' });
      }
      const { engine, detection } = await selectEngine(file);
      const result = await engine.analyze(file, msg.options || {}, onProgress, controller.signal);
      send({
        type: RES.RESULT, taskId,
        result: {
          ...result,
          detection,
          source: { name: file.name, size: file.size, lastModified: file.lastModified || null, type: file.type || '' },
        },
      });
    } catch (e) {
      const se = toStudioError(e);
      if (se.code === ERR.CANCELLED) send({ type: RES.CANCELLED, taskId });
      else send({ type: RES.ERROR, taskId, error: se.toJSON() });
    } finally {
      running.delete(taskId);
    }
    return;
  }

  // Declared in the protocol, not implemented in this release. Answering with a
  // typed error is better than silence — the supervisor would otherwise time out.
  if (type === REQ.VERIFY_ENTRY || type === REQ.BUILD_RECOVERY_PLAN || type === REQ.EXTRACT_ENTRY) {
    send({
      type: RES.ERROR, taskId: taskId || 'unknown',
      error: new StudioError(ERR.INTERNAL_ERROR, {
        detail: `${type} is part of protocol v${PROTOCOL_VERSION} but is not implemented in this release`,
      }).toJSON(),
    });
  }
};

// An uncaught failure inside the worker should still reach the supervisor as a
// typed error rather than a bare 'error' event with no context.
self.onerror = (e) => {
  send({
    type: RES.ERROR, taskId: 'worker',
    error: new StudioError(ERR.WORKER_CRASH, { detail: String((e && e.message) || e).slice(0, 200) }).toJSON(),
  });
};

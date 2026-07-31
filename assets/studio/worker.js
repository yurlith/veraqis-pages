// VERAQIS Studio — analysis worker (protocol v1).
//
// A task runner, not a single-purpose wrapper: it announces its protocol version
// and capabilities, accepts identified tasks, reports typed errors, and can be
// cancelled and disposed. All heavy work happens here so the UI thread stays
// responsive.
//
// The File handle arrives by structured clone. A File is a reference to bytes on
// disk, not a copy — nothing large crosses the boundary and nothing is uploaded.

import { PROTOCOL_VERSION, REQ, RES, PROGRESS_INTERVAL_MS, isValidExtractRequest } from './protocol.js';
import { selectEngine, listEngines, zipEngine } from './engine.js';
import { StudioError, ERR, toStudioError } from './errors.js';
import { detectSync } from './capabilities.js';
import { extractionPolicy } from './policy.js';

/** taskId -> AbortController. One task at a time is the policy; the map makes
 *  a stray CANCEL for a finished task harmless rather than a crash. */
const running = new Map();

/** taskId -> a produced output that has not yet been handed over. Normally
 *  empty: the result is posted and the reference dropped in the same turn. It
 *  exists so DISPOSE_OUTPUT has something real to clear if a post ever fails. */
const outputs = new Map();

const send = (msg) => self.postMessage(msg);

/**
 * The platform report the extractor is allowed to act on.
 *
 * `detectSync` reports that `DecompressionStream('deflate-raw')` constructs.
 * That is not the same as it producing correct bytes, and extraction must not
 * offer a decoder it has not seen give the right answer, so the known-answer
 * test runs once and its verdict replaces the optimistic flag. Cached: the
 * probe is 27 bytes, but running it per extraction would still be waste.
 */
let _platformProbe = null;
async function platformWithVerifiedDecoder() {
  if (_platformProbe) return _platformProbe;
  const base = detectSync();
  let verified = false;
  let reason = "DecompressionStream('deflate-raw') is unavailable";
  if (base.deflateRaw) {
    const r = await zipEngine.probeDeflateRaw();
    verified = r.ok;
    reason = r.reason || 'known-answer test passed';
  }
  _platformProbe = { ...base, deflateRawPresent: base.deflateRaw, deflateRaw: base.deflateRaw && verified, deflateRawVerified: verified, deflateRawReason: reason };
  return _platformProbe;
}

send({ type: RES.READY, protocol: PROTOCOL_VERSION, engines: listEngines() });

self.onmessage = async (ev) => {
  const msg = ev.data;
  // A worker is same-origin, but a malformed message must not throw here — that
  // would take the worker down and look like a crash.
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  const { type, taskId } = msg;

  if (type === REQ.CANCEL || type === REQ.CANCEL_TASK) {
    const c = running.get(taskId);
    if (c) c.abort();
    return;
  }

  if (type === REQ.DISPOSE_OUTPUT) {
    // The worker keeps nothing after a successful post; this is the explicit
    // contract that says so, and clears any residue if a post ever failed.
    outputs.delete(taskId);
    send({ type: RES.OUTPUT_DISPOSED, taskId: taskId || 'dispose-output' });
    return;
  }

  if (type === REQ.DISPOSE) {
    for (const c of running.values()) c.abort();
    running.clear();
    outputs.clear();
    send({ type: RES.DISPOSED, taskId: taskId || 'dispose' });
    return;
  }

  if (type === REQ.CAPABILITIES) {
    send({
      type: RES.CAPABILITIES, taskId, protocol: PROTOCOL_VERSION,
      platform: await platformWithVerifiedDecoder(), engines: listEngines(),
    });
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

  if (type === REQ.EXTRACT_VERIFIED_ENTRY) {
    if (!isValidExtractRequest(msg)) {
      send({
        type: RES.EXTRACTION_ERROR, taskId: taskId || 'unknown',
        error: new StudioError(ERR.INTERNAL_EXTRACTION_ERROR, {
          detail: 'the extraction request was malformed',
        }).toJSON(),
      });
      return;
    }
    if (running.size > 0) {
      // One task at a time. Refusing is better than queueing: a queued
      // extraction finishes against a UI that has moved on.
      send({
        type: RES.EXTRACTION_ERROR, taskId, entryId: msg.entryId,
        error: new StudioError(ERR.EXTRACTION_ALREADY_RUNNING, { entryId: msg.entryId }).toJSON(),
      });
      return;
    }

    const controller = new AbortController();
    running.set(taskId, controller);
    const entryId = msg.entryId;
    let lastPost = 0;

    try {
      const platform = await platformWithVerifiedDecoder();
      const policy = extractionPolicy({ ...platform, ...(msg.policyHints || {}) });

      const result = await zipEngine.extractVerifiedEntry(
        msg.file, entryId,
        {
          plan: msg.plan, project: msg.project, capabilities: platform, policy, taskId,
        },
        {
          onAccepted: (a) => send({
            type: RES.EXTRACTION_ACCEPTED, taskId, entryId,
            projectId: msg.projectId || null, policyVersion: policy.policyVersion,
            engineVersion: zipEngine.capabilities.extractionEngineVersion,
            ...a,
          }),
          onProgress: (p) => {
            const now = Date.now();
            // Throttled: a message per chunk costs more than the extraction and
            // floods a screen reader. Phase changes always get through.
            if (now - lastPost < PROGRESS_INTERVAL_MS && p.percent !== 0 && p.percent !== 100) return;
            lastPost = now;
            send({ type: RES.EXTRACTION_PROGRESS, taskId, entryId, projectId: msg.projectId || null, ...p });
          },
        },
        controller.signal
      );

      // The Blob is the only large thing that crosses the boundary, and a Blob
      // is a handle rather than a copy. Nothing is retained on this side.
      send({ type: RES.EXTRACTION_RESULT, taskId, entryId, projectId: msg.projectId || null, result });
      outputs.delete(taskId);
    } catch (e) {
      const se = toStudioError(e, ERR.INTERNAL_EXTRACTION_ERROR);
      outputs.delete(taskId);
      if (se.code === ERR.CANCELLED) {
        send({
          type: RES.EXTRACTION_CANCELLED, taskId, entryId,
          projectId: msg.projectId || null, outputDiscarded: true,
        });
      } else {
        send({ type: RES.EXTRACTION_ERROR, taskId, entryId, projectId: msg.projectId || null, error: se.toJSON() });
      }
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

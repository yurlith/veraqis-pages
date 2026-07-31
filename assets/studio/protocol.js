// VERAQIS Studio — worker protocol, version 1.
//
// Shared verbatim by the main thread and the worker so a mismatch is impossible
// to introduce silently. Every request carries a task id; every response echoes
// it. The worker announces its protocol version and capabilities in READY, and
// the supervisor refuses to use a worker whose version it does not understand —
// which is exactly what happens when a service worker serves a stale script.

// v2 adds single-entry verified extraction. The version is bumped rather than
// extended in place because a page that speaks v2 must not drive a v1 worker
// served from a stale cache: it would ask for an extraction and get silence.
// The supervisor refuses a version it does not understand, which turns that
// failure mode into a visible "reload" prompt.
export const PROTOCOL_VERSION = 2;

/** main thread -> worker */
export const REQ = {
  INIT: 'INIT',
  CAPABILITIES: 'CAPABILITIES',
  ANALYZE: 'ANALYZE',
  VERIFY_ENTRY: 'VERIFY_ENTRY',
  BUILD_RECOVERY_PLAN: 'BUILD_RECOVERY_PLAN',
  EXTRACT_ENTRY: 'EXTRACT_ENTRY',
  /** v2: extract exactly one entry that is already classified VERIFIED. */
  EXTRACT_VERIFIED_ENTRY: 'EXTRACT_VERIFIED_ENTRY',
  CANCEL: 'CANCEL',
  /** v2: explicit alias used by the extraction flow; same semantics as CANCEL. */
  CANCEL_TASK: 'CANCEL_TASK',
  /** v2: drop any output the worker still holds for a task. */
  DISPOSE_OUTPUT: 'DISPOSE_OUTPUT',
  DISPOSE: 'DISPOSE',
};

/** worker -> main thread */
export const RES = {
  READY: 'READY',
  CAPABILITIES: 'CAPABILITIES',
  PROGRESS: 'PROGRESS',
  RESULT: 'RESULT',
  ERROR: 'ERROR',
  CANCELLED: 'CANCELLED',
  DISPOSED: 'DISPOSED',
  /** v2 extraction responses. Separate names so an extraction reply can never be
   *  mistaken for an analysis reply by a handler that only checks the type. */
  EXTRACTION_ACCEPTED: 'EXTRACTION_ACCEPTED',
  EXTRACTION_PROGRESS: 'EXTRACTION_PROGRESS',
  EXTRACTION_RESULT: 'EXTRACTION_RESULT',
  EXTRACTION_ERROR: 'EXTRACTION_ERROR',
  EXTRACTION_CANCELLED: 'EXTRACTION_CANCELLED',
  OUTPUT_DISPOSED: 'OUTPUT_DISPOSED',
};

/** Stages reported in EXTRACTION_PROGRESS, in the order they occur. */
export const EXTRACT_PHASE = {
  ELIGIBILITY: 'eligibility',
  BINDING: 'source-binding',
  LOCAL_HEADER: 'local-header',
  READING: 'reading',
  DECOMPRESSING: 'decompressing',
  CHECKSUM: 'checksum',
  FINALIZING: 'finalizing',
};

export const EXTRACT_PHASE_LABEL = {
  [EXTRACT_PHASE.ELIGIBILITY]: 'Checking what the evidence allows',
  [EXTRACT_PHASE.BINDING]: 'Confirming this is the analysed file',
  [EXTRACT_PHASE.LOCAL_HEADER]: 'Re-reading the local file header',
  [EXTRACT_PHASE.READING]: 'Reading the entry',
  [EXTRACT_PHASE.DECOMPRESSING]: 'Decompressing',
  [EXTRACT_PHASE.CHECKSUM]: 'Recomputing the checksum',
  [EXTRACT_PHASE.FINALIZING]: 'Preparing the verified output',
};

/** Pipeline stages, reported in PROGRESS and attached to errors. */
export const STAGE = {
  IDENTIFY: 'identify',
  SIGNATURE: 'signature',
  TAIL_SCAN: 'tail-scan',
  EOCD: 'eocd',
  ZIP64: 'zip64',
  CENTRAL_DIRECTORY: 'central-directory',
  LOCAL_HEADERS: 'local-headers',
  ENTRY_BOUNDS: 'entry-bounds',
  CAPABILITY: 'capability',
  CRC: 'crc',
  OVERLAP: 'overlap',
  SECURITY: 'security',
  CLASSIFY: 'classify',
  REPORT: 'report',
  EXTRACT: 'extract',
};

export const STAGE_LABEL = {
  [STAGE.IDENTIFY]: 'Identifying the file',
  [STAGE.SIGNATURE]: 'Checking the container signature',
  [STAGE.TAIL_SCAN]: 'Reading the end of the file',
  [STAGE.EOCD]: 'Looking for the end-of-central-directory record',
  [STAGE.ZIP64]: 'Checking for ZIP64 structures',
  [STAGE.CENTRAL_DIRECTORY]: 'Reading the central directory',
  [STAGE.LOCAL_HEADERS]: 'Scanning for local file headers',
  [STAGE.ENTRY_BOUNDS]: 'Checking entry boundaries',
  [STAGE.CAPABILITY]: 'Checking which entries can be decoded',
  [STAGE.CRC]: 'Recomputing CRC-32 checksums',
  [STAGE.OVERLAP]: 'Checking for overlaps and truncation',
  [STAGE.SECURITY]: 'Checking entry names for risks',
  [STAGE.CLASSIFY]: 'Classifying recovery candidates',
  [STAGE.REPORT]: 'Building the report',
  [STAGE.EXTRACT]: 'Extracting',
};

/** Progress is throttled: a message per entry costs more than the analysis. */
export const PROGRESS_INTERVAL_MS = 80;

/** A task with no progress and no result for this long is treated as hung. */
export const TASK_TIMEOUT_MS = 300000;

/** How long an idle worker is kept alive before it is disposed. */
export const IDLE_DISPOSE_MS = 120000;

export const newTaskId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Structural validation of an inbound message. A worker is same-origin and
 * trusted, but a malformed or spoofed message must not corrupt UI state, so the
 * shape is checked before it is acted on.
 */
export function isValidResponse(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.type !== 'string' || !Object.prototype.hasOwnProperty.call(RES, m.type)) return false;
  if (m.type === RES.READY) return typeof m.protocol === 'number';
  // Every other response belongs to a task.
  if (typeof m.taskId !== 'string' || m.taskId.length === 0 || m.taskId.length >= 64) return false;
  // An extraction reply carries the id of the entry it is about. A reply that
  // does not say which entry it belongs to must not be applied to whichever
  // entry the UI happens to have selected.
  if (m.type === RES.EXTRACTION_ACCEPTED || m.type === RES.EXTRACTION_PROGRESS
      || m.type === RES.EXTRACTION_RESULT || m.type === RES.EXTRACTION_CANCELLED) {
    return typeof m.entryId === 'string' && m.entryId.length > 0 && m.entryId.length < 64;
  }
  return true;
}

/**
 * Structural validation of an EXTRACT_VERIFIED_ENTRY request, applied inside the
 * worker before anything is read. The worker trusts the *file*, not the plan:
 * every field here is re-derived from the archive bytes before it is used.
 */
export function isValidExtractRequest(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.taskId !== 'string' || !m.taskId || m.taskId.length >= 64) return false;
  if (typeof m.entryId !== 'string' || !m.entryId || m.entryId.length >= 64) return false;
  if (!m.file || typeof m.file.slice !== 'function' || typeof m.file.size !== 'number') return false;
  if (!m.plan || typeof m.plan !== 'object') return false;
  return true;
}

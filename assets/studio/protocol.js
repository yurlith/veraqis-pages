// VERAQIS Studio — worker protocol, version 1.
//
// Shared verbatim by the main thread and the worker so a mismatch is impossible
// to introduce silently. Every request carries a task id; every response echoes
// it. The worker announces its protocol version and capabilities in READY, and
// the supervisor refuses to use a worker whose version it does not understand —
// which is exactly what happens when a service worker serves a stale script.

export const PROTOCOL_VERSION = 1;

/** main thread -> worker */
export const REQ = {
  INIT: 'INIT',
  CAPABILITIES: 'CAPABILITIES',
  ANALYZE: 'ANALYZE',
  VERIFY_ENTRY: 'VERIFY_ENTRY',
  BUILD_RECOVERY_PLAN: 'BUILD_RECOVERY_PLAN',
  EXTRACT_ENTRY: 'EXTRACT_ENTRY',
  CANCEL: 'CANCEL',
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
  return typeof m.taskId === 'string' && m.taskId.length > 0 && m.taskId.length < 64;
}

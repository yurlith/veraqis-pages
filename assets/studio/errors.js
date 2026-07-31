// VERAQIS Studio — typed error model.
//
// Every failure carries a stable code, a message safe to show a user, technical
// detail for the expandable section, whether the operation can be retried, and
// the pipeline stage it failed at. A raw stack trace is never the user-facing
// message.
//
// No DOM, no network. Shared by the worker and the main thread.

export const ERR = {
  FILE_ACCESS: 'FILE_ACCESS',
  FORMAT_UNSUPPORTED: 'FORMAT_UNSUPPORTED',
  STRUCTURE_INVALID: 'STRUCTURE_INVALID',
  TRUNCATED_INPUT: 'TRUNCATED_INPUT',
  MEMORY_LIMIT: 'MEMORY_LIMIT',
  BROWSER_UNSUPPORTED: 'BROWSER_UNSUPPORTED',
  WORKER_CRASH: 'WORKER_CRASH',
  CANCELLED: 'CANCELLED',
  DECOMPRESSION_FAILED: 'DECOMPRESSION_FAILED',
  CRC_MISMATCH: 'CRC_MISMATCH',
  OUTPUT_FAILED: 'OUTPUT_FAILED',
  STORAGE_FAILED: 'STORAGE_FAILED',
  PROJECT_SCHEMA_INVALID: 'PROJECT_SCHEMA_INVALID',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

// message: shown to the user · action: what they can do next · recoverable: may retry
const CATALOG = {
  [ERR.FILE_ACCESS]: {
    message: 'The file could not be read.',
    action: 'Check the file still exists and is not open in another program, then choose it again.',
    recoverable: true,
  },
  [ERR.FORMAT_UNSUPPORTED]: {
    message: 'This file is not a format VERAQIS Studio can analyse.',
    action: 'Studio currently analyses ZIP archives and ZIP-based files such as DOCX, XLSX, JAR and APK.',
    recoverable: false,
  },
  [ERR.STRUCTURE_INVALID]: {
    message: 'The archive structure could not be interpreted.',
    action: 'The report below records what was readable. Nothing was assumed about the rest.',
    recoverable: false,
  },
  [ERR.TRUNCATED_INPUT]: {
    message: 'The file ends before the archive does.',
    action: 'If you have the original source, re-download or re-copy it and compare the file sizes.',
    recoverable: false,
  },
  [ERR.MEMORY_LIMIT]: {
    message: 'This archive is larger than this browser can safely handle in one pass.',
    action: 'Try a shallow analysis, or use a desktop tool. The file is not uploaded either way.',
    recoverable: true,
  },
  [ERR.BROWSER_UNSUPPORTED]: {
    message: 'This browser is missing a feature Studio needs.',
    action: 'A current version of Chrome, Edge, Firefox or Safari supports everything required.',
    recoverable: false,
  },
  [ERR.WORKER_CRASH]: {
    message: 'The analysis engine stopped unexpectedly.',
    action: 'Nothing was written and your file was not modified. You can run the analysis again.',
    recoverable: true,
  },
  [ERR.CANCELLED]: {
    message: 'Analysis cancelled.',
    action: 'No result was produced. You can start again at any time.',
    recoverable: true,
  },
  [ERR.DECOMPRESSION_FAILED]: {
    message: 'An entry could not be decompressed.',
    action: 'It is reported as unverified rather than assumed intact.',
    recoverable: false,
  },
  [ERR.CRC_MISMATCH]: {
    message: "An entry's checksum did not match.",
    action: 'That entry is marked damaged. Other entries are unaffected.',
    recoverable: false,
  },
  [ERR.OUTPUT_FAILED]: {
    message: 'The output could not be written.',
    action: 'Check available disk space and that the download was not blocked, then try again.',
    recoverable: true,
  },
  [ERR.STORAGE_FAILED]: {
    message: 'Local storage is unavailable or full.',
    action: 'Studio still works without it — analysis simply will not persist across a reload.',
    recoverable: true,
  },
  [ERR.PROJECT_SCHEMA_INVALID]: {
    message: 'This file is not a valid VERAQIS project.',
    action: 'Choose a file exported by Studio. Imported files are treated as untrusted and are never executed.',
    recoverable: false,
  },
  [ERR.VERSION_MISMATCH]: {
    message: 'This project was made by a different version of Studio.',
    action: 'Reload the page to pick up the current version, then open the project again.',
    recoverable: true,
  },
  [ERR.INTERNAL_ERROR]: {
    message: 'Something went wrong inside Studio.',
    action: 'Your file was not modified. Please run the analysis again.',
    recoverable: true,
  },
};

export class StudioError extends Error {
  /**
   * @param {string} code one of ERR
   * @param {{detail?:string, stage?:string, offset?:number|null, cause?:unknown}} [info]
   */
  constructor(code, info = {}) {
    const entry = CATALOG[code] || CATALOG[ERR.INTERNAL_ERROR];
    super(entry.message);
    this.name = 'StudioError';
    this.code = CATALOG[code] ? code : ERR.INTERNAL_ERROR;
    this.userMessage = entry.message;
    this.action = entry.action;
    this.recoverable = entry.recoverable;
    this.detail = info.detail ? String(info.detail).slice(0, 500) : '';
    this.stage = info.stage || null;
    this.offset = Number.isFinite(info.offset) ? info.offset : null;
    if (info.cause !== undefined) this.cause = info.cause;
  }

  /** Structured-clone-safe shape for postMessage. */
  toJSON() {
    return {
      code: this.code,
      userMessage: this.userMessage,
      action: this.action,
      recoverable: this.recoverable,
      detail: this.detail,
      stage: this.stage,
      offset: this.offset,
    };
  }
}

/** Rebuild a StudioError from the plain object that crossed a postMessage boundary. */
export function errorFromJSON(o) {
  if (!o || typeof o !== 'object') return new StudioError(ERR.INTERNAL_ERROR);
  const e = new StudioError(o.code, { detail: o.detail, stage: o.stage, offset: o.offset });
  // Trust the sender's prose only for fields the catalog also defines, so a
  // malformed message cannot inject arbitrary text into the UI.
  return e;
}

/** Map an arbitrary thrown value onto the typed model. */
export function toStudioError(e, fallback = ERR.INTERNAL_ERROR, stage = null) {
  if (e instanceof StudioError) return e;
  const name = e && e.name;
  const msg = String((e && e.message) || e || '');
  if (name === 'AbortError') return new StudioError(ERR.CANCELLED, { stage });
  if (name === 'NotReadableError' || name === 'NotFoundError' || /permission|denied/i.test(msg)) {
    return new StudioError(ERR.FILE_ACCESS, { detail: msg, stage });
  }
  if (name === 'QuotaExceededError' || /quota|storage/i.test(msg)) {
    return new StudioError(ERR.STORAGE_FAILED, { detail: msg, stage });
  }
  if (name === 'RangeError' || /out of memory|allocation/i.test(msg)) {
    return new StudioError(ERR.MEMORY_LIMIT, { detail: msg, stage });
  }
  return new StudioError(fallback, { detail: msg, stage, cause: e });
}

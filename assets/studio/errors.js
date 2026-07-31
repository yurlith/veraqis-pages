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

  /* ---- single-entry verified extraction (Phase 3) ----------------------- */
  // Eligibility refusals. Each one names the single condition that failed, so a
  // disabled control can say exactly why rather than "not available".
  ENTRY_NOT_VERIFIED: 'ENTRY_NOT_VERIFIED',
  SOURCE_FILE_MISMATCH: 'SOURCE_FILE_MISMATCH',
  EXTRACTION_UNSUPPORTED: 'EXTRACTION_UNSUPPORTED',
  COMPRESSION_METHOD_UNSUPPORTED: 'COMPRESSION_METHOD_UNSUPPORTED',
  ENCRYPTED_ENTRY_UNSUPPORTED: 'ENCRYPTED_ENTRY_UNSUPPORTED',
  OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_EXCEEDED',
  COMPRESSION_RATIO_LIMIT_EXCEEDED: 'COMPRESSION_RATIO_LIMIT_EXCEEDED',
  ENTRY_RANGE_INVALID: 'ENTRY_RANGE_INVALID',
  ENTRY_RANGE_OVERLAP: 'ENTRY_RANGE_OVERLAP',
  DATA_DESCRIPTOR_AMBIGUOUS: 'DATA_DESCRIPTOR_AMBIGUOUS',
  UNSUPPORTED_ENTRY_FLAGS: 'UNSUPPORTED_ENTRY_FLAGS',
  EXTRACTION_ALREADY_RUNNING: 'EXTRACTION_ALREADY_RUNNING',
  // Runtime failures during extraction. Every one discards the output buffer.
  DECOMPRESSION_LIMIT_EXCEEDED: 'DECOMPRESSION_LIMIT_EXCEEDED',
  OUTPUT_SIZE_MISMATCH: 'OUTPUT_SIZE_MISMATCH',
  SAFE_FILENAME_FAILED: 'SAFE_FILENAME_FAILED',
  BLOB_CREATION_FAILED: 'BLOB_CREATION_FAILED',
  DOWNLOAD_PREPARATION_FAILED: 'DOWNLOAD_PREPARATION_FAILED',
  INTERNAL_EXTRACTION_ERROR: 'INTERNAL_EXTRACTION_ERROR',
};

/** Pipeline stages an extraction failure can be attributed to. */
export const EXTRACT_STAGE = {
  ELIGIBILITY: 'eligibility',
  SOURCE_BINDING: 'source-binding',
  LOCAL_HEADER: 'local-header',
  READ: 'read',
  DECOMPRESS: 'decompress',
  CHECKSUM: 'checksum',
  FINALIZE: 'finalize',
  DOWNLOAD: 'download',
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
    action: 'Chrome, Edge and Firefox are verified in this release. Safari is expected to support the required APIs but has not yet been verified by the VERAQIS test suite.',
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

  /* ---- single-entry verified extraction --------------------------------- */

  [ERR.ENTRY_NOT_VERIFIED]: {
    message: 'This entry is not verified, so it cannot be extracted.',
    action: 'Only entries whose checksum VERAQIS recomputed and matched can be downloaded. This release does not extract structurally valid, potentially recoverable, damaged or unknown entries.',
    recoverable: false,
  },
  [ERR.SOURCE_FILE_MISMATCH]: {
    message: 'The selected file is not the file this analysis was made from.',
    action: 'Nothing was decompressed. Choose the original archive, or run a new analysis on this one — a matching name is not evidence that it is the same file.',
    recoverable: true,
  },
  [ERR.EXTRACTION_UNSUPPORTED]: {
    message: 'This browser cannot extract this entry.',
    action: 'Analysis is unaffected. The capability list on the Studio overview shows which feature is missing.',
    recoverable: false,
  },
  [ERR.COMPRESSION_METHOD_UNSUPPORTED]: {
    message: 'This entry uses a compression method VERAQIS does not decode.',
    action: 'Stored and Deflate entries can be extracted. Others are described in the report but never produced as output.',
    recoverable: false,
  },
  [ERR.ENCRYPTED_ENTRY_UNSUPPORTED]: {
    message: 'This entry is encrypted.',
    action: 'VERAQIS does not decrypt, guess, derive or request a password. The entry stays unknown.',
    recoverable: false,
  },
  [ERR.OUTPUT_LIMIT_EXCEEDED]: {
    message: 'This entry is larger than the extraction limit for this device.',
    action: 'Nothing was decompressed. The limit is set from the memory this browser reports, because the extracted bytes have to be held while their checksum is recomputed.',
    recoverable: false,
  },
  [ERR.COMPRESSION_RATIO_LIMIT_EXCEEDED]: {
    message: "This entry's declared sizes are not internally consistent.",
    action: 'It claims to expand further than DEFLATE can, which no real compressed stream does. Extraction is refused as a safety measure and cannot be overridden.',
    recoverable: false,
  },
  [ERR.ENTRY_RANGE_INVALID]: {
    message: "This entry's data does not lie inside the archive.",
    action: 'The declared range starts or ends outside the file, so there is nothing safe to read.',
    recoverable: false,
  },
  [ERR.ENTRY_RANGE_OVERLAP]: {
    message: "This entry's data overlaps another entry.",
    action: 'When two entries claim the same bytes, neither can be extracted without guessing which is right. VERAQIS does not guess.',
    recoverable: false,
  },
  [ERR.DATA_DESCRIPTOR_AMBIGUOUS]: {
    message: "This entry's size is recorded after its data, and its local header does not confirm it.",
    action: 'Without a local header that agrees, the extent of the entry is not independently established, so extraction is refused.',
    recoverable: false,
  },
  [ERR.UNSUPPORTED_ENTRY_FLAGS]: {
    message: 'This entry uses a ZIP feature VERAQIS does not extract.',
    action: 'Patched or strongly-encrypted entries are reported but never produced as output.',
    recoverable: false,
  },
  [ERR.EXTRACTION_ALREADY_RUNNING]: {
    message: 'An extraction is already running.',
    action: 'Wait for it to finish, or cancel it, then start the next one.',
    recoverable: true,
  },
  [ERR.DECOMPRESSION_LIMIT_EXCEEDED]: {
    message: 'The entry produced more data than it declared.',
    action: 'Extraction was stopped and the partial output was discarded. A stream that exceeds its own declared size is not trustworthy.',
    recoverable: false,
  },
  [ERR.OUTPUT_SIZE_MISMATCH]: {
    message: 'The extracted output is not the size the archive declares.',
    action: 'The output was discarded. VERAQIS does not offer a download whose size it cannot account for.',
    recoverable: false,
  },
  [ERR.SAFE_FILENAME_FAILED]: {
    message: 'A safe download name could not be derived for this entry.',
    action: 'The archive path could not be reduced to a filename this system accepts.',
    recoverable: false,
  },
  [ERR.BLOB_CREATION_FAILED]: {
    message: 'The verified output could not be prepared for download.',
    action: 'This usually means the browser ran out of memory for the file. The output was discarded; try a smaller entry.',
    recoverable: true,
  },
  [ERR.DOWNLOAD_PREPARATION_FAILED]: {
    message: 'The download could not be started.',
    action: 'Check that downloads are not blocked for this site, then run the extraction again.',
    recoverable: true,
  },
  [ERR.INTERNAL_EXTRACTION_ERROR]: {
    message: 'Something went wrong during extraction.',
    action: 'The output was discarded and your archive was not modified. Nothing partial is offered as a download.',
    recoverable: true,
  },
};

export class StudioError extends Error {
  /**
   * @param {string} code one of ERR
   * @param {{detail?:string, stage?:string, offset?:number|null, cause?:unknown,
   *          entryId?:string|null, outputDiscarded?:boolean}} [info]
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
    // Which entry the failure belongs to, and whether any bytes that had been
    // produced were thrown away. "Were partial bytes kept?" is the first thing a
    // reader of a failed extraction needs to know, so it is part of the error
    // rather than something the UI has to infer.
    this.entryId = typeof info.entryId === 'string' ? info.entryId.slice(0, 64) : null;
    this.outputDiscarded = info.outputDiscarded === true;
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
      entryId: this.entryId,
      outputDiscarded: this.outputDiscarded,
    };
  }
}

/** Rebuild a StudioError from the plain object that crossed a postMessage boundary. */
export function errorFromJSON(o) {
  if (!o || typeof o !== 'object') return new StudioError(ERR.INTERNAL_ERROR);
  const e = new StudioError(o.code, {
    detail: o.detail, stage: o.stage, offset: o.offset,
    entryId: o.entryId, outputDiscarded: o.outputDiscarded === true,
  });
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

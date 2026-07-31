// VERAQIS Studio — the single extraction eligibility gate.
//
// ONE function decides whether an entry may be extracted. UI handlers, the
// worker and the tests all call it; none of them re-derives the rule. If the
// answer is scattered, the answer will eventually differ between the button and
// the extractor, and the button is the one users trust.
//
// The gate is pure: metadata in, verdict out. It never reads the archive. The
// worker re-runs it against the metadata it re-derives from the real bytes, so a
// hand-edited project cannot talk its way past it — the file, not the project,
// has the last word.
//
// No DOM, no network, no storage.

import { ERR, EXTRACT_STAGE } from './errors.js';
import { DEFAULT_EXTRACTION_POLICY } from './policy.js';
import { sanitizeDownloadFilename } from './filename.js';

/** Operation status — the axis that is deliberately NOT the evidence status. */
export const OPERATION_STATUS = {
  UNAVAILABLE: 'UNAVAILABLE',       // the browser cannot do it at all
  INELIGIBLE: 'INELIGIBLE',         // this entry does not qualify
  READY: 'READY',
  EXTRACTING: 'EXTRACTING',
  CANCELLING: 'CANCELLING',
  EXTRACTED_VERIFIED: 'EXTRACTED_VERIFIED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  OUTPUT_EXPIRED: 'OUTPUT_EXPIRED',
};

/**
 * ZIP general-purpose bit flags this release refuses to extract.
 * APPNOTE 4.4.4:
 *   bit 0  traditional encryption          bit 5  compressed patched data
 *   bit 6  strong encryption               bit 13 central-directory values masked
 * Bit 3 (data descriptor) is handled separately — it is conditional, not fatal.
 */
const UNSUPPORTED_FLAG_MASK = (1 << 0) | (1 << 5) | (1 << 6) | (1 << 13);
const FLAG_DATA_DESCRIPTOR = 1 << 3;

const FLAG_NAMES = [
  [1 << 0, 'traditional encryption'],
  [1 << 5, 'compressed patched data'],
  [1 << 6, 'strong encryption'],
  [1 << 13, 'central-directory values masked'],
];

const n = (v) => (Number.isFinite(v) ? v : null);

/**
 * Decide whether one entry may be extracted.
 *
 * @param {object} project   the in-memory project (or a validated imported one)
 * @param {object} entry     one element of project.entries
 * @param {object} capabilities  result of capabilities.detect()
 * @param {object} [policy]  result of policy.extractionPolicy()
 * @param {object} [context] runtime state the project cannot know:
 *        { activeExtraction?: boolean, sourceBinding?: {match: true|'weak'|false, reason: string} }
 * @returns {{
 *   eligible: boolean, evidenceStatus: string, operationStatus: string,
 *   reasons: Array<{code:string, message:string}>,
 *   requiredCapabilities: string[], missingCapabilities: string[],
 *   warnings: string[], estimatedInputBytes: number|null,
 *   estimatedOutputBytes: number|null, compressionMethod: number|null,
 *   crcExpected: number|null, outputName: string|null, filenameModified: boolean,
 *   filenameReasons: string[], policyVersion: string, entryId: string|null,
 *   stage: string
 * }}
 */
export function evaluateExtractionEligibility(project, entry, capabilities = {}, policy = DEFAULT_EXTRACTION_POLICY, context = {}) {
  const reasons = [];
  const warnings = [];
  const missingCapabilities = [];
  const fail = (code, message) => reasons.push({ code, message });

  const evidenceStatus = entry && typeof entry.status === 'string' ? entry.status : 'UNKNOWN';
  const method = entry ? n(entry.method) : null;
  const compressedSize = entry ? n(entry.compressedSize) : null;
  const uncompressedSize = entry ? n(entry.uncompressedSize) : null;
  const flags = entry && Number.isFinite(entry.flags) ? entry.flags : 0;

  // Which capabilities this particular entry needs. Stored needs no decoder;
  // Deflate needs the browser's raw-DEFLATE stream and nothing else — no
  // library is loaded, from anywhere.
  const requiredCapabilities = ['worker', 'blobSlice'];
  if (method === 8) requiredCapabilities.push('deflateRaw');

  const base = {
    evidenceStatus,
    requiredCapabilities,
    compressionMethod: method,
    estimatedInputBytes: compressedSize,
    estimatedOutputBytes: uncompressedSize,
    crcExpected: entry ? n(entry.declaredCrc32) : null,
    policyVersion: policy.policyVersion,
    entryId: entry && typeof entry.entryId === 'string' ? entry.entryId : null,
    stage: EXTRACT_STAGE.ELIGIBILITY,
  };

  if (!project || !entry) {
    fail(ERR.INTERNAL_EXTRACTION_ERROR, 'No entry was supplied.');
    return finish(false, OPERATION_STATUS.INELIGIBLE);
  }

  /* --- 17. browser capability (checked first: it governs the whole control) */
  for (const c of requiredCapabilities) {
    if (!capabilities[c]) missingCapabilities.push(c);
  }
  if (missingCapabilities.length) {
    fail(
      method === 8 && missingCapabilities.includes('deflateRaw')
        ? ERR.EXTRACTION_UNSUPPORTED : ERR.EXTRACTION_UNSUPPORTED,
      missingCapabilities.includes('deflateRaw')
        ? "This browser has no DecompressionStream('deflate-raw'), so compressed entries cannot be decoded here. Stored entries are unaffected, and analysis still works."
        : `This browser is missing: ${missingCapabilities.join(', ')}.`
    );
    return finish(false, OPERATION_STATUS.UNAVAILABLE);
  }

  /* --- 1. evidence status ------------------------------------------------ */
  if (evidenceStatus !== policy.requiredEvidenceStatus) {
    fail(ERR.ENTRY_NOT_VERIFIED,
      `This entry is ${labelOf(evidenceStatus)}. Only VERIFIED entries are extracted in this release.`);
  }

  /* --- 16. the VERIFIED label must be backed by its own CRC record -------- */
  // The same rule the project importer enforces. A project file is JSON and
  // anyone can edit one; "status: VERIFIED" is the field an attacker would set.
  if (evidenceStatus === 'VERIFIED' && !(entry.crcChecked === true && entry.crcOk === true)) {
    fail(ERR.ENTRY_NOT_VERIFIED,
      'This entry claims to be verified but carries no record of a recomputed, matching checksum.');
  }

  /* --- 4. stable identity ------------------------------------------------- */
  if (!base.entryId) {
    fail(ERR.INTERNAL_EXTRACTION_ERROR, 'This entry has no stable identifier.');
  } else {
    const matches = (project.entries || []).filter((e) => e && e.entryId === base.entryId);
    /* --- 2. the entry belongs to this project ---------------------------- */
    if (matches.length === 0) {
      fail(ERR.INTERNAL_EXTRACTION_ERROR, 'This entry does not belong to the open project.');
    } else if (matches.length > 1) {
      fail(ERR.INTERNAL_EXTRACTION_ERROR, 'Two entries share one identifier; neither can be addressed unambiguously.');
    }
  }

  /* --- 3. the selected file is the analysed file -------------------------- */
  const binding = context.sourceBinding;
  if (binding && binding.match !== true) {
    fail(ERR.SOURCE_FILE_MISMATCH, binding.reason || 'The selected file does not match this project.');
  }
  const fp = project.source && project.source.fingerprint;
  const hasContentHash = !!(fp && (fp.sha256 || (fp.headSha256 && fp.tailSha256)));
  if (policy.requireContentFingerprint && !hasContentHash) {
    fail(ERR.SOURCE_FILE_MISMATCH,
      'This project has no content fingerprint of its source file, so the file cannot be re-identified by anything except its name — and a name is not evidence. Re-analyse with the fingerprint setting on Fast or Full.');
  }

  /* --- 11. encryption ----------------------------------------------------- */
  if (entry.encrypted === true || (flags & ((1 << 0) | (1 << 6))) !== 0) {
    fail(ERR.ENCRYPTED_ENTRY_UNSUPPORTED,
      'This entry is encrypted. VERAQIS never guesses, derives or requests a password.');
  }

  /* --- 12. unsupported general-purpose flags ------------------------------ */
  const badFlags = flags & UNSUPPORTED_FLAG_MASK & ~((1 << 0) | (1 << 6));
  if (badFlags !== 0) {
    const names = FLAG_NAMES.filter(([bit]) => (badFlags & bit) !== 0).map(([, name]) => name);
    fail(ERR.UNSUPPORTED_ENTRY_FLAGS, `This entry sets: ${names.join(', ')}.`);
  }

  /* --- 10. compression method --------------------------------------------- */
  if (method === null || !policy.supportedMethods.includes(method)) {
    fail(ERR.COMPRESSION_METHOD_UNSUPPORTED,
      `Compression method ${method === null ? 'unknown' : method}${entry.methodName ? ` (${entry.methodName})` : ''} is not decoded by VERAQIS.`);
  }

  /* --- 5. a validated local header exists --------------------------------- */
  if (!Number.isFinite(entry.localHeaderOffset) || !Number.isFinite(entry.dataOffset)) {
    fail(ERR.ENTRY_RANGE_INVALID,
      'No local file header was located for this entry, so where its data begins is not established.');
  }

  /* --- 8 + 9. sizes ------------------------------------------------------- */
  if (compressedSize === null || compressedSize < 0) {
    fail(ERR.ENTRY_RANGE_INVALID, 'The compressed size of this entry is not known.');
  }
  if (uncompressedSize === null || uncompressedSize < 0) {
    fail(ERR.ENTRY_RANGE_INVALID, 'The uncompressed size of this entry is not known.');
  }
  // Stored means "not compressed", so the two sizes are the same number
  // (APPNOTE 4.4.8/4.4.9). An entry that declares otherwise has two records
  // disagreeing about its own length, and neither can be preferred.
  if (method === 0 && compressedSize !== null && uncompressedSize !== null
      && compressedSize !== uncompressedSize) {
    fail(ERR.ENTRY_RANGE_INVALID,
      `This entry is stored uncompressed but declares ${compressedSize} compressed and ${uncompressedSize} uncompressed bytes. Those cannot both be true.`);
  }
  if (uncompressedSize !== null && uncompressedSize > policy.maxOutputBytes) {
    fail(ERR.OUTPUT_LIMIT_EXCEEDED,
      `This entry declares ${uncompressedSize} bytes, above the ${policy.maxOutputBytes}-byte extraction limit for this device (${policy.basis}).`);
  }
  if (compressedSize !== null && compressedSize > policy.maxCompressedBytesRead) {
    fail(ERR.OUTPUT_LIMIT_EXCEEDED,
      `This entry would need ${compressedSize} bytes of the archive to be read, above this device's limit.`);
  }

  /* --- 19. compression ratio ---------------------------------------------- */
  if (compressedSize !== null && uncompressedSize !== null && compressedSize > 0) {
    const ratio = uncompressedSize / compressedSize;
    if (ratio > policy.maxCompressionRatio) {
      fail(ERR.COMPRESSION_RATIO_LIMIT_EXCEEDED,
        `The declared sizes imply ${ratio.toFixed(0)}:1 expansion. DEFLATE cannot exceed ${policy.maxCompressionRatio}:1, so these sizes contradict each other.`);
    }
  } else if (compressedSize === 0 && uncompressedSize !== null && uncompressedSize > 0) {
    fail(ERR.COMPRESSION_RATIO_LIMIT_EXCEEDED,
      'This entry declares zero compressed bytes but a non-zero size.');
  }

  /* --- 6. the data range lies inside the archive --------------------------- */
  const sourceSize = project.source ? n(project.source.size) : null;
  if (Number.isFinite(entry.dataOffset) && compressedSize !== null && sourceSize !== null) {
    if (entry.dataOffset < 0 || entry.dataOffset + compressedSize > sourceSize) {
      fail(ERR.ENTRY_RANGE_INVALID,
        `The data range ${entry.dataOffset}–${entry.dataOffset + compressedSize} is not inside the ${sourceSize}-byte archive.`);
    }
  }

  /* --- 13. truncation ------------------------------------------------------ */
  if (Array.isArray(entry.reasons) && entry.reasons.some((r) => /truncated|past the end of the file/i.test(String(r)))) {
    fail(ERR.ENTRY_RANGE_INVALID, 'This entry was reported as truncated during analysis.');
  }

  /* --- 7. overlap with another entry or a structural record ---------------- */
  const overlap = findOverlap(project, entry);
  if (overlap) {
    fail(ERR.ENTRY_RANGE_OVERLAP,
      `This entry's bytes overlap "${overlap}". When two records claim the same bytes, neither is unambiguous.`);
  }

  /* --- 14. data descriptor -------------------------------------------------- */
  if ((flags & FLAG_DATA_DESCRIPTOR) !== 0) {
    // Bit 3 means the local header's crc/size fields may be zero by specification.
    // Extraction depends on the local header independently confirming the range,
    // so the flag is tolerated only when the local header carries real values.
    // The worker re-reads those fields from the file and enforces this again;
    // here we can only warn, because the project holds the central-directory view.
    if (entry.source === 'local-header-scan') {
      fail(ERR.DATA_DESCRIPTOR_AMBIGUOUS,
        'This entry was found by scanning and records its size after the data, so its extent is not established from the header alone.');
    } else {
      warnings.push('This entry records its size in a data descriptor. Extraction will proceed only if its local header still carries matching values.');
    }
  }

  /* --- 20. one extraction at a time ---------------------------------------- */
  if (context.activeExtraction) {
    fail(ERR.EXTRACTION_ALREADY_RUNNING, 'Another extraction is already running.');
  }

  /* --- 18. a safe output name can be derived -------------------------------- */
  const safe = sanitizeDownloadFilename(entry.name || '', policy);
  if (!safe.ok || !safe.filename) {
    fail(ERR.SAFE_FILENAME_FAILED, 'No download name could be derived from this entry name.');
  }
  base.outputName = safe.filename;
  base.filenameModified = safe.modified;
  base.filenameReasons = safe.reasons;

  /* --- advisory ------------------------------------------------------------- */
  if (uncompressedSize !== null && uncompressedSize > policy.largeOutputWarnBytes) {
    warnings.push(`This entry is large (${uncompressedSize} bytes). Extraction holds it in memory while its checksum is recomputed.`);
  }
  if (safe.modified) {
    warnings.push(`The download will be named "${safe.filename}", not the archive path "${entry.name}".`);
  }

  return finish(reasons.length === 0, reasons.length === 0 ? OPERATION_STATUS.READY : OPERATION_STATUS.INELIGIBLE);

  function finish(eligible, operationStatus) {
    return {
      eligible,
      operationStatus,
      reasons,
      warnings,
      missingCapabilities,
      outputName: base.outputName || null,
      filenameModified: base.filenameModified === true,
      filenameReasons: base.filenameReasons || [],
      ...base,
    };
  }
}

/** Human label for a status, used only inside refusal text. */
function labelOf(s) {
  return ({
    VERIFIED: 'verified',
    STRUCTURALLY_VALID: 'structurally valid, but its contents are unproven',
    POTENTIALLY_RECOVERABLE: 'potentially recoverable, but its contents are unproven',
    DAMAGED: 'damaged',
    UNKNOWN: 'unknown',
  })[s] || String(s).toLowerCase();
}

/**
 * Does this entry's byte range collide with another entry's?
 * Returns the other entry's name, or null.
 *
 * Two records claiming the same bytes is not a corner case — it is how a crafted
 * archive gets one entry's checksum to vouch for another entry's data.
 */
function findOverlap(project, entry) {
  if (!Number.isFinite(entry.dataOffset) || !Number.isFinite(entry.compressedSize)) return null;
  const s = entry.dataOffset;
  const e = s + entry.compressedSize;
  if (e <= s) return null;                     // zero-length range cannot overlap
  for (const other of project.entries || []) {
    if (!other || other === entry) continue;
    if (other.entryId && entry.entryId && other.entryId === entry.entryId) continue;
    if (!Number.isFinite(other.dataOffset) || !Number.isFinite(other.compressedSize)) continue;
    const os = other.dataOffset;
    const oe = os + other.compressedSize;
    if (oe <= os) continue;
    if (s < oe && os < e) return other.name || '(unnamed entry)';
  }
  // The entry's own local header must not sit inside its data, and its data must
  // not run into another entry's header.
  for (const other of project.entries || []) {
    if (!other || other === entry) continue;
    if (!Number.isFinite(other.localHeaderOffset)) continue;
    if (other.localHeaderOffset >= s && other.localHeaderOffset < e) {
      return `${other.name || '(unnamed entry)'} (its local header lies inside this entry's data)`;
    }
  }
  return null;
}

// VERAQIS Studio — the local project model.
//
// A project is metadata and findings. It never contains archive bytes,
// decompressed content, recovered content, passwords or full device paths — a
// test asserts this on every run.
//
// An imported project is untrusted input: validated against the schema, coerced
// to known types, length-capped, and never executed or inserted as markup.

import { StudioError, ERR } from './errors.js';

export const PROJECT_SCHEMA = 'veraqis-project/2';
export const PROJECT_SCHEMA_VERSION = 2;
export const STUDIO_VERSION = '1.1.0';

// Version 1 projects still import. The only differences are additive — per-entry
// `entryId` and `flags`, and the `operations` ledger — so a v1 file is migrated
// rather than refused. A project exported before extraction existed describes an
// analysis that is still perfectly valid.
export const ACCEPTED_SCHEMAS = new Set(['veraqis-project/1', 'veraqis-project/2']);

/** Operation status — deliberately separate from the evidence status. An entry
 *  that was extracted does not thereby become VERIFIED, and an entry that failed
 *  to extract does not thereby stop being VERIFIED. */
export const OP_STATUS = {
  NOT_SELECTED: 'NOT_SELECTED',
  READY: 'READY',
  EXTRACTING: 'EXTRACTING',
  CANCELLING: 'CANCELLING',
  EXTRACTED_VERIFIED: 'EXTRACTED_VERIFIED',
  EXTRACTED_UNVERIFIED: 'EXTRACTED_UNVERIFIED',
  SKIPPED: 'SKIPPED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  OUTPUT_EXPIRED: 'OUTPUT_EXPIRED',
};

/** The only operation type this release records. */
export const OPERATION_TYPE = { EXTRACT_VERIFIED_ENTRY: 'EXTRACT_VERIFIED_ENTRY' };

/** How many operation records a project keeps. Older ones are dropped, oldest
 *  first: an operation ledger is a convenience, not an audit log, and it must
 *  not be able to grow a project without bound. */
export const MAX_OPERATIONS = 200;

const CAPS = { STR: 2000, NAME: 1024, ARR: 200000, NOTE: 10000 };

const str = (v, cap = CAPS.STR) => (typeof v === 'string' ? v.slice(0, cap) : '');
const num = (v) => (Number.isFinite(v) ? v : null);
const bool = (v) => v === true;
const arr = (v) => (Array.isArray(v) ? v.slice(0, CAPS.ARR) : []);

export const newProjectId = () =>
  `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/* ------------------------------------------------------------- fingerprints */

/**
 * Identify a source file well enough to detect that the user re-selected a
 * different file, without hashing gigabytes by default.
 * mode: 'none' | 'fast' | 'full'
 */
export async function fingerprintFile(file, mode = 'fast') {
  const base = {
    mode,
    size: file.size,
    lastModified: file.lastModified || null,
    // The name is kept because the user chose this file and needs to recognise
    // it. No directory path is available from a file input, and none is stored.
    name: str(file.name, CAPS.NAME),
  };
  if (mode === 'none') return base;
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return { ...base, mode: 'none', note: 'Web Crypto unavailable' };

  const sha = async (blob) => {
    const d = await subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  try {
    if (mode === 'full') return { ...base, sha256: await sha(file) };
    const CHUNK = 65536;
    const head = await sha(file.slice(0, Math.min(CHUNK, file.size)));
    const tail = file.size > CHUNK ? await sha(file.slice(Math.max(0, file.size - CHUNK))) : head;
    return { ...base, headSha256: head, tailSha256: tail };
  } catch {
    return { ...base, mode: 'none', note: 'fingerprint could not be computed' };
  }
}

/** Does this file look like the one the project was built from? Metadata only —
 *  cheap, synchronous, and NOT sufficient to authorise extraction. */
export function fingerprintMatches(fp, file) {
  if (!fp) return { match: false, reason: 'the project has no source fingerprint' };
  if (fp.size !== file.size) {
    return { match: false, reason: `size differs: project ${fp.size} B, this file ${file.size} B` };
  }
  if (fp.lastModified && file.lastModified && fp.lastModified !== file.lastModified) {
    return { match: 'weak', reason: 'the size matches but the modification time differs' };
  }
  return { match: true, reason: 'size and modification time match' };
}

/**
 * The binding check extraction actually uses: re-read the file's content and
 * compare it against the hashes recorded at analysis time.
 *
 * A matching name and size is not evidence — two builds of the same installer
 * are the same size, and a user with two downloads of one archive has two files
 * with one name. So this recomputes the first and last 64 KiB (or the whole file
 * when the project holds a full SHA-256) and refuses on any difference.
 *
 * No new full-file hash is computed unless the project already carries one:
 * re-hashing a gigabyte before every download would be a cost with no extra
 * evidence, because head+tail already fails on any edit that changes either end
 * and on any change of length.
 *
 * @returns {Promise<{match:true|'weak'|false, reason:string, checks:string[]}>}
 */
export async function verifySourceBinding(fp, file) {
  const checks = [];
  if (!fp) return { match: false, reason: 'this project has no source fingerprint, so the file cannot be re-identified', checks };
  if (!file || typeof file.slice !== 'function') {
    return { match: false, reason: 'no file was supplied', checks };
  }

  if (fp.size !== file.size) {
    return { match: false, reason: `size differs: the project recorded ${fp.size} bytes, this file is ${file.size}`, checks };
  }
  checks.push('size');

  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  const sha = async (blob) => {
    const d = await subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const hasContent = !!(fp.sha256 || (fp.headSha256 && fp.tailSha256));
  if (!hasContent) {
    // Size and name alone. Explicitly reported as weak so a caller cannot mistake
    // it for a match; the extraction policy refuses to act on it.
    return {
      match: 'weak',
      reason: 'this project recorded no content fingerprint, only a size and a name',
      checks,
    };
  }
  if (!subtle) {
    return { match: false, reason: 'the Web Crypto API is unavailable, so the file cannot be re-identified by content', checks };
  }

  try {
    if (fp.sha256) {
      const full = await sha(file);
      checks.push('sha256');
      if (full !== fp.sha256) {
        return { match: false, reason: 'the file contents differ from the analysed file (SHA-256 mismatch)', checks };
      }
      return { match: true, reason: 'size and full SHA-256 match the analysed file', checks };
    }

    const CHUNK = 65536;
    const head = await sha(file.slice(0, Math.min(CHUNK, file.size)));
    checks.push('head-sha256');
    if (head !== fp.headSha256) {
      return { match: false, reason: 'the first 64 KiB differ from the analysed file', checks };
    }
    const tail = file.size > CHUNK ? await sha(file.slice(Math.max(0, file.size - CHUNK))) : head;
    checks.push('tail-sha256');
    if (tail !== fp.tailSha256) {
      return { match: false, reason: 'the last 64 KiB differ from the analysed file', checks };
    }
    return { match: true, reason: 'size, first 64 KiB and last 64 KiB match the analysed file', checks };
  } catch (e) {
    return { match: false, reason: `the file could not be re-read to confirm it: ${String(e && e.message).slice(0, 120)}`, checks };
  }
}

/* ---------------------------------------------------------------- construction */

export function createProject({ file, fingerprint, engineResult, settings }) {
  const a = (engineResult && engineResult.analysis) || {};
  return {
    schema: PROJECT_SCHEMA,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    generator: 'VERAQIS Studio',
    generatorVersion: STUDIO_VERSION,
    id: newProjectId(),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),

    source: {
      name: str(file.name, CAPS.NAME),
      size: file.size,
      lastModified: file.lastModified || null,
      type: str(file.type, 200),
      fingerprint: fingerprint || null,
    },

    analysis: {
      timestamp: new Date().toISOString(),
      engine: engineResult.engine,
      parserVersion: engineResult.engine ? engineResult.engine.version : null,
      format: engineResult.format,
      detection: engineResult.detection || null,
      verdict: a.verdict || null,
      counts: a.counts || null,
      crcCoverage: num(a.crcCoverage),
      recoverableBytes: num(a.recoverableBytes),
      elapsedMs: num(a.elapsedMs),
      eocd: a.eocd || null,
      zip64: a.zip64 || null,
      centralDirectory: a.centralDirectory || null,
      localHeaderScan: a.localHeaderScan || null,
      nestedArchives: engineResult.nestedArchives || [],
    },

    entries: (a.entries || []).map((e, i) => ({
      // Stable identity. The engine supplies one; the fallback keeps older
      // engine results addressable rather than silently unextractable.
      entryId: str(e.entryId, 64) || `e${i}-${num(e.localHeaderOffset) ?? 'x'}`,
      name: str(e.name, CAPS.NAME),
      method: num(e.method),
      flags: num(e.flags),
      methodName: str(e.methodName, 64),
      compressedSize: num(e.compressedSize),
      uncompressedSize: num(e.uncompressedSize),
      localHeaderOffset: num(e.localHeaderOffset),
      dataOffset: num(e.dataOffset),
      declaredCrc32: num(e.declaredCrc32),
      crcChecked: bool(e.crcChecked),
      crcOk: bool(e.crcOk),
      crcReason: str(e.crcReason, 300),
      status: str(e.status, 40),                 // evidence status
      operationStatus: OP_STATUS.NOT_SELECTED,   // separate axis, never merged
      encrypted: bool(e.encrypted),
      hasDataDescriptor: bool(e.hasDataDescriptor),
      source: str(e.source, 40),
      nameFlags: arr(e.nameFlags).map((f) => str(f, 100)),
      reasons: arr(e.reasons).map((r) => str(r, 300)),
    })),

    warnings: arr(a.warnings).map((w) => str(w, 500)),
    limitations: arr(a.limitations).map((l) => str(l, 500)),
    recoveryPlan: null,          // Phase 4
    exportedArtifacts: [],       // retained for v1 compatibility; superseded by operations
    // The extraction ledger. Metadata only: what was attempted, whether the
    // output re-verified, and under which engine and policy. Never any bytes.
    operations: [],
    notes: '',
    settingsSnapshot: settings || null,
  };
}

/* ------------------------------------------------- extraction operations */

/**
 * Build one operation record from an extraction outcome.
 *
 * Deliberately explicit about what is NOT here: no output bytes, no Blob URL, no
 * archive bytes, no decompressed content, no filesystem path. A test asserts
 * their absence on every run, because "the report is metadata" is the kind of
 * property that decays one convenient field at a time.
 */
export function makeExtractionOperation(o = {}) {
  return {
    operationId: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    operationType: OPERATION_TYPE.EXTRACT_VERIFIED_ENTRY,
    entryId: str(o.entryId, 64),
    entryName: str(o.entryName, CAPS.NAME),
    evidenceStatusAtStart: str(o.evidenceStatusAtStart, 40),
    operationStatus: OP_STATUS[str(o.operationStatus, 40)] || OP_STATUS.FAILED,
    startedAt: str(o.startedAt, 40),
    finishedAt: str(o.finishedAt, 40),
    engineVersion: str(o.engineVersion, 40),
    policyVersion: str(o.policyVersion, 60),
    sourceFingerprintMatch: str(o.sourceFingerprintMatch, 20),
    compressionMethod: num(o.compressionMethod),
    expectedSize: num(o.expectedSize),
    actualSize: num(o.actualSize),
    crcExpected: num(o.crcExpected),
    crcActual: num(o.crcActual),
    crcMatch: bool(o.crcMatch),
    outputFilename: str(o.outputFilename, 300),
    filenameModified: bool(o.filenameModified),
    durationMs: num(o.durationMs),
    warnings: arr(o.warnings).map((w) => str(w, 300)),
    errorCode: str(o.errorCode, 60),
  };
}

/** Append an operation record, oldest-first eviction at the cap. */
export function recordOperation(project, op) {
  if (!project) return project;
  if (!Array.isArray(project.operations)) project.operations = [];
  project.operations.push(makeExtractionOperation(op));
  if (project.operations.length > MAX_OPERATIONS) {
    project.operations.splice(0, project.operations.length - MAX_OPERATIONS);
  }
  project.updated = new Date().toISOString();
  return project;
}

/* ------------------------------------------------------------------ validation */

/**
 * Validate an imported project. Returns { ok, project, errors, unknownFields }.
 * Unknown fields are tolerated (forward compatibility) but reported and dropped.
 */
export function validateProject(input) {
  const errors = [];
  const unknownFields = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, project: null, errors: ['the file does not contain a JSON object'], unknownFields };
  }
  if (!ACCEPTED_SCHEMAS.has(input.schema)) {
    errors.push(`schema is "${str(input.schema, 60)}", expected one of ${[...ACCEPTED_SCHEMAS].join(', ')}`);
  }
  const v = Number(input.schemaVersion);
  if (!Number.isFinite(v)) errors.push('schemaVersion is missing or not a number');
  else if (v > PROJECT_SCHEMA_VERSION) {
    errors.push(`schemaVersion ${v} is newer than this build understands (${PROJECT_SCHEMA_VERSION})`);
  }
  if (!input.source || typeof input.source !== 'object') errors.push('source metadata is missing');
  if (!input.analysis || typeof input.analysis !== 'object') errors.push('analysis is missing');
  if (!Array.isArray(input.entries)) errors.push('entries is not an array');

  // Refuse anything that smells like archive content having been embedded.
  const raw = JSON.stringify(input);
  if (/"(bytes|rawBytes|content|data)"\s*:\s*"[A-Za-z0-9+/]{200,}/.test(raw)) {
    errors.push('the file appears to embed file content, which a VERAQIS project never contains');
  }
  if (errors.length) return { ok: false, project: null, errors, unknownFields };

  const KNOWN = new Set(['schema', 'schemaVersion', 'generator', 'generatorVersion', 'id', 'created',
    'updated', 'source', 'analysis', 'entries', 'warnings', 'limitations', 'recoveryPlan',
    'exportedArtifacts', 'operations', 'notes', 'settingsSnapshot', 'imported']);
  for (const k of Object.keys(input)) if (!KNOWN.has(k)) unknownFields.push(k);

  // Rebuild from scratch: nothing from the file is carried through unchecked.
  const project = {
    schema: PROJECT_SCHEMA,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    generator: str(input.generator, 100) || 'unknown',
    generatorVersion: str(input.generatorVersion, 40) || 'unknown',
    id: str(input.id, 64) || newProjectId(),
    created: str(input.created, 40),
    updated: str(input.updated, 40),
    imported: true,
    source: {
      name: str(input.source.name, CAPS.NAME),
      size: num(input.source.size),
      lastModified: num(input.source.lastModified),
      type: str(input.source.type, 200),
      fingerprint: input.source.fingerprint && typeof input.source.fingerprint === 'object'
        ? {
          mode: str(input.source.fingerprint.mode, 20),
          size: num(input.source.fingerprint.size),
          lastModified: num(input.source.fingerprint.lastModified),
          name: str(input.source.fingerprint.name, CAPS.NAME),
          sha256: str(input.source.fingerprint.sha256, 64),
          headSha256: str(input.source.fingerprint.headSha256, 64),
          tailSha256: str(input.source.fingerprint.tailSha256, 64),
        }
        : null,
    },
    analysis: {
      timestamp: str(input.analysis.timestamp, 40),
      engine: input.analysis.engine && typeof input.analysis.engine === 'object'
        ? { id: str(input.analysis.engine.id, 40), version: str(input.analysis.engine.version, 40), kind: str(input.analysis.engine.kind, 40) }
        : null,
      parserVersion: str(input.analysis.parserVersion, 40),
      format: input.analysis.format && typeof input.analysis.format === 'object'
        ? { id: str(input.analysis.format.id, 40), label: str(input.analysis.format.label, 120), evidence: str(input.analysis.format.evidence, 300), container: str(input.analysis.format.container, 40) }
        : null,
      detection: null,
      verdict: str(input.analysis.verdict, 60),
      counts: sanitizeCounts(input.analysis.counts),
      crcCoverage: num(input.analysis.crcCoverage),
      recoverableBytes: num(input.analysis.recoverableBytes),
      elapsedMs: num(input.analysis.elapsedMs),
      eocd: sanitizePlain(input.analysis.eocd),
      zip64: sanitizePlain(input.analysis.zip64),
      centralDirectory: sanitizePlain(input.analysis.centralDirectory),
      localHeaderScan: sanitizePlain(input.analysis.localHeaderScan),
      nestedArchives: arr(input.analysis.nestedArchives).map((n) => ({
        name: str(n && n.name, CAPS.NAME), size: num(n && n.size), status: str(n && n.status, 40),
      })),
    },
    entries: arr(input.entries).map((e, i) => ({
      // A v1 project has no entryId. Synthesising one from the position and the
      // recorded header offset is a migration, not an invention: it restores the
      // same value this build would have written for the same analysis.
      entryId: str(e && e.entryId, 64) || `e${i}-${num(e && e.localHeaderOffset) ?? 'x'}`,
      name: str(e && e.name, CAPS.NAME),
      method: num(e && e.method),
      flags: num(e && e.flags),
      methodName: str(e && e.methodName, 64),
      compressedSize: num(e && e.compressedSize),
      uncompressedSize: num(e && e.uncompressedSize),
      localHeaderOffset: num(e && e.localHeaderOffset),
      dataOffset: num(e && e.dataOffset),
      declaredCrc32: num(e && e.declaredCrc32),
      crcChecked: bool(e && e.crcChecked),
      crcOk: bool(e && e.crcOk),
      crcReason: str(e && e.crcReason, 300),
      status: str(e && e.status, 40),
      operationStatus: OP_STATUS[str(e && e.operationStatus, 40)] || OP_STATUS.NOT_SELECTED,
      encrypted: bool(e && e.encrypted),
      hasDataDescriptor: bool(e && e.hasDataDescriptor),
      source: str(e && e.source, 40),
      nameFlags: arr(e && e.nameFlags).map((f) => str(f, 100)),
      reasons: arr(e && e.reasons).map((r) => str(r, 300)),
    })),
    warnings: arr(input.warnings).map((w) => str(w, 500)),
    limitations: arr(input.limitations).map((l) => str(l, 500)),
    recoveryPlan: null,
    exportedArtifacts: [],
    // Operation records are rebuilt field by field like everything else. An
    // imported operation is a claim about something that happened elsewhere: it
    // is displayed as history and never grants a permission.
    operations: arr(input.operations).slice(0, MAX_OPERATIONS).map((o) => makeExtractionOperation(o || {})),
    notes: str(input.notes, CAPS.NOTE),
    settingsSnapshot: sanitizePlain(input.settingsSnapshot),
  };

  // An imported entry may never claim VERIFIED unless its own record shows a
  // matching recomputed CRC. This is the one rule an attacker would most want
  // to subvert by hand-editing a project file.
  for (const e of project.entries) {
    if (e.status === 'VERIFIED' && !(e.crcChecked && e.crcOk)) {
      e.status = 'UNKNOWN';
      e.reasons.push('Downgraded on import: the project claimed VERIFIED without a matching recomputed CRC.');
    }
    // No imported project may arrive with an entry already in an extraction
    // state. Output bytes are never persisted, so a stored "ready to download"
    // could only ever be stale — and a stale enabled download button is exactly
    // the defect §17 forbids.
    e.operationStatus = OP_STATUS.NOT_SELECTED;
  }

  // The same rule, one level up: an operation record may not claim the output
  // re-verified unless its own CRC fields say so. A ledger entry is a claim
  // about the past; it is displayed, never trusted.
  for (const op of project.operations) {
    if (op.operationStatus === OP_STATUS.EXTRACTED_VERIFIED && !(op.crcMatch && op.crcExpected === op.crcActual)) {
      op.operationStatus = OP_STATUS.FAILED;
      op.errorCode = 'CRC_MISMATCH';
      op.warnings = [...op.warnings, 'Downgraded on import: this record claimed a verified extraction without matching checksums.'];
    }
  }

  return { ok: true, project, errors: [], unknownFields };
}

function sanitizeCounts(c) {
  if (!c || typeof c !== 'object') return null;
  const keys = ['total', 'verified', 'structurallyValid', 'potentiallyRecoverable', 'damaged', 'unknown'];
  const out = {};
  for (const k of keys) out[k] = num(c[k]) ?? 0;
  return out;
}

/** Shallow copy of a plain object with primitive values only, depth 2. */
function sanitizePlain(o, depth = 2) {
  if (o === null || o === undefined) return null;
  if (typeof o !== 'object' || Array.isArray(o)) {
    return typeof o === 'string' ? str(o) : (typeof o === 'number' || typeof o === 'boolean') ? o : null;
  }
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (n++ > 60) break;
    const key = str(k, 80);
    if (v === null) out[key] = null;
    else if (typeof v === 'string') out[key] = str(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else if (Array.isArray(v)) out[key] = v.slice(0, 200).map((x) => (typeof x === 'string' ? str(x) : (typeof x === 'number' || typeof x === 'boolean') ? x : null));
    else if (depth > 0) out[key] = sanitizePlain(v, depth - 1);
  }
  return out;
}

/* --------------------------------------------------------------------- export */

/** Deterministic serialisation: keys sorted so two exports of one project are
 *  byte-identical and diffable. */
export function serializeProject(project) {
  return JSON.stringify(sortKeys(project), null, 2);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function projectFileName(project) {
  const base = (project.source && project.source.name ? project.source.name : 'project')
    .replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return `${base}.veraqis-project.json`;
}

export async function parseProjectFile(file) {
  let text;
  try {
    if (file.size > 64 * 1024 * 1024) {
      throw new StudioError(ERR.PROJECT_SCHEMA_INVALID, { detail: 'project files are metadata; 64 MB is far beyond any legitimate one' });
    }
    text = await file.text();
  } catch (e) {
    if (e instanceof StudioError) throw e;
    throw new StudioError(ERR.FILE_ACCESS, { detail: String(e && e.message) });
  }
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new StudioError(ERR.PROJECT_SCHEMA_INVALID, { detail: 'not valid JSON: ' + String(e && e.message).slice(0, 120) }); }
  const v = validateProject(json);
  if (!v.ok) throw new StudioError(ERR.PROJECT_SCHEMA_INVALID, { detail: v.errors.join('; ') });
  return v;
}

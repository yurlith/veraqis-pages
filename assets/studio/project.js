// VERAQIS Studio — the local project model.
//
// A project is metadata and findings. It never contains archive bytes,
// decompressed content, recovered content, passwords or full device paths — a
// test asserts this on every run.
//
// An imported project is untrusted input: validated against the schema, coerced
// to known types, length-capped, and never executed or inserted as markup.

import { StudioError, ERR } from './errors.js';

export const PROJECT_SCHEMA = 'veraqis-project/1';
export const PROJECT_SCHEMA_VERSION = 1;
export const STUDIO_VERSION = '1.0.0';

/** Operation status — deliberately separate from the evidence status. An entry
 *  that was extracted does not thereby become VERIFIED. */
export const OP_STATUS = {
  NOT_SELECTED: 'NOT_SELECTED',
  READY: 'READY',
  EXTRACTING: 'EXTRACTING',
  EXTRACTED_VERIFIED: 'EXTRACTED_VERIFIED',
  EXTRACTED_UNVERIFIED: 'EXTRACTED_UNVERIFIED',
  SKIPPED: 'SKIPPED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

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

/** Does this file look like the one the project was built from? */
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

    entries: (a.entries || []).map((e) => ({
      name: str(e.name, CAPS.NAME),
      method: num(e.method),
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
    exportedArtifacts: [],       // Phase 3
    notes: '',
    settingsSnapshot: settings || null,
  };
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
  if (input.schema !== PROJECT_SCHEMA) {
    errors.push(`schema is "${str(input.schema, 60)}", expected "${PROJECT_SCHEMA}"`);
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
    'exportedArtifacts', 'notes', 'settingsSnapshot']);
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
    entries: arr(input.entries).map((e) => ({
      name: str(e && e.name, CAPS.NAME),
      method: num(e && e.method),
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

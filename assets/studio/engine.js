// VERAQIS Studio — the ArchiveEngine contract and the format-adapter registry.
//
// The UI never touches a parser directly. It asks the registry which adapter
// claims a file, then drives that adapter through this contract. That is what
// lets a second format, or a different engine implementation, arrive later
// without the UI changing shape.
//
// No DOM, no network. Runs in the worker.

import { analyzeArchive, readerFromBlob, STATUS } from '../zip-checker/zip-core.js';
import { StudioError, ERR, toStudioError } from './errors.js';
import { STAGE } from './protocol.js';
import { extractVerifiedEntry as runExtraction, EXTRACT_ENGINE_VERSION, probeDeflateRaw } from './extract.js';
import { wasmZipEngine } from './wasm-engine.js';
export { wasmZipEngine };

export const ENGINE_RESULT_SCHEMA = 'veraqis-studio-analysis/1';

/**
 * @typedef {Object} ArchiveEngine
 * @property {string} id
 * @property {string} label
 * @property {string} version
 * @property {string[]} extensions
 * @property {(file:File)=>Promise<{claims:boolean, format:string, confidence:string}>} detect
 * @property {(file:File, options:object, onProgress:Function, signal:AbortSignal)=>Promise<object>} analyze
 * @property {object} capabilities
 * @property {string[]} limitations
 */

/* ------------------------------------------------------- ZIP-family detection */

// ZIP-derived containers are classified by extension AND by what is inside them.
// This is a naming/classification aid only — it never implies semantic recovery
// of the Office/APK layer, which is not implemented.
const ZIP_DERIVED = [
  { ext: 'docx', label: 'Word document (OOXML)', marker: 'word/' },
  { ext: 'xlsx', label: 'Excel workbook (OOXML)', marker: 'xl/' },
  { ext: 'pptx', label: 'PowerPoint presentation (OOXML)', marker: 'ppt/' },
  { ext: 'apk', label: 'Android package', marker: 'AndroidManifest.xml' },
  { ext: 'jar', label: 'Java archive', marker: 'META-INF/' },
  { ext: 'epub', label: 'EPUB book', marker: 'META-INF/container.xml' },
  { ext: 'odt', label: 'OpenDocument text', marker: 'content.xml' },
  { ext: 'ods', label: 'OpenDocument spreadsheet', marker: 'content.xml' },
];

const extOf = (name) => {
  const i = String(name || '').lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

/** Classify a ZIP by the names it contains. Detection only — no semantic claim. */
function classifyZipFamily(fileName, entries) {
  const ext = extOf(fileName);
  const names = entries.map((e) => e.name || '');
  for (const d of ZIP_DERIVED) {
    const byMarker = names.some((n) => n.startsWith(d.marker) || n === d.marker);
    if (d.ext === ext && byMarker) return { id: d.ext, label: d.label, evidence: 'extension and contents agree' };
    if (byMarker && !ext) return { id: d.ext, label: d.label, evidence: 'contents match this layout' };
  }
  for (const d of ZIP_DERIVED) {
    if (d.ext === ext) {
      return {
        id: d.ext, label: d.label,
        evidence: 'extension only — the expected internal layout was not found, which is itself a finding',
      };
    }
  }
  return { id: 'zip', label: 'ZIP archive', evidence: 'ZIP container' };
}

/* ------------------------------------------------------------- the ZIP engine */

export const zipEngine = {
  id: 'zip',
  label: 'ZIP',
  version: '1.1.0',
  extensions: ['zip', 'docx', 'xlsx', 'pptx', 'apk', 'jar', 'epub', 'odt', 'ods'],

  capabilities: {
    zip32: true,
    zip64: 'detect-only',        // parsed; entries above 4 GiB are not CRC-verified
    methodStore: true,
    methodDeflate: true,
    dataDescriptors: 'detect-only',
    encryptedEntries: 'detect-only',
    unicodeNames: true,
    crcVerification: true,
    // Phase 3: one entry, already VERIFIED, re-checksummed after extraction.
    // The value is a scope, not a boolean, so nothing can read it as "extraction
    // works" in general.
    individualExtraction: 'verified-only',
    extractionMethods: [0, 8],
    rebuiltZipOutput: false,     // Phase 4 — not enabled in this release
    massExtraction: false,       // deliberately never: see VERIFIED_EXTRACTION_POLICY.md
    extractionEngineVersion: EXTRACT_ENGINE_VERSION,
  },

  limitations: [
    'Analysis never writes. Extraction produces a new local download and never modifies the source archive.',
    'Only an entry already classified VERIFIED can be extracted, and only one at a time.',
    'Stored and Deflate entries can have their CRC-32 recomputed. Other methods are described but never verified and never extracted.',
    'Encrypted entries are detected and reported as unknown. No password is guessed, derived or requested.',
    'ZIP64 is parsed, but entries above 4 GiB are not CRC-verified in a browser.',
    'Split and spanned archives are detected, not reassembled.',
    'Nested archives are detected, never opened automatically.',
  ],

  async detect(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const sig = head.length >= 4
        ? (head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24)) >>> 0
        : 0;
      const isZipSig = sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x02014b50;
      const ext = extOf(file.name);
      const knownExt = this.extensions.includes(ext);
      // A ZIP whose head was destroyed still has headers further in, so a
      // failed signature check is not a refusal — it is a lower confidence.
      return {
        claims: true,
        format: 'zip',
        confidence: isZipSig ? 'signature' : knownExt ? 'extension' : 'fallback',
      };
    } catch (e) {
      throw toStudioError(e, ERR.FILE_ACCESS, STAGE.IDENTIFY);
    }
  },

  async analyze(file, options = {}, onProgress = () => {}, signal = undefined) {
    let raw;
    try {
      raw = await analyzeArchive(
        readerFromBlob(file),
        { fileName: file.name, verifyCrc: options.verifyCrc !== false },
        (p) => onProgress(mapStage(p)),
        signal
      );
    } catch (e) {
      throw toStudioError(e, ERR.STRUCTURE_INVALID, STAGE.REPORT);
    }

    const family = classifyZipFamily(file.name, raw.entries || []);
    const nested = (raw.entries || []).filter((e) => /\.(zip|jar|apk|docx|xlsx|pptx|epub|7z|rar|tar|gz)$/i.test(e.name || ''));

    return {
      schema: ENGINE_RESULT_SCHEMA,
      engine: { id: this.id, version: this.version, kind: 'javascript' },
      format: { id: family.id, label: family.label, evidence: family.evidence, container: 'zip' },
      nestedArchives: nested.map((e) => ({ name: e.name, size: e.compressedSize, status: e.status })),
      // The underlying result is carried through unchanged so the report schema
      // stays the one the ZIP checker already emits and its tests already cover.
      analysis: raw,
    };
  },

  /**
   * Extract exactly one entry that is already classified VERIFIED.
   *
   * The UI never reaches into the ZIP parser to do this: it hands over a project,
   * an entry id and the file, and gets back a result or a typed error. That seam
   * is why a second format could add extraction without the workspace changing.
   *
   * @param {Blob|File} file
   * @param {string} entryId
   * @param {{plan:object, project:object, capabilities:object, policy:object}} options
   * @param {{onProgress?:Function, onAccepted?:Function}} callbacks
   * @param {AbortSignal} [signal]
   */
  async extractVerifiedEntry(file, entryId, options, callbacks, signal) {
    return runExtraction(file, entryId, options, callbacks, signal);
  },

  /** Known-answer test for this browser's raw-DEFLATE decoder. */
  probeDeflateRaw,

  // Declared so the contract is visible and callers can feature-test it. Phase 4.
  async verifyEntry() { throw new StudioError(ERR.INTERNAL_ERROR, { detail: 'verifyEntry is not implemented in this release' }); },
  async buildRecoveryPlan() { throw new StudioError(ERR.INTERNAL_ERROR, { detail: 'buildRecoveryPlan is not implemented in this release' }); },
  /** Unscoped extraction stays unimplemented on purpose: every extraction in
   *  this release goes through the eligibility gate, and a method that bypassed
   *  it would be the one an accident reaches for. */
  async extractEntry() { throw new StudioError(ERR.INTERNAL_ERROR, { detail: 'unscoped extractEntry is not implemented; use extractVerifiedEntry, which enforces the eligibility gate' }); },
  dispose() { /* stateless */ },
};

/** Map the core's progress phases onto the Studio pipeline stages. */
function mapStage(p) {
  const m = {
    start: STAGE.IDENTIFY,
    eocd: STAGE.EOCD,
    'central-directory': STAGE.CENTRAL_DIRECTORY,
    'local-headers': STAGE.LOCAL_HEADERS,
    crc: STAGE.CRC,
  };
  return { ...p, stage: m[p.phase] || p.phase };
}

/* ------------------------------------------------------------------ registry */

// Phase G / G4 (docs/web-studio/WASM_FEASIBILITY.md): wasmZipEngine first —
// selectEngine() tries it before zipEngine, and its own detect() refuses
// (claims:false) unless CAPABILITY.WASM_ZIP_CORE is enabled, so zipEngine is
// what actually runs whenever the capability is off, the file exceeds the
// size this engine keeps unbounded in memory, or detect() throws for any
// other reason — the same fallback shape every other capability probe here
// already uses, not new machinery.
const REGISTRY = [wasmZipEngine, zipEngine];

export function listEngines() {
  return REGISTRY.map((e) => ({
    id: e.id, label: e.label, version: e.version,
    extensions: e.extensions, capabilities: e.capabilities, limitations: e.limitations,
  }));
}

/** Pick the adapter for a file. Only ZIP exists; the seam is what matters. */
export async function selectEngine(file) {
  for (const engine of REGISTRY) {
    const d = await engine.detect(file);
    if (d.claims) return { engine, detection: d };
  }
  throw new StudioError(ERR.FORMAT_UNSUPPORTED, { stage: STAGE.IDENTIFY });
}

export { STATUS };

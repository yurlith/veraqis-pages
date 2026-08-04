// VERAQIS Studio — the wasm32 build of phx_zip_core, loaded, gated, and
// wrapped as a real `ArchiveEngine` (engine.js's `zipEngine` contract).
//
// Phase G / G4 (docs/web-studio/WASM_FEASIBILITY.md, owner-approved
// 2026-08-04): `CAPABILITY.WASM_ZIP_CORE` is now `enabled: true` by default,
// and `wasmZipEngine` is first in `engine.js`'s `REGISTRY` — it is what
// `selectEngine()` picks for real users whenever it claims a file.
// `detect()` still refuses (claims:false) for a file above the device's
// `sizePolicy().recommended` bound, so `zipEngine` — the memory-bounded,
// 1 MiB-chunked engine — is what actually runs on large archives; the whole-
// file-in-memory read this engine does is a real limitation, not eliminated
// by this change, only kept away from the files where it would matter.
//
// No DOM. The only network-shaped operation is the module's own same-origin
// fetch of its .wasm file (`new URL('phx_zip_wasm_bg.wasm', import.meta.url)`
// inside wasm/phx_zip_wasm.js), already covered by this site's
// `connect-src 'self'`.

import { CAPABILITY, capabilityEnabled, detectSync, sizePolicy } from './capabilities.js';
import { StudioError, ERR } from './errors.js';
import { mapWasmAnalysisToStudio } from './wasm-verdict.js';

let modulePromise = null;

/**
 * Load and instantiate the wasm32 phx_zip_core build, once per worker/page
 * lifetime. Throws `StudioError(CAPABILITY_NOT_AVAILABLE)` unless the
 * capability has been explicitly enabled — the same refusal shape as every
 * other not-shipped-in-this-build capability, so the UI needs no special case.
 */
export async function loadWasmZipCore() {
  if (!capabilityEnabled(CAPABILITY.WASM_ZIP_CORE)) {
    throw new StudioError(ERR.CAPABILITY_NOT_AVAILABLE, {
      detail: 'wasm_zip_core is not enabled in this build',
    });
  }
  if (!modulePromise) {
    modulePromise = import('./wasm/phx_zip_wasm.js').then(async (mod) => {
      await mod.default();
      return mod;
    });
  }
  const mod = await modulePromise;
  return {
    /**
     * @param {Uint8Array} bytes
     * @returns {object} the raw phx_zip_wasm result, see crates/phx_zip_wasm/src/lib.rs
     */
    analyzeRaw(bytes) {
      return JSON.parse(mod.analyze_zip(bytes));
    },
  };
}

/**
 * The Rust/WASM `ArchiveEngine`. Same contract as `engine.js`'s `zipEngine`,
 * same `detect()` signature and `analyze()` result shape
 * (`veraqis-studio-analysis/1`) — see `wasm-verdict.js` for the mapping and
 * exactly which fields are reproduced with full fidelity against the JS
 * reference core versus approximated (documented in the result's
 * `limitations`).
 *
 * Real, honest limitation this engine has that `zipEngine` does not: it reads
 * the *entire* file into memory before analysis (`phx_zip_wasm::analyze_zip`
 * takes `&[u8]`, not a chunked reader), so there is no incremental progress
 * during the parse — `onProgress` fires only `start` and `done`. `zipEngine`
 * streams in 1 MiB chunks; this one does not, and is not a memory-bounded
 * replacement for it.
 */
export const wasmZipEngine = {
  id: 'zip-wasm',
  label: 'ZIP (Rust/WASM)',
  version: '0.1.0',
  extensions: ['zip', 'docx', 'xlsx', 'pptx', 'apk', 'jar', 'epub', 'odt', 'ods'],

  capabilities: {
    zip32: true,
    zip64: 'detect-only',
    methodStore: true,
    methodDeflate: true,
    dataDescriptors: 'detect-only',
    encryptedEntries: 'detect-only',
    unicodeNames: true,
    crcVerification: true,
    individualExtraction: false,
    rebuiltZipOutput: false,
    massExtraction: false,
    streamedAnalysis: false,
  },

  limitations: [
    'Reads the whole file into memory before analysis; no chunked/streamed parse. detect() defers to zipEngine above the device\'s recommended size bound (sizePolicy()) for this reason.',
    'No extraction of any kind.',
    'centralDirectory.status does not yet distinguish a malformed directory record from a missing/short one.',
  ],

  /** Same signature as `zipEngine.detect`. Refuses (claims:false) — so
   *  `selectEngine()` falls through to `zipEngine` — when the capability is
   *  off, or the file is larger than this device's recommended size bound
   *  (this engine has no chunked/streamed path; `zipEngine` does). */
  async detect(file) {
    if (!capabilityEnabled(CAPABILITY.WASM_ZIP_CORE)) {
      return { claims: false, format: 'zip', confidence: 'unavailable' };
    }
    if (file.size > sizePolicy(detectSync()).recommended) {
      return { claims: false, format: 'zip', confidence: 'size-limit' };
    }
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const sig = head.length >= 4
        ? (head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24)) >>> 0
        : 0;
      const isZipSig = sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x02014b50;
      return { claims: true, format: 'zip', confidence: isZipSig ? 'signature' : 'fallback' };
    } catch (e) {
      throw toWasmStudioError(e);
    }
  },

  async analyze(file, _options = {}, onProgress = () => {}, signal = undefined) {
    onProgress({ phase: 'start', done: 0, total: 1 });
    const core = await loadWasmZipCore();
    if (signal && signal.aborted) throw new StudioError(ERR.CANCELLED);
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      throw toWasmStudioError(e);
    }
    if (signal && signal.aborted) throw new StudioError(ERR.CANCELLED);
    let raw;
    try {
      raw = core.analyzeRaw(bytes);
    } catch (e) {
      throw toWasmStudioError(e, ERR.STRUCTURE_INVALID);
    }
    const result = mapWasmAnalysisToStudio(raw, bytes);
    onProgress({ phase: 'done', done: 1, total: 1 });
    return {
      ...result,
      file: { name: file.name || null, size: bytes.length },
    };
  },

  dispose() { /* stateless */ },
};

function toWasmStudioError(e, fallback = ERR.INTERNAL_ERROR) {
  if (e instanceof StudioError) return e;
  const name = e && e.name;
  if (name === 'AbortError') return new StudioError(ERR.CANCELLED);
  return new StudioError(fallback, { detail: String((e && e.message) || e || ''), cause: e });
}

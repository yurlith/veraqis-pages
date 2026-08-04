// VERAQIS Studio — capability detection.
//
// The UI is built from what this browser can actually do, measured at runtime.
// A feature whose prerequisites are missing is never offered as if it worked;
// it is disabled with the reason, or hidden.
//
// Measured (audit 2026-07-30): Firefox 153 has NO File System Access API, so
// nothing may depend on it. Both Chrome and Firefox have OPFS, IndexedDB,
// module workers, DecompressionStream('deflate-raw') and Web Crypto.

export const LEVEL = {
  SUPPORTED: 'Supported',
  LIMITED: 'Limited',
  EXPERIMENTAL: 'Experimental',
  UNSUPPORTED: 'Unsupported',
};

/**
 * Named product capabilities.
 *
 * Each is a separate switch on purpose. "Studio can extract" and "Studio can
 * build an archive" are different promises with different evidence behind them,
 * and a single boolean would let one imply the other. The registry is the one
 * place that answers "is this feature on?", and the worker, the writer and the
 * UI all ask it rather than deciding for themselves.
 *
 * `enabled` is a build-time property of this release. It is deliberately NOT a
 * user-toggleable or payment-derived flag: there is no entitlement machinery
 * here, no `isPaid`, and nothing client-side that could be flipped to unlock
 * something. If a capability ever becomes commercial, the check stays in this
 * one place and gains a real, server-independent licence input — which is a
 * separate decision from this phase.
 */
export const CAPABILITY = {
  VERIFIED_SINGLE_ENTRY_EXTRACTION: 'verified_single_entry_extraction',
  VERIFIED_BATCH_EXPORT: 'verified_batch_export',
  REBUILT_ZIP: 'rebuilt_zip',
  LOCAL_HEADER_RECOVERY: 'local_header_recovery',
  EXPERIMENTAL_RECOVERY: 'experimental_recovery',
  WASM_ZIP_CORE: 'wasm_zip_core',
};

const CAPABILITY_REGISTRY = {
  [CAPABILITY.VERIFIED_SINGLE_ENTRY_EXTRACTION]: {
    enabled: true,
    label: 'Download individually verified files',
    scope: 'One entry at a time, VERIFIED only, re-checksummed after extraction.',
  },
  // Declared here, implemented elsewhere. The free build ships no batch-export
  // implementation at all, so this stays false and there is no flag to flip:
  // `enableCapability` is only ever called by a module that registers a working
  // handler, and that module is not part of the free deployment.
  [CAPABILITY.VERIFIED_BATCH_EXPORT]: {
    enabled: false,
    label: 'Build verified-files archive',
    scope: 'Several VERIFIED entries into a new ZIP built from scratch, self-verified before download.',
    unavailableReason: 'Not included in this build of VERAQIS.',
  },
  // Declared so the boundaries are visible in code rather than only in prose.
  [CAPABILITY.REBUILT_ZIP]: {
    enabled: false,
    label: 'Rebuilt archive',
    scope: 'Repairing the source archive itself. Not implemented.',
  },
  [CAPABILITY.LOCAL_HEADER_RECOVERY]: {
    enabled: false,
    label: 'Local-header recovery',
    scope: 'Recovering entries the index does not describe. Not implemented.',
  },
  [CAPABILITY.EXPERIMENTAL_RECOVERY]: {
    enabled: false,
    label: 'Experimental recovery',
    scope: 'Speculative reconstruction. Not implemented.',
  },
  // Phase G / G4 (docs/web-studio/WASM_FEASIBILITY.md, owner-approved
  // 2026-08-04): `wasmZipEngine` (wasm-engine.js) is a full `ArchiveEngine` —
  // same contract as `engine.js`'s `zipEngine` — backed by the wasm32 build
  // of phx_zip_core. Its verdict/status mapping (wasm-verdict.js) passes the
  // 23-fixture parity contract against zip-core.js in Node AND in real
  // Chrome, Edge and Firefox (tools/wasm-zip-core/browser-parity.mjs), under
  // the real CSP. `enabled: true` and first in `engine.js`'s `REGISTRY`: this
  // is now the live analysis engine for a real Studio user, whenever its own
  // `detect()` claims the file — it refuses (falls through to `zipEngine`)
  // above the device's recommended size bound (no chunked/streamed parse) or
  // if the capability were ever disabled. `wasmEngine` in `featureMatrix`
  // below now reflects this instead of a hardcoded CSP-blocked refusal.
  [CAPABILITY.WASM_ZIP_CORE]: {
    enabled: true,
    label: 'Rust/WASM analysis core',
    scope: 'Single-source-of-truth ZIP structure walk, shared with the desktop recovery engine. Verified against the JavaScript reference core across 23 fixtures, in Node and in Chrome/Edge/Firefox.',
  },
};

/** Is a named capability available in this build? */
export function capabilityEnabled(id) {
  const c = CAPABILITY_REGISTRY[id];
  return !!(c && c.enabled);
}

/**
 * Mark an optional capability as present, because its implementation registered.
 *
 * This is not a feature flag and it is not reachable from the UI, a URL, a
 * project file or the DOM. The only caller is the worker's
 * `registerOptionalCapability`, which is itself only reached by importing an
 * implementation module — and in the free build that module does not exist.
 * Enabling therefore cannot be simulated: there would be no handler behind it.
 *
 * A capability that was never declared is not creatable here either; unknown
 * ids are ignored rather than added.
 */
export function enableCapability(id) {
  const c = CAPABILITY_REGISTRY[id];
  if (!c) return false;
  c.enabled = true;
  delete c.unavailableReason;
  return true;
}

/** The whole registry, for the capability strip and for tests. */
export function listCapabilities() {
  return Object.entries(CAPABILITY_REGISTRY).map(([id, c]) => ({ id, ...c }));
}

const probe = (fn) => { try { return !!fn(); } catch { return false; } };

/** Synchronous platform probes. Cheap; safe to call at boot. */
export function detectSync() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  const nav = g.navigator || {};
  return {
    worker: typeof g.Worker !== 'undefined',
    moduleWorker: typeof g.Worker !== 'undefined',
    decompressionStream: typeof g.DecompressionStream !== 'undefined',
    deflateRaw: probe(() => new g.DecompressionStream('deflate-raw')),
    compressionStream: typeof g.CompressionStream !== 'undefined',
    deflateRawCompress: probe(() => new g.CompressionStream('deflate-raw')),
    indexedDB: typeof g.indexedDB !== 'undefined',
    serviceWorker: !!(nav.serviceWorker),
    webCrypto: !!(g.crypto && g.crypto.subtle && g.crypto.subtle.digest),
    blobSlice: typeof g.Blob !== 'undefined' && typeof g.Blob.prototype.slice === 'function',
    fileSystemAccess: typeof g.showOpenFilePicker === 'function',
    directoryPicker: typeof g.showDirectoryPicker === 'function',
    wasm: typeof g.WebAssembly === 'object',
    cores: nav.hardwareConcurrency || null,
    deviceMemoryGB: nav.deviceMemory || null,
  };
}

/**
 * Probes that need to await.
 *
 * `deflateRawVerified` is the one that matters for extraction: `detectSync`
 * proves only that the constructor exists, and a decoder that exists but
 * produces the wrong bytes would be worse than one that is absent. The
 * known-answer test lives in extract.js next to the code that depends on it.
 */
export async function detect() {
  const base = detectSync();
  let opfs = false;
  let quotaMB = null;
  let usageMB = null;
  try {
    const nav = globalThis.navigator;
    if (nav && nav.storage && typeof nav.storage.getDirectory === 'function') {
      await nav.storage.getDirectory();
      opfs = true;
    }
    if (nav && nav.storage && typeof nav.storage.estimate === 'function') {
      const est = await nav.storage.estimate();
      quotaMB = Math.round((est.quota || 0) / 1048576);
      usageMB = Math.round((est.usage || 0) / 1048576);
    }
  } catch { /* storage unavailable; the fallbacks below cover it */ }

  // Functional check of the raw-DEFLATE decoder, not a constructor check.
  let deflateRawVerified = false;
  let deflateRawReason = 'not probed';
  if (base.deflateRaw) {
    try {
      const { probeDeflateRaw } = await import('./extract.js');
      const r = await probeDeflateRaw();
      deflateRawVerified = r.ok;
      deflateRawReason = r.reason || 'known-answer test passed';
    } catch (e) {
      deflateRawReason = `the decoder probe could not run (${String(e && e.message).slice(0, 80)})`;
    }
  } else {
    deflateRawReason = "DecompressionStream('deflate-raw') is unavailable";
  }

  return {
    ...base, opfs, quotaMB, usageMB,
    deflateRawVerified,
    deflateRawReason,
    // Extraction uses the VERIFIED decoder, never the merely-present one.
    deflateRaw: base.deflateRaw && deflateRawVerified,
    deflateRawPresent: base.deflateRaw,
  };
}

/**
 * Turn raw probes into the feature levels the UI reasons about.
 * Every entry states WHY, so a disabled control can explain itself.
 */
export function featureMatrix(c) {
  const need = (ok, why) => (ok ? { level: LEVEL.SUPPORTED, why: '' } : { level: LEVEL.UNSUPPORTED, why });
  return {
    analysis: need(c.worker && c.blobSlice,
      'Analysis needs Web Workers and Blob slicing.'),
    crcStored: need(c.worker && c.blobSlice,
      'Checksum verification of stored entries needs Web Workers.'),
    crcDeflate: c.deflateRaw
      ? { level: LEVEL.SUPPORTED, why: '' }
      : { level: LEVEL.UNSUPPORTED, why: "This browser has no DecompressionStream('deflate-raw'), so compressed entries cannot have their checksum recomputed. They are reported as unverified, never as verified." },
    // Extraction is split in two, because the honest answer differs by method.
    // A browser without raw-DEFLATE can still extract a Stored entry exactly, so
    // collapsing both into one "extraction: unsupported" row would understate
    // what the user can do — and the reverse would overstate it.
    extractStored: need(c.worker && c.blobSlice,
      'Extracting a verified stored entry needs Web Workers and Blob slicing.'),
    extractDeflate: c.deflateRaw
      ? { level: LEVEL.SUPPORTED, why: '' }
      : { level: LEVEL.UNSUPPORTED, why: "This browser has no DecompressionStream('deflate-raw'), so compressed entries cannot be decoded here. Analysis is unaffected, stored entries can still be extracted, and no external decompression library is loaded to work around it." },
    // Verified batch export. Note what it does NOT need: `CompressionStream`.
    // The writer copies each entry's already-compressed payload after verifying
    // it, so no browser compressor is involved and Firefox's lack of the File
    // System Access API is irrelevant. What it does need is the same worker and
    // Blob slicing as extraction, plus a verified decoder for any Deflate entry
    // in the selection — because verifying a Deflate entry means decoding it.
    verifiedBatchExport: need(c.worker && c.blobSlice && c.webCrypto,
      'Building a verified archive needs Web Workers, Blob slicing and the Web Crypto API.'),
    zipWriting: c.deflateRawCompress
      ? { level: LEVEL.EXPERIMENTAL, why: 'Re-compressing entries is not part of verified batch export, which copies already-verified compressed payloads.' }
      : { level: LEVEL.UNSUPPORTED, why: "This browser has no CompressionStream('deflate-raw'). Verified batch export does not require it." },
    saveProjects: need(c.indexedDB,
      'Saving a project on this device needs IndexedDB, which is unavailable (private-browsing mode can disable it).'),
    fingerprintSha256: need(c.webCrypto,
      'SHA-256 fingerprints need the Web Crypto API.'),
    offline: need(c.serviceWorker,
      'Offline use needs Service Workers, which some browsers disable in private windows.'),
    directoryExport: c.directoryPicker
      ? { level: LEVEL.SUPPORTED, why: '' }
      : { level: LEVEL.UNSUPPORTED, why: 'This browser has no File System Access API. Exports fall back to ordinary downloads — no feature is lost, only the folder picker.' },
    opfsStaging: c.opfs
      ? { level: LEVEL.SUPPORTED, why: '' }
      : { level: LEVEL.UNSUPPORTED, why: 'The private origin filesystem is unavailable.' },
    // Phase G / G4: the studio page class's CSP now permits WebAssembly, and
    // wasmZipEngine is the live analysis engine whenever CAPABILITY.WASM_ZIP_CORE
    // is enabled (it is, by default — see capabilities registry above) and the
    // browser has WebAssembly at all. EXPERIMENTAL, not SUPPORTED: it is newly
    // shipped, not yet used for extraction, and Safari is not yet verified —
    // this matches the LEVEL vocabulary's own distinction, not an overclaim.
    wasmEngine: capabilityEnabled(CAPABILITY.WASM_ZIP_CORE)
      ? (c.wasm
        ? { level: LEVEL.EXPERIMENTAL, why: 'The Rust/WASM analysis core is live for this session. Verified against the JavaScript reference core across 23 fixtures in Node, Chrome, Edge and Firefox; Safari not yet verified; not yet used for extraction.' }
        : { level: LEVEL.UNSUPPORTED, why: 'This browser has no WebAssembly support.' })
      : { level: LEVEL.UNSUPPORTED, why: "The site's security policy does not permit WebAssembly on this page." },
  };
}

/**
 * Size policy derived from what the platform reports rather than one hardcoded
 * number. Returns bytes.
 */
export function sizePolicy(c) {
  const memGB = c.deviceMemoryGB || 4;          // Firefox reports null; assume a modest device
  const recommended = Math.min(512, memGB * 32) * 1048576;
  const warn = Math.min(2048, memGB * 128) * 1048576;
  const hard = Math.min(8192, memGB * 512) * 1048576;
  return {
    recommended, warn, hard,
    basis: c.deviceMemoryGB
      ? `navigator.deviceMemory = ${c.deviceMemoryGB} GB`
      : 'navigator.deviceMemory unavailable (Firefox); assuming a 4 GB device',
  };
}

export function summarise(matrix) {
  const out = [];
  for (const [id, v] of Object.entries(matrix)) out.push({ id, ...v });
  return out;
}

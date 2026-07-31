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

/** Probes that need to await. */
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
  return { ...base, opfs, quotaMB, usageMB };
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
    zipWriting: c.deflateRawCompress
      ? { level: LEVEL.EXPERIMENTAL, why: 'Building a new archive is planned; not enabled in this release.' }
      : { level: LEVEL.UNSUPPORTED, why: "This browser has no CompressionStream('deflate-raw')." },
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
    // WebAssembly is present in every tested browser but is blocked by this
    // site's Content-Security-Policy, which omits 'wasm-unsafe-eval' on purpose.
    wasmEngine: { level: LEVEL.UNSUPPORTED, why: "The site's security policy does not permit WebAssembly. The analysis engine is JavaScript by design." },
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

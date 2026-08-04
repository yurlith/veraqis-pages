// VERAQIS Studio — maps phx_zip_wasm's evidence onto zip-core.js's result
// shape (STATUS, verdict, centralDirectory.status).
//
// phx_zip_core has no "skip CRC" mode: it verifies every entry it can reach,
// so its per-entry evidence is a complete 3-way partition — proven, disproven,
// or out of scope (crates/phx_zip_wasm/src/lib.rs's header comment). The JS
// core's 5-way STATUS exists because it supports `verifyCrc:false` and
// because it treats "found by scan, not yet checked" as its own state. This
// module reproduces the JS core's OWN rule for going from a specific abstain
// reason + provenance to STRUCTURALLY_VALID vs POTENTIALLY_RECOVERABLE
// (assets/zip-checker/zip-core.js lines ~533, 586, 654-658) rather than
// inventing a new one — every branch here is cited against that file.
//
// No DOM, no network.

export const STATUS = {
  VERIFIED: 'VERIFIED',
  STRUCTURALLY_VALID: 'STRUCTURALLY_VALID',
  POTENTIALLY_RECOVERABLE: 'POTENTIALLY_RECOVERABLE',
  DAMAGED: 'DAMAGED',
  UNKNOWN: 'UNKNOWN',
};

const REASON = {
  verified_crc: 'CRC-32 recomputed from the archive data and matches the stored value',
  crc_mismatch: 'decompressed data CRC-32 does not match the stored value',
  decode_failed: 'the compressed data did not decode',
  bad_local_header: 'no local file header found at the declared offset',
  truncated: 'declared data range runs past the end of the file — the entry is truncated',
  unsupported: 'compression method is not decoded by this tool',
  encrypted: 'entry is encrypted — contents cannot be checked',
  zip64_unsupported: 'ZIP64 extended sizes/offsets are in use and not parsed by this engine',
  streamed_unsized: 'sizes are recorded after the data (streamed entry); the entry length is not known without the central directory',
};

/**
 * zip-core.js STATUS, from phx_zip_wasm's specific abstain/outcome reason.
 * See zip-core.js: encrypted always -> UNKNOWN (line 559-562, 600); an
 * unsupported method or ZIP64/streamed entry that could not be checked stays
 * at its PRE-CRC-pass default, which is STRUCTURALLY_VALID for a
 * central-directory record (line 533) or POTENTIALLY_RECOVERABLE for a
 * scan-only local header (line 586) — CRC verification never runs for these,
 * so nothing promotes or damages them.
 */
function mapEntryStatus(e) {
  switch (e.status) {
    case 'verified_crc':
      return STATUS.VERIFIED;
    case 'crc_mismatch':
    case 'decode_failed':
    case 'bad_local_header':
    case 'truncated':
      return STATUS.DAMAGED;
    case 'encrypted':
      return STATUS.UNKNOWN;
    case 'unsupported':
    case 'zip64_unsupported':
    case 'streamed_unsized':
      return e.from_central_dir ? STATUS.STRUCTURALLY_VALID : STATUS.POTENTIALLY_RECOVERABLE;
    default:
      return STATUS.UNKNOWN;
  }
}

/**
 * zip-core.js centralDirectory.status (lines ~487-498), from the facts
 * phx_zip_wasm exposes. `cdStatus` stays at its 'MISSING' default UNLESS an
 * EOCD was found at all (line 488: `if (eocd.found) { … }`) — without one,
 * there is no offset/size to even attempt a central-directory read from, so
 * JS never computes OK/DAMAGED/PARTIAL. Known gap, stated not hidden: the JS
 * core's `cd.errors`/`cd.truncated` inputs have no phx_zip_wasm equivalent
 * yet, so a central-directory record that is *structurally malformed* (not
 * merely missing or short) cannot be distinguished from PARTIAL here. Not
 * observed to matter on the 23-fixture corpus
 * (tools/wasm-zip-core/parity.mjs), which is what backs this, not an
 * assumption.
 */
function deriveCdStatus(raw) {
  if (!raw.eocd_found) return 'MISSING';
  const recordsRead = raw.entries.filter((e) => e.from_central_dir).length;
  const expected = raw.cd_declared_count ?? 0;
  if (recordsRead === 0 && expected === 0) return 'OK';
  if (recordsRead === 0) return 'DAMAGED';
  if (recordsRead !== expected) return 'PARTIAL';
  return 'OK';
}

/** zip-core.js's verdict formula (lines 687-700), unchanged. */
function deriveVerdict({ eocdFound, cdDeclaredCount, entries, cdStatus }) {
  if (entries.length === 0) {
    return eocdFound && cdDeclaredCount === 0 ? 'EMPTY_ARCHIVE' : 'NO_ENTRIES_FOUND';
  }
  const c = {
    verified: entries.filter((e) => e.status === STATUS.VERIFIED).length,
    structurallyValid: entries.filter((e) => e.status === STATUS.STRUCTURALLY_VALID).length,
    potentiallyRecoverable: entries.filter((e) => e.status === STATUS.POTENTIALLY_RECOVERABLE).length,
    damaged: entries.filter((e) => e.status === STATUS.DAMAGED).length,
    unknown: entries.filter((e) => e.status === STATUS.UNKNOWN).length,
  };
  if (c.damaged === 0 && c.unknown === 0 && c.potentiallyRecoverable === 0 && cdStatus === 'OK') {
    return c.verified === entries.length ? 'INTACT_VERIFIED' : 'INTACT_STRUCTURE';
  }
  if (c.verified + c.structurallyValid + c.potentiallyRecoverable > 0) {
    return 'PARTIALLY_RECOVERABLE';
  }
  if (c.damaged === 0 && c.unknown > 0) return 'UNDETERMINED';
  return 'DAMAGED';
}

/**
 * `looksZip`: zip-core.js's own head-signature check (line 439), reproduced
 * exactly — a 4-byte read, not evidence computation, so there is nothing for
 * phx_zip_core to compute here.
 */
function looksLikeZipHead(bytes) {
  if (bytes.length < 4) return false;
  const sig = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  return sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x02014b50 || sig === 0x08074b50;
}

/**
 * Map phx_zip_wasm's raw `analyze_zip` output — already parsed, i.e. what
 * `wasm-engine.js`'s `analyzeRaw(bytes)` returns — plus the original file
 * bytes, onto zip-core.js's result shape. `veraqis-studio-analysis/1`-
 * compatible at the fields the Studio UI and this mapping's own parity gate
 * check; see `limitations` in the return value for what is not reproduced
 * with full fidelity.
 */
export function mapWasmAnalysisToStudio(raw, bytes) {
  if (bytes.length === 0) {
    return finish({ verdict: 'NOT_A_ZIP', reason: 'the file is empty', raw, entries: [] });
  }
  const looksZip = looksLikeZipHead(bytes);
  if (!looksZip && !raw.eocd_found) {
    return finish({
      verdict: 'NOT_A_ZIP',
      reason: 'no ZIP signature at the start of the file and no end-of-central-directory record',
      raw, entries: [],
    });
  }

  const entries = raw.entries.map((e) => ({
    name: e.name,
    nameValidUtf8: e.name_valid_utf8,
    method: e.method,
    compressedSize: e.comp_size,
    uncompressedSize: e.uncomp_size,
    localHeaderOffset: e.local_header_offset,
    declaredCrc32: e.declared_crc32,
    actualCrc32: e.actual_crc32,
    encrypted: e.encrypted,
    hasDataDescriptor: e.has_data_descriptor,
    zip64: e.zip64,
    source: e.from_central_dir ? 'central-directory' : 'local-header-scan',
    status: mapEntryStatus(e),
    reasons: [REASON[e.status] || e.status],
  }));

  const cdStatus = deriveCdStatus(raw);
  const verdict = deriveVerdict({
    eocdFound: raw.eocd_found, cdDeclaredCount: raw.cd_declared_count, entries, cdStatus,
  });

  return finish({ verdict, raw, entries, cdStatus });
}

function finish({ verdict, raw, entries, cdStatus, reason }) {
  const count = (s) => entries.filter((e) => e.status === s).length;
  return {
    schema: 'veraqis-studio-analysis/1',
    engine: { id: 'zip-wasm', kind: 'wasm', mapping: 'wasm-verdict.js' },
    verdict,
    verdictReason: reason || null,
    eocd: { found: !!(raw && raw.eocd_found) },
    centralDirectory: { status: cdStatus || 'MISSING' },
    counts: {
      total: entries.length,
      verified: count(STATUS.VERIFIED),
      structurallyValid: count(STATUS.STRUCTURALLY_VALID),
      potentiallyRecoverable: count(STATUS.POTENTIALLY_RECOVERABLE),
      damaged: count(STATUS.DAMAGED),
      unknown: count(STATUS.UNKNOWN),
    },
    entries,
    limitations: [
      'This engine (phx_zip_wasm) always verifies every reachable entry; there is no verifyCrc:false mode.',
      "centralDirectory.status does not yet distinguish a structurally malformed directory record from a missing/short one (no cd.errors/cd.truncated equivalent).",
      'eocd does not carry offset/size/comment-length detail — only whether one was found.',
    ],
  };
}

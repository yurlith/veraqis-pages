// VERAQIS — browser-side ZIP integrity analysis core.
//
// Pure ES module. NO DOM access, NO network access, NO third-party imports.
// Everything it touches arrives through the `reader` argument, so the same code
// runs in a Web Worker (over a File) and in Node (over a Buffer) — which is how
// the fixture tests exercise it.
//
// This module ANALYSES. It never extracts, never writes, and never modifies the
// input. See docs/site-improvement/ZIP_CHECKER_ARCHITECTURE.md.
//
// Reader contract:
//   { size: number, read(offset, length) -> Promise<Uint8Array> }
//   `read` must clamp to the file end and may return fewer bytes than requested.
//
// The one import is `format-id.js` — pure data and pure functions, no DOM, no network,
// nothing to instantiate — and it is GENERATED from the recovery engine's own magic-byte
// table (crates/phx_format_id). It is imported rather than embedded so that "this is not a
// ZIP, it is a RAR" is the same judgement the engine would make, not a second opinion this
// file invented.

import { identification, bytesOf, REQUIRED_PREFIX, REQUIRED_SUFFIX, FORMATS } from './format-id.js';

/* ---------------------------------------------------------------- constants */

export const SIG = {
  LFH: 0x04034b50,        // PK\x03\x04  local file header
  CDH: 0x02014b50,        // PK\x01\x02  central directory header
  EOCD: 0x06054b50,       // PK\x05\x06  end of central directory
  EOCD64: 0x06064b50,     // PK\x06\x06  zip64 end of central directory
  EOCD64_LOC: 0x07064b50, // PK\x06\x07  zip64 EOCD locator
  DD: 0x08074b50,         // PK\x07\x08  data descriptor
};

export const STATUS = {
  VERIFIED: 'VERIFIED',
  STRUCTURALLY_VALID: 'STRUCTURALLY_VALID',
  POTENTIALLY_RECOVERABLE: 'POTENTIALLY_RECOVERABLE',
  DAMAGED: 'DAMAGED',
  UNKNOWN: 'UNKNOWN',
};

// A declared length is attacker-controlled. Nothing is allocated from one before
// it has been checked against the real file size; these are the last-resort caps.
export const LIMITS = {
  MAX_COMMENT: 65535,          // ZIP spec maximum
  EOCD_SEARCH: 65557,          // 22-byte EOCD + max comment
  MAX_NAME: 4096,              // a filename longer than this is not credible
  MAX_ENTRIES: 200000,         // stop enumerating; report the cap in warnings
  MAX_EXTRA: 65535,
  CHUNK: 1 << 20,              // 1 MiB streaming read unit
  MAX_CRC_BYTES: 512 * 1024 * 1024, // per-entry ceiling for CRC verification
};

/**
 * Why the archive is in the state it is in.
 *
 * The verdict says how much can be trusted; the diagnosis says what went wrong. They are
 * separate on purpose, because three completely different faults — a missing index, a
 * truncated file and a failed checksum — all produce the same verdict while calling for
 * opposite responses. Reporting only the verdict tells a user whose index is gone that
 * their archive is "partially readable", when the truthful and much better news is that
 * their data is intact and only the table of contents is missing.
 *
 * Ordered by severity of what it implies about the DATA, not about the structure.
 */
export const DIAGNOSIS = {
  INTACT: 'INTACT',
  OTHER_FORMAT: 'OTHER_FORMAT',
  SELF_EXTRACTING: 'SELF_EXTRACTING',
  CONTENT_CORRUPT: 'CONTENT_CORRUPT',
  TRUNCATED: 'TRUNCATED',
  HEAD_TRUNCATED: 'HEAD_TRUNCATED',
  INDEX_DAMAGED: 'INDEX_DAMAGED',
  INDEX_MISSING: 'INDEX_MISSING',
  PREPENDED_DATA: 'PREPENDED_DATA',
  UNIDENTIFIED_HEADER: 'UNIDENTIFIED_HEADER',
  ENCRYPTED: 'ENCRYPTED',
  UNSUPPORTED_METHOD: 'UNSUPPORTED_METHOD',
  ZIP64_UNUSABLE: 'ZIP64_UNUSABLE',
  NOT_A_ZIP: 'NOT_A_ZIP',
  EMPTY: 'EMPTY',
};

/**
 * What the leading bytes of a file that does not start with a ZIP signature actually are.
 *
 * The signature check alone cannot tell, and for years this tool did not claim to: a
 * self-extracting archive and a corrupted header both fail it. The distinction is
 * structural — every surviving central-directory record either agrees on ONE offset shift
 * or it does not, because a stub moves the whole archive by its own length while damage is
 * not a translation.
 *
 * `prepend` is that measurement, taken by the Rust engine (see prepend-probe.js). There are
 * four outcomes, not two, and each calls for a different sentence:
 *
 *  - `SFX`         shift 0 — the offsets already point where the data is. The stub was
 *                  accounted for when the archive was built. Not a fault.
 *  - `PREPENDED`   shift > 0 — bytes were added to an archive that was already finished,
 *                  so its index was never rewritten. This is the state worth reporting.
 *  - `HEAD_LOST`   shift < 0 — bytes are missing from the front; the index survived them.
 *  - `UNEXPLAINED` no single shift fits, or the probe could not run. Says so, claims nothing.
 */
const LEADING = { SFX: 'SFX', PREPENDED: 'PREPENDED', HEAD_LOST: 'HEAD_LOST', UNEXPLAINED: 'UNEXPLAINED' };

function leadingBytesState(prepend, warnings) {
  // A proven non-zero shift stands on its own evidence and needs no help from the
  // signature check. It has to: bytes removed from the head can land exactly on a local
  // header, leaving a file that *does* start with a ZIP signature and still has every
  // offset in its index wrong by the same amount.
  if (prepend && prepend.attempted === true && prepend.proven && prepend.shiftBytes !== 0) {
    return prepend.shiftBytes > 0 ? LEADING.PREPENDED : LEADING.HEAD_LOST;
  }
  // Everything else here is about a file whose first bytes are not a ZIP signature. With
  // the signature where it belongs and no shift proven, there is nothing to explain.
  if (!warnings.some((w) => /prepended|does not begin with a ZIP signature/.test(w))) return null;
  if (!prepend || prepend.attempted !== true || !prepend.proven) return LEADING.UNEXPLAINED;
  return LEADING.SFX;
}

export const METHOD_NAMES = {
  0: 'Stored', 1: 'Shrunk', 6: 'Imploded', 8: 'Deflate', 9: 'Deflate64',
  12: 'BZIP2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 98: 'PPMd',
};

/**
 * Classify the cause from facts already established during analysis.
 *
 * This adds no new parsing and makes no new claim — every input here was computed and
 * cross-checked earlier in the pass. It only decides which of the known faults is the
 * one worth telling the user about first.
 *
 * The ordering matters and is deliberate: a failed checksum outranks a missing index,
 * because corrupted content is a worse fact about the data than a missing table of
 * contents, even though the missing index looks more alarming in a file manager.
 */
export function diagnose({ eocd, cdStatus, cd, entries, counts, reader, warnings, zip64, prepend, format }) {
  const evidence = [];
  const leading = leadingBytesState(prepend, warnings);
  const plural = (n) => (n === 1 ? 'y' : 'ies');
  const truncatedEntries = entries.filter((e) =>
    (e.reasons || []).some((r) => /past the end of the file|is truncated/.test(r)));
  const encrypted = entries.filter((e) => e.encrypted);
  // A method this build does not decode is a gap in the tool, not damage in the file —
  // reported separately from encryption because the remedy is different.
  // Undecodable entries keep STRUCTURALLY_VALID — their structure is fine, only the CRC
  // could not be recomputed. Detect them by the missing CRC plus a codec this build has
  // no decoder for, so an entry skipped merely for being huge is not misreported.
  const DECODABLE = new Set([0, 8]);
  const unsupported = entries.filter((e) =>
    !e.encrypted && e.crcChecked === false && !DECODABLE.has(e.method));

  // A checksum that failed on data actually read is the one fact a proven offset shift
  // cannot explain away, so it is what separates the two branches below.
  const crcFailures = entries.filter((e) => e.crcChecked && !e.crcOk);
  const shiftProven = leading === LEADING.PREPENDED || leading === LEADING.HEAD_LOST;

  const label = (id) => (FORMATS[id] && FORMATS[id].label) || id;

  let code;
  if (entries.length === 0) {
    if (eocd.found && eocd.entriesTotal === 0) {
      code = DIAGNOSIS.EMPTY;
    } else if (format && format.byContent && format.byContent !== 'zip') {
      // The file is not broken, it is something else. Saying "no ZIP structure was found"
      // here is true and useless; naming what the bytes actually are is the whole answer,
      // and it is why the format table is consulted for every file rather than only for
      // the ones that fail.
      code = DIAGNOSIS.OTHER_FORMAT;
      evidence.push(`the file's own signature identifies it as a ${label(format.byContent)}`);
      if (format.agreement === 'mismatch') {
        evidence.push(`its name claims a ${label(format.byName)} — the name is wrong, the bytes are not`);
      }
      // Where that signature came from. A rule taken from a specification and never checked
      // against a real file of that format is still worth acting on — but a person deserves
      // to know which kind of answer they just got, especially when it surprises them.
      if (format.provenance === 'documented') {
        evidence.push('this signature comes from published documentation and has not been checked here against a real file of that format');
        if (format.caveat) evidence.push(format.caveat);
      }
    } else {
      code = DIAGNOSIS.NOT_A_ZIP;
      if (format && format.agreement === 'name-only') {
        // The most informative shape there is: named like an archive, with nothing at the
        // start to confirm it. That is what a destroyed header looks like.
        evidence.push(`named like a ${label(format.byName)}, but no signature of that format is present`);
        evidence.push('a destroyed or overwritten header looks exactly like this');
      } else {
        evidence.push('the first bytes match no format this tool can name');
      }
    }
  } else if (shiftProven && crcFailures.length === 0) {
    // A measured shift outranks everything below that the shift itself accounts for: an
    // entry whose local header is not at the declared offset, an index that looks damaged,
    // an offset that points past the end of the file. Those are one fact — the archive
    // moved and its index did not — and reporting them as content damage is exactly how a
    // self-extracting archive used to be called corrupt here.
    if (leading === LEADING.PREPENDED) {
      code = DIAGNOSIS.PREPENDED_DATA;
      evidence.push(`${prepend.shiftBytes} bytes sit in front of an archive that was already finished`);
      evidence.push('every entry moved by exactly that much, and the index was never rewritten to match');
      evidence.push(`${prepend.supported} of ${prepend.records} directory record${prepend.records === 1 ? '' : 's'} confirmed against the local header it points to`);
    } else {
      code = DIAGNOSIS.HEAD_TRUNCATED;
      evidence.push(`${-prepend.shiftBytes} bytes are missing from the start of the file`);
      evidence.push(`the index survived and still describes ${prepend.records} entr${plural(prepend.records)}`);
    }
  } else if (counts.damaged > 0 && truncatedEntries.length === 0) {
    code = DIAGNOSIS.CONTENT_CORRUPT;
    // `counts.damaged` also holds entries that could not be located at all, which never
    // reached a checksum. Saying they "failed a CRC-32 check" would be a claim the tool
    // never made a measurement for.
    if (crcFailures.length === counts.damaged) {
      evidence.push(`${counts.damaged} entr${plural(counts.damaged)} failed a CRC-32 check`);
    } else {
      evidence.push(`${counts.damaged} entr${plural(counts.damaged)} could not be confirmed intact`);
      if (crcFailures.length) evidence.push(`${crcFailures.length} of them failed a CRC-32 check`);
    }
  } else if (truncatedEntries.length > 0) {
    code = DIAGNOSIS.TRUNCATED;
    evidence.push(`${truncatedEntries.length} entr${truncatedEntries.length === 1 ? 'y' : 'ies'} declare data past the end of the file`);
    evidence.push(`file is ${reader.size} bytes`);
  } else if (!eocd.found) {
    code = DIAGNOSIS.INDEX_MISSING;
    evidence.push('no end-of-central-directory record was found');
    evidence.push(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} located by scanning for local file headers`);
  } else if (cdStatus !== 'OK' || (cd && cd.truncated)) {
    code = DIAGNOSIS.INDEX_DAMAGED;
    evidence.push('the central directory could not be read completely');
    if (cd && cd.errors && cd.errors.length) evidence.push(cd.errors[0]);
  } else if (zip64 && zip64.present && zip64.usable === false) {
    // ZIP64 is how archives exceed 4 GiB. Present-but-unusable means the 64-bit records
    // are damaged, which is a structural fault and not a statement about the payload.
    code = DIAGNOSIS.ZIP64_UNUSABLE;
    evidence.push('ZIP64 records are present but could not be read');
  } else if (encrypted.length > 0 && counts.damaged === 0) {
    code = DIAGNOSIS.ENCRYPTED;
    const kinds = [...new Set(encrypted.map((e) => e.encryptionKind).filter((k) => k && k !== 'none'))];
    evidence.push(`${encrypted.length} encrypted entr${encrypted.length === 1 ? 'y' : 'ies'}`);
    if (kinds.length) evidence.push(`scheme: ${kinds.join(', ')}`);
  } else if (unsupported.length > 0 && counts.damaged === 0) {
    code = DIAGNOSIS.UNSUPPORTED_METHOD;
    const methods = [...new Set(unsupported.map((e) => e.methodName).filter(Boolean))];
    evidence.push(`${unsupported.length} entr${unsupported.length === 1 ? 'y' : 'ies'} use a method this check does not decode`);
    if (methods.length) evidence.push(methods.join(', '));
  } else if (leading === LEADING.SFX) {
    code = DIAGNOSIS.SELF_EXTRACTING;
    evidence.push('the file does not begin with a ZIP signature');
    evidence.push('every central-directory offset already points where its data actually is, so the leading bytes were part of the archive when it was built');
    const first = entries.find((e) => typeof e.localHeaderOffset === 'number' && e.localHeaderOffset > 0);
    if (first) evidence.push(`the archive body starts ${first.localHeaderOffset} bytes into the file`);
  } else if (leading === LEADING.UNEXPLAINED) {
    code = DIAGNOSIS.UNIDENTIFIED_HEADER;
    evidence.push('the file does not begin with a ZIP signature');
    if (!prepend || prepend.attempted !== true) {
      evidence.push(`what the leading bytes are was not measured${prepend && prepend.reason ? ` — ${prepend.reason}` : ''}`);
    } else {
      evidence.push('no single offset shift explains the surviving directory records, so the leading bytes are not a stub the archive was built around');
      if (prepend.rejection) evidence.push(prepend.rejection);
    }
  } else {
    code = DIAGNOSIS.INTACT;
  }

  // Whether the DATA is believed intact, independently of the structure. This is the
  // distinction the whole feature exists to make.
  // SELF_EXTRACTING belongs here and HEAD_TRUNCATED does not: a stub the archive was built
  // around costs nothing, while bytes missing from the front are bytes that are gone.
  const dataLooksIntact = code === DIAGNOSIS.INTACT
    || code === DIAGNOSIS.SELF_EXTRACTING
    || code === DIAGNOSIS.ENCRYPTED
    || code === DIAGNOSIS.UNSUPPORTED_METHOD
    || code === DIAGNOSIS.INDEX_MISSING
    || code === DIAGNOSIS.INDEX_DAMAGED
    || code === DIAGNOSIS.PREPENDED_DATA
    || code === DIAGNOSIS.UNIDENTIFIED_HEADER;

  return { code, evidence, dataLooksIntact, verifiedEntries: counts.verified, totalEntries: entries.length };
}

/* -------------------------------------------------------------------- crc32 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ helpers */

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
// ZIP64 fields are 64-bit. JS numbers hold integers exactly to 2^53, far beyond
// any file a browser can open, so a Number is safe here — but the high word is
// still range-checked rather than silently truncated.
function u64(b, o) {
  const lo = u32(b, o), hi = u32(b, o + 4);
  if (hi > 0x001fffff) return Number.MAX_SAFE_INTEGER; // implausible; caller rejects
  return hi * 0x100000000 + lo;
}

const throwIfAborted = (signal) => {
  if (signal && signal.aborted) {
    const e = new Error('Analysis cancelled');
    e.name = 'AbortError';
    throw e;
  }
};

// Filenames are untrusted. This never decides layout or is passed to the DOM as
// markup — the UI escapes it again — but obviously-hostile shapes are flagged.
function inspectName(raw) {
  const flags = [];
  if (raw.indexOf('\u0000') !== -1) flags.push('contains NUL');
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) flags.push('absolute path');
  if (raw.split(/[\\/]/).includes('..')) flags.push('path traversal (..)');
  if (raw.includes('\\')) flags.push('backslash separator');
  if (raw.length > 255) flags.push('very long name');
  // eslint-disable-next-line no-control-regex
  if (/[\u0001-\u001f\u007f]/.test(raw)) flags.push('control characters');
  return flags;
}

function decodeName(bytes, utf8Flag) {
  try {
    return new TextDecoder(utf8Flag ? 'utf-8' : 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '(undecodable name)';
  }
}

/* ------------------------------------------------------------ reader adapters */

export function readerFromArrayBuffer(buf) {
  const all = new Uint8Array(buf);
  return {
    size: all.length,
    async read(offset, length) {
      const s = Math.max(0, Math.min(all.length, offset));
      const e = Math.max(s, Math.min(all.length, offset + length));
      return all.subarray(s, e);
    },
  };
}

export function readerFromBlob(blob) {
  return {
    size: blob.size,
    async read(offset, length) {
      const s = Math.max(0, Math.min(blob.size, offset));
      const e = Math.max(s, Math.min(blob.size, offset + length));
      if (e <= s) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(s, e).arrayBuffer());
    },
  };
}

/* ------------------------------------------------------------------- EOCD */

async function findEocd(reader) {
  const size = reader.size;
  if (size < 22) return { found: false, reason: 'file is smaller than the 22-byte minimum EOCD record' };
  const span = Math.min(size, LIMITS.EOCD_SEARCH);
  const start = size - span;
  const tail = await reader.read(start, span);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) !== SIG.EOCD) continue;
    const commentLen = u16(tail, i + 20);
    // The record must end exactly at EOF for a well-formed archive; a shorter
    // comment than declared means the tail was cut.
    const declaredEnd = start + i + 22 + commentLen;
    return {
      found: true,
      offset: start + i,
      diskNumber: u16(tail, i + 4),
      cdDisk: u16(tail, i + 6),
      entriesThisDisk: u16(tail, i + 8),
      entriesTotal: u16(tail, i + 10),
      cdSize: u32(tail, i + 12),
      cdOffset: u32(tail, i + 16),
      commentLen,
      commentTruncated: declaredEnd > size,
      trailingBytes: declaredEnd < size ? size - declaredEnd : 0,
    };
  }
  return { found: false, reason: 'no end-of-central-directory signature (PK\\x05\\x06) in the last 64 KiB' };
}

async function findZip64(reader, eocdOffset) {
  if (eocdOffset < 20) return null;
  const b = await reader.read(eocdOffset - 20, 20);
  if (b.length < 20 || u32(b, 0) !== SIG.EOCD64_LOC) return null;
  const rel = u64(b, 8);
  if (rel >= reader.size) return { present: true, usable: false, reason: 'ZIP64 locator points past EOF' };
  const z = await reader.read(rel, 56);
  if (z.length < 56 || u32(z, 0) !== SIG.EOCD64) {
    return { present: true, usable: false, reason: 'ZIP64 EOCD record not found where the locator points' };
  }
  return {
    present: true, usable: true,
    entriesTotal: u64(z, 32), cdSize: u64(z, 40), cdOffset: u64(z, 48),
  };
}

/* -------------------------------------------------- central directory parse */

async function parseCentralDirectory(reader, cdOffset, cdSize, signal, onProgress) {
  const out = { entries: [], errors: [], truncated: false };
  if (cdOffset >= reader.size) {
    out.errors.push(`central directory offset ${cdOffset} is past the end of the file (${reader.size} bytes)`);
    return out;
  }
  const available = reader.size - cdOffset;
  const span = Math.min(cdSize > 0 ? cdSize : available, available);
  if (cdSize > available) {
    out.errors.push(`central directory declares ${cdSize} bytes but only ${available} remain in the file`);
    out.truncated = true;
  }
  const buf = await reader.read(cdOffset, span);
  let p = 0;
  while (p + 46 <= buf.length) {
    throwIfAborted(signal);
    if (u32(buf, p) !== SIG.CDH) {
      out.errors.push(`central directory record ${out.entries.length + 1} has a bad signature at offset ${cdOffset + p}`);
      break;
    }
    const nameLen = u16(buf, p + 28), extraLen = u16(buf, p + 30), cmtLen = u16(buf, p + 32);
    if (nameLen > LIMITS.MAX_NAME || extraLen > LIMITS.MAX_EXTRA) {
      out.errors.push(`central directory record ${out.entries.length + 1} declares an implausible name/extra length`);
      break;
    }
    const total = 46 + nameLen + extraLen + cmtLen;
    if (p + total > buf.length) { out.truncated = true; break; }
    const flags = u16(buf, p + 8);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    out.entries.push({
      index: out.entries.length,
      name: decodeName(nameBytes, (flags & 0x800) !== 0),
      flags,
      method: u16(buf, p + 10),
      crc32: u32(buf, p + 16),
      compressedSize: u32(buf, p + 20),
      uncompressedSize: u32(buf, p + 24),
      localHeaderOffset: u32(buf, p + 42),
      hasDataDescriptor: (flags & 0x08) !== 0,
      encrypted: (flags & 0x01) !== 0 || (flags & 0x40) !== 0,
      // Which scheme, not just "encrypted". These differ in what a user can do next:
      // traditional PKWARE is weak and widely supported, strong/AES needs the original
      // tool. Method 99 is WinZip AES, which also sets bit 0 — so it is checked first.
      encryptionKind: u16(buf, p + 10) === 99 ? 'aes'
        : (flags & 0x40) !== 0 ? 'strong'
          : (flags & 0x01) !== 0 ? 'traditional' : 'none',
      zip64Sentinel: u32(buf, p + 20) === 0xffffffff || u32(buf, p + 24) === 0xffffffff
        || u32(buf, p + 42) === 0xffffffff,
    });
    if (out.entries.length >= LIMITS.MAX_ENTRIES) {
      out.errors.push(`stopped after ${LIMITS.MAX_ENTRIES} central directory records (limit)`);
      break;
    }
    p += total;
    if (onProgress && out.entries.length % 500 === 0) {
      onProgress({ phase: 'central-directory', done: p, total: buf.length });
    }
  }
  return out;
}

/* --------------------------------------------------- local file header scan */

// The recovery-relevant pass: local headers sit next to the data they describe,
// so they survive damage that destroys the index at the end of the file. This is
// what lets the tool say something useful about an archive that will not open.
async function scanLocalHeaders(reader, signal, onProgress) {
  const found = [];
  const size = reader.size;
  let carry = new Uint8Array(0);
  let base = 0;
  for (let off = 0; off < size; off += LIMITS.CHUNK) {
    throwIfAborted(signal);
    const chunk = await reader.read(off, LIMITS.CHUNK);
    if (chunk.length === 0) break;
    // 3-byte overlap so a signature straddling a chunk boundary is not missed.
    const buf = carry.length ? concat(carry, chunk) : chunk;
    const bufStart = carry.length ? base : off;
    for (let i = 0; i + 30 <= buf.length; i++) {
      if (u32(buf, i) !== SIG.LFH) continue;
      const abs = bufStart + i;
      const flags = u16(buf, i + 6);
      const nameLen = u16(buf, i + 26), extraLen = u16(buf, i + 28);
      if (nameLen > LIMITS.MAX_NAME || extraLen > LIMITS.MAX_EXTRA) continue;
      if (abs + 30 + nameLen + extraLen > size) continue;
      // The name may straddle the chunk; read it directly rather than guessing.
      found.push({
        offset: abs, flags,
        method: u16(buf, i + 8),
        crc32: u32(buf, i + 14),
        compressedSize: u32(buf, i + 18),
        uncompressedSize: u32(buf, i + 22),
        nameLen, extraLen,
        dataOffset: abs + 30 + nameLen + extraLen,
        hasDataDescriptor: (flags & 0x08) !== 0,
        encrypted: (flags & 0x01) !== 0 || (flags & 0x40) !== 0,
      });
      if (found.length >= LIMITS.MAX_ENTRIES) return { found, capped: true };
    }
    carry = buf.subarray(Math.max(0, buf.length - 3));
    base = bufStart + buf.length - carry.length;
    if (onProgress) onProgress({ phase: 'local-headers', done: Math.min(off + LIMITS.CHUNK, size), total: size });
  }
  // Fill in names with targeted reads (bounded, one per header).
  for (const h of found) {
    throwIfAborted(signal);
    const nb = await reader.read(h.offset + 30, h.nameLen);
    h.name = decodeName(nb, (h.flags & 0x800) !== 0);
  }
  return { found, capped: false };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

/* ----------------------------------------------------------- CRC verification */

// Returns { checked:boolean, ok:boolean, reason:string, bytes:number }
async function verifyCrc(reader, entry, signal) {
  const { method, dataOffset, compressedSize, crc32: expected, encrypted } = entry;
  if (encrypted) return { checked: false, ok: false, reason: 'entry is encrypted' };

  // An entry whose sizes are ZERO is one of two very different things, and the
  // difference decides whether it can be verified at all.
  //
  //  * Streamed (general-purpose bit 3): the header's sizes are placeholders and
  //    the real values follow the data. Nothing is known from the header, so
  //    nothing can be checked.
  //
  //  * Genuinely empty: the archive declares a zero-length entry. Reading its
  //    (empty) range gives zero bytes, and CRC-32 of zero bytes is 0 — which is
  //    exactly what such an entry stores. That is a COMPLETE check, not a vacuous
  //    one: the entry's content is fully determined by its declared length, and
  //    there is no further byte to be wrong about. A zero-length entry that
  //    declares a non-zero CRC is a genuine contradiction and fails below.
  //
  // Treating both as unverifiable, as this code originally did, left a correct
  // empty file permanently unverified — and therefore permanently unextractable.
  if (entry.hasDataDescriptor && compressedSize === 0 && entry.uncompressedSize === 0) {
    return { checked: false, ok: false, reason: 'sizes are recorded after the data (streamed entry), so nothing can be checked from the header' };
  }
  if (compressedSize === 0 && entry.uncompressedSize === 0) {
    return {
      checked: true,
      ok: expected === 0,
      reason: expected === 0
        ? 'the entry is empty and stores the CRC-32 of no bytes (0), which is what it contains'
        : `the entry declares zero length but a non-zero CRC-32 (${expected >>> 0})`,
      bytes: 0,
    };
  }
  if (compressedSize === 0) {
    return { checked: false, ok: false, reason: 'the entry declares zero compressed bytes but a non-zero length' };
  }
  if (dataOffset + compressedSize > reader.size) {
    return { checked: false, ok: false, reason: 'entry data extends past the end of the file' };
  }
  if (compressedSize > LIMITS.MAX_CRC_BYTES) {
    return { checked: false, ok: false, reason: 'entry larger than the CRC verification limit' };
  }

  if (method === 0) {
    let crc = 0, read = 0;
    while (read < compressedSize) {
      throwIfAborted(signal);
      const n = Math.min(LIMITS.CHUNK, compressedSize - read);
      const b = await reader.read(dataOffset + read, n);
      if (b.length === 0) break;
      crc = crc32Update(crc, b);
      read += b.length;
    }
    if (read !== compressedSize) {
      return { checked: false, ok: false, reason: 'could not read the whole entry', bytes: read };
    }
    return { checked: true, ok: crc === expected, reason: crc === expected ? 'stored data CRC-32 matches' : 'stored data CRC-32 does not match', bytes: read };
  }

  if (method === 8) {
    if (typeof DecompressionStream === 'undefined') {
      return { checked: false, ok: false, reason: 'raw DEFLATE decoding unavailable in this browser' };
    }
    try {
      // Native browser decoder — no third-party library. The output is CRC'd
      // chunk by chunk and never accumulated, so a bomb cannot exhaust memory.
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const readerStream = ds.readable.getReader();
      let crc = 0, outBytes = 0, failed = null;

      const pump = (async () => {
        for (;;) {
          const { done, value } = await readerStream.read();
          if (done) break;
          crc = crc32Update(crc, value);
          outBytes += value.length;
          if (outBytes > LIMITS.MAX_CRC_BYTES) { failed = 'decompressed output exceeded the safety limit'; break; }
        }
      })();

      let pos = 0;
      try {
        while (pos < compressedSize) {
          throwIfAborted(signal);
          const n = Math.min(LIMITS.CHUNK, compressedSize - pos);
          const b = await reader.read(dataOffset + pos, n);
          if (b.length === 0) break;
          await writer.write(b);
          pos += b.length;
        }
        await writer.close();
      } catch (e) {
        try { await writer.abort(); } catch { /* already errored */ }
        failed = failed || e.message;
      }
      await pump.catch((e) => { failed = failed || e.message; });

      if (failed) return { checked: false, ok: false, reason: `DEFLATE stream did not decode (${String(failed).slice(0, 80)})`, bytes: outBytes };
      const sizeOk = entry.uncompressedSize === 0 || entry.uncompressedSize === outBytes;
      return {
        checked: true,
        ok: crc === expected && sizeOk,
        reason: crc !== expected ? 'decompressed CRC-32 does not match'
          : !sizeOk ? `decompressed to ${outBytes} bytes, header declares ${entry.uncompressedSize}`
            : 'decompressed data CRC-32 matches',
        bytes: outBytes,
      };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return { checked: false, ok: false, reason: `DEFLATE decode failed (${String(e.message).slice(0, 80)})` };
    }
  }

  return { checked: false, ok: false, reason: `compression method ${method} (${METHOD_NAMES[method] || 'unknown'}) is not decoded by this tool` };
}

/* ----------------------------------------------------------------- analysis */

/**
 * Analyse a ZIP archive.
 * @param {{size:number, read:(o:number,l:number)=>Promise<Uint8Array>}} reader
 * @param {{verifyCrc?:boolean, fileName?:string}} options
 * @param {(p:{phase:string,done:number,total:number,message?:string})=>void} onProgress
 * @param {AbortSignal} signal
 */
export async function analyzeArchive(reader, options = {}, onProgress = () => {}, signal = undefined) {
  const t0 = Date.now();
  const doCrc = options.verifyCrc !== false;
  const warnings = [];
  const limitations = [];

  throwIfAborted(signal);
  onProgress({ phase: 'start', done: 0, total: 1 });

  // One bounded prefix read serves both questions: the ZIP signature at offset 0, and the
  // format table, whose furthest rule is ISO 9660's descriptor at 32769.
  const head = await reader.read(0, Math.min(REQUIRED_PREFIX, reader.size));
  const headSig = head.length >= 4 ? u32(head, 0) : 0;
  const looksZip = headSig === SIG.LFH || headSig === SIG.EOCD || headSig === SIG.CDH || headSig === 0x08074b50;

  // A second bounded read, from the end. Some formats keep their only identity in a footer
  // — a fixed-size VHD, a DMG's UDIF trailer, a Macrium image — so a head-only table cannot
  // name them at all. 512 bytes, regardless of how large the file is.
  const tail = reader.size > REQUIRED_SUFFIX
    ? await reader.read(reader.size - REQUIRED_SUFFIX, REQUIRED_SUFFIX)
    : head;

  // What the file is, and separately what its name claims. Never merged: a RAR named .zip
  // and a .zip whose header was destroyed both fail every ZIP check, and the advice for
  // them is opposite. `format.provenance` carries how the signature came to be believed,
  // which must reach the user rather than being flattened into the answer.
  const format = identification(bytesOf(head, tail, reader.size), options.fileName || '');

  // All state `finish()` reads is declared before the first early return, so an
  // early exit cannot hit a temporal dead zone.
  let eocd = { found: false, reason: 'not examined' };
  let zip64 = null;
  let cd = { entries: [], errors: [], truncated: false };
  let cdStatus = 'MISSING';
  let scan = { found: [], capped: false };
  let entries = [];
  let prepend = null;
  let counts = { total: 0, verified: 0, structurallyValid: 0, potentiallyRecoverable: 0, damaged: 0, unknown: 0 };
  let recoverableBytes = 0;
  let crcCoverage = 0;

  if (reader.size === 0) {
    return finish({ verdict: 'NOT_A_ZIP', reason: 'the file is empty' });
  }

  /* ---- EOCD ---- */
  onProgress({ phase: 'eocd', done: 0, total: 1 });
  eocd = await findEocd(reader);
  zip64 = eocd.found ? await findZip64(reader, eocd.offset) : null;

  if (!looksZip && !eocd.found) {
    return finish({
      verdict: 'NOT_A_ZIP',
      reason: 'no ZIP signature at the start of the file and no end-of-central-directory record',
      diagnosis: diagnose({ eocd, cdStatus, cd, entries, counts, reader, warnings, zip64, prepend, format }),
    });
  }
  if (!looksZip && eocd.found) {
    warnings.push('The file does not begin with a ZIP signature. It may have data prepended (a self-extracting stub or a corrupted header).');
  }
  if (eocd.found && eocd.trailingBytes > 0) {
    warnings.push(`${eocd.trailingBytes} byte(s) follow the end-of-central-directory record.`);
  }
  if (eocd.found && eocd.commentTruncated) {
    warnings.push('The archive comment declared in the EOCD extends past the end of the file — the tail is truncated.');
  }
  if (eocd.found && (eocd.diskNumber !== 0 || eocd.cdDisk !== 0)) {
    warnings.push('This looks like one part of a split/spanned archive. Analysis of a single part is incomplete.');
    limitations.push('Split/spanned archives are not reassembled by this tool.');
  }
  if (zip64 && zip64.present) {
    limitations.push(zip64.usable
      ? 'ZIP64 detected. Sizes are read from the ZIP64 record; entries above 4 GiB are not CRC-verified in the browser.'
      : `ZIP64 structures are present but unusable (${zip64.reason}).`);
  }

  /* ---- central directory ---- */
  if (eocd.found) {
    const cdOffset = zip64 && zip64.usable ? zip64.cdOffset : eocd.cdOffset;
    const cdSize = zip64 && zip64.usable ? zip64.cdSize : eocd.cdSize;
    onProgress({ phase: 'central-directory', done: 0, total: 1 });
    cd = await parseCentralDirectory(reader, cdOffset, cdSize, signal, onProgress);
    const expected = zip64 && zip64.usable ? zip64.entriesTotal : eocd.entriesTotal;
    // An archive that legitimately holds nothing has an empty central directory;
    // that is a healthy state, not a damaged one.
    if (cd.entries.length === 0 && expected === 0 && cd.errors.length === 0) cdStatus = 'OK';
    else if (cd.entries.length === 0) cdStatus = 'DAMAGED';
    else if (cd.errors.length || cd.truncated || cd.entries.length !== expected) cdStatus = 'PARTIAL';
    else cdStatus = 'OK';
    if (cd.entries.length !== expected) {
      warnings.push(`The EOCD declares ${expected} entries; ${cd.entries.length} central directory record(s) could be read.`);
    }
    cd.errors.forEach((e) => warnings.push(e));
  }

  /* ---- local header scan (always; this is the recovery view) ---- */
  onProgress({ phase: 'local-headers', done: 0, total: reader.size });
  scan = await scanLocalHeaders(reader, signal, onProgress);
  if (scan.capped) warnings.push(`Local-header scan stopped at ${LIMITS.MAX_ENTRIES} candidates (limit).`);

  const lfhByOffset = new Map(scan.found.map((h) => [h.offset, h]));

  /* ---- build the entry list ---- */
  entries = [];
  const seenLocalOffsets = new Set();
  const nameCount = new Map();

  // A stable identity per entry. Two entries can share a name, a size and even a
  // local-header offset, so anything that addresses one entry (extraction, an
  // operation record, a report row) needs an id that cannot collide. Index plus
  // header offset is unique by construction and deterministic, so re-analysing
  // the same bytes yields the same ids.
  const pushEntry = (e) => {
    nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);
    entries.push({ entryId: `e${entries.length}-${e.localHeaderOffset ?? 'x'}`, ...e });
  };

  // 1. entries the central directory knows about
  for (const c of cd.entries) {
    throwIfAborted(signal);
    const lfh = lfhByOffset.get(c.localHeaderOffset);
    const reasons = [];
    let status = STATUS.STRUCTURALLY_VALID;
    let source = 'central-directory';

    if (c.zip64Sentinel) reasons.push('ZIP64 sentinel values in the central directory');
    if (!lfh) {
      reasons.push(c.localHeaderOffset >= reader.size
        ? `local header offset ${c.localHeaderOffset} is past the end of the file`
        : `no local file header found at the declared offset ${c.localHeaderOffset}`);
      status = STATUS.DAMAGED;
    } else {
      seenLocalOffsets.add(lfh.offset);
      if (lfh.name !== c.name) reasons.push(`name differs between local header ("${lfh.name}") and central directory ("${c.name}")`);
      if (lfh.method !== c.method) reasons.push(`compression method differs (local ${lfh.method}, central ${c.method})`);
      if (!c.hasDataDescriptor && lfh.crc32 !== c.crc32 && lfh.crc32 !== 0) {
        reasons.push('CRC-32 differs between local header and central directory');
      }
      const end = lfh.dataOffset + c.compressedSize;
      if (end > reader.size) {
        reasons.push(`entry data ends at ${end}, past the end of the file (${reader.size})`);
        status = STATUS.DAMAGED;
      }
    }

    const nameFlags = inspectName(c.name);
    if (nameFlags.length) reasons.push(`filename: ${nameFlags.join(', ')}`);

    if (c.encrypted) {
      status = STATUS.UNKNOWN;
      reasons.push('entry is encrypted — contents cannot be checked');
    }

    pushEntry({
      name: c.name, method: c.method, methodName: METHOD_NAMES[c.method] || `method ${c.method}`,
      compressedSize: c.compressedSize, uncompressedSize: c.uncompressedSize,
      localHeaderOffset: c.localHeaderOffset,
      dataOffset: lfh ? lfh.dataOffset : null,
      declaredCrc32: c.crc32, encrypted: c.encrypted,
      hasDataDescriptor: c.hasDataDescriptor,
      // The raw general-purpose bit flag. Carried through because bits 5, 6 and
      // 13 decide what may be done with the entry later, and re-deriving them
      // from booleans loses the ones nothing has needed yet.
      flags: c.flags,
      status, reasons, source,
      crcChecked: false, crcOk: false, crcReason: '',
      nameFlags,
    });
  }

  // 2. local headers the central directory does NOT cover — the recoverable set
  for (const h of scan.found) {
    if (seenLocalOffsets.has(h.offset)) continue;
    throwIfAborted(signal);
    const reasons = [];
    let status = STATUS.POTENTIALLY_RECOVERABLE;
    if (cdStatus === 'OK') {
      reasons.push('local header is not referenced by the central directory');
    } else {
      reasons.push('found by scanning for local file headers; the central directory does not describe it');
    }
    const end = h.dataOffset + h.compressedSize;
    if (h.compressedSize === 0 && h.hasDataDescriptor) {
      reasons.push('sizes are in a data descriptor after the data; the entry length is not known from the header alone');
      status = STATUS.UNKNOWN;
    } else if (end > reader.size) {
      reasons.push(`declared data range ends at ${end}, past the end of the file (${reader.size}) — the entry is truncated`);
      status = STATUS.DAMAGED;
    }
    if (h.encrypted) { status = STATUS.UNKNOWN; reasons.push('entry is encrypted — contents cannot be checked'); }
    const nameFlags = inspectName(h.name || '');
    if (nameFlags.length) reasons.push(`filename: ${nameFlags.join(', ')}`);

    pushEntry({
      name: h.name || '(unnamed)', method: h.method, methodName: METHOD_NAMES[h.method] || `method ${h.method}`,
      compressedSize: h.compressedSize, uncompressedSize: h.uncompressedSize,
      localHeaderOffset: h.offset, dataOffset: h.dataOffset,
      declaredCrc32: h.crc32, encrypted: h.encrypted,
      hasDataDescriptor: h.hasDataDescriptor,
      flags: h.flags,
      status, reasons, source: 'local-header-scan',
      crcChecked: false, crcOk: false, crcReason: '',
      nameFlags,
    });
  }

  /* ---- duplicates and overlaps ---- */
  for (const e of entries) {
    if ((nameCount.get(e.name) || 0) > 1) e.reasons.push('duplicate filename in this archive');
  }
  const ranges = entries
    .filter((e) => e.dataOffset != null && e.compressedSize > 0)
    .map((e) => ({ e, s: e.dataOffset, x: e.dataOffset + e.compressedSize }))
    .sort((a, b) => a.s - b.s);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].s < ranges[i - 1].x) {
      ranges[i].e.reasons.push('data range overlaps the previous entry');
      ranges[i - 1].e.reasons.push('data range overlaps the next entry');
    }
  }

  /* ---- CRC pass ---- */
  if (doCrc) {
    let done = 0;
    for (const e of entries) {
      throwIfAborted(signal);
      onProgress({ phase: 'crc', done, total: entries.length, message: e.name });
      done++;
      if (e.dataOffset == null || e.status === STATUS.DAMAGED) {
        e.crcReason = e.status === STATUS.DAMAGED ? 'skipped — entry already failed a structural check' : 'skipped — no data offset';
        continue;
      }
      const r = await verifyCrc(reader, {
        method: e.method, dataOffset: e.dataOffset, compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize, crc32: e.declaredCrc32, encrypted: e.encrypted,
        // Needed to tell a genuinely empty entry from a streamed one whose sizes
        // are merely placeholders. Omitting it made every empty entry look
        // streamed, and therefore unverifiable.
        hasDataDescriptor: e.hasDataDescriptor,
      }, signal);
      e.crcChecked = r.checked; e.crcOk = r.ok; e.crcReason = r.reason;
      if (r.checked && r.ok) {
        // Only a passing, independently recomputed CRC promotes an entry.
        if (e.status === STATUS.STRUCTURALLY_VALID || e.status === STATUS.POTENTIALLY_RECOVERABLE) {
          const contradicted = e.reasons.some((x) => /differs|overlap|past the end/.test(x));
          e.status = contradicted ? STATUS.STRUCTURALLY_VALID : STATUS.VERIFIED;
          e.reasons.push('CRC-32 recomputed from the archive data and matches the stored value');
        }
      } else if (r.checked && !r.ok) {
        e.status = STATUS.DAMAGED;
        e.reasons.push(r.reason);
      } else if (r.reason) {
        // Every status must carry its reason, including the recoverable-but-
        // unproven case: "why was this not verified?" is the whole question.
        e.reasons.push(`CRC not verified: ${r.reason}`);
      }
    }
  } else {
    limitations.push('CRC verification was disabled for this run.');
  }

  /* ---- counts and verdict ---- */
  const count = (s) => entries.filter((e) => e.status === s).length;
  counts = {
    total: entries.length,
    verified: count(STATUS.VERIFIED),
    structurallyValid: count(STATUS.STRUCTURALLY_VALID),
    potentiallyRecoverable: count(STATUS.POTENTIALLY_RECOVERABLE),
    damaged: count(STATUS.DAMAGED),
    unknown: count(STATUS.UNKNOWN),
  };
  recoverableBytes = entries
    .filter((e) => e.status === STATUS.POTENTIALLY_RECOVERABLE || e.status === STATUS.VERIFIED)
    .reduce((n, e) => n + (e.compressedSize || 0), 0);
  crcCoverage = entries.length ? entries.filter((e) => e.crcChecked).length / entries.length : 0;

  let verdict;
  if (entries.length === 0) {
    verdict = eocd.found && eocd.entriesTotal === 0 ? 'EMPTY_ARCHIVE' : 'NO_ENTRIES_FOUND';
  } else if (counts.damaged === 0 && counts.unknown === 0 && counts.potentiallyRecoverable === 0 && cdStatus === 'OK') {
    verdict = counts.verified === entries.length ? 'INTACT_VERIFIED' : 'INTACT_STRUCTURE';
  } else if (counts.verified + counts.structurallyValid + counts.potentiallyRecoverable > 0) {
    verdict = 'PARTIALLY_RECOVERABLE';
  } else if (counts.damaged === 0 && counts.unknown > 0) {
    // Encrypted or unsupported-codec entries are not evidence of damage; saying
    // "DAMAGED" here would be an overclaim in the opposite direction.
    verdict = 'UNDETERMINED';
  } else {
    verdict = 'DAMAGED';
  }

  if (!eocd.found) {
    limitations.push('No end-of-central-directory record was found, so the archive index is unavailable. Every entry below came from scanning for local file headers.');
  }
  if (crcCoverage < 1) {
    limitations.push('Entries whose CRC could not be recomputed are never reported as verified.');
  }
  limitations.push('A matching CRC-32 is evidence against accidental damage. It is not a cryptographic signature and does not prove the archive was not deliberately modified.');
  // Scoped to the analysis pass on purpose. Single-entry verified extraction is a
  // separate, explicit operation that never runs during analysis, so this sentence
  // must not read as a claim about the product as a whole.
  limitations.push('This analysis does not extract, repair or modify the archive. Extraction, where offered, is a separate action you choose.');

  /* ---- what the leading bytes are ---- */
  // Two situations are worth the whole-file read this costs, and no others. A file that
  // does not begin with a ZIP signature: something is in front of the archive and only a
  // shift measurement says what. And an index that would not resolve: "the central
  // directory could not be read" is what a shifted archive looks like from the inside, so
  // the probe is what turns that into a cause. An ordinary archive that parses cleanly
  // never gets here, and never loads the engine.
  //
  // The core stays plain JavaScript with no engine of its own: `options.probePrepended` is
  // how the worker hands the Rust measurement in, and without it the analysis is exactly
  // what it was before.
  const indexUnresolved = cdStatus !== 'OK' || (cd && cd.truncated);
  if (eocd.found && (!looksZip || indexUnresolved) && typeof options.probePrepended === 'function') {
    throwIfAborted(signal);
    onProgress({ phase: 'leading-bytes', done: 0, total: 1 });
    try {
      prepend = await options.probePrepended(reader);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      // A probe that fails must not fail the analysis it was meant to sharpen.
      prepend = { attempted: false, reason: String((e && e.message) || e).slice(0, 200) };
    }
  }

  return finish({ verdict, diagnosis: diagnose({ eocd, cdStatus, cd, entries, counts, reader, warnings, zip64, prepend, format }) });

  function finish(extra) {
    return {
      schema: 'veraqis-zip-check/1',
      generatedAt: new Date().toISOString(),
      tool: { name: 'VERAQIS browser ZIP integrity check', version: '1.0.0', engine: 'javascript' },
      file: {
        name: options.fileName || null,
        size: reader.size,
        startsWithZipSignature: looksZip,
        // What the bytes say and what the name claims, never merged. `agreement` is one of
        // match / mismatch / content-only / name-only / unknown — see format-id.js.
        format,
      },
      eocd: eocd.found
        ? {
          found: true, offset: eocd.offset, entriesDeclared: eocd.entriesTotal,
          centralDirectoryOffset: eocd.cdOffset, centralDirectorySize: eocd.cdSize,
          commentLength: eocd.commentLen, trailingBytes: eocd.trailingBytes,
        }
        : { found: false, reason: eocd.reason },
      zip64: zip64 || { present: false },
      centralDirectory: {
        status: cdStatus,
        recordsRead: cd.entries.length,
        truncated: cd.truncated,
        errors: cd.errors,
      },
      localHeaderScan: { candidatesFound: scan ? scan.found.length : 0, capped: scan ? scan.capped : false },
      // null when nothing was measured — no probe was supplied, or the archive parsed
      // cleanly from a proper ZIP signature and there was nothing to explain. Always
      // present as a field, so a reader can tell "never asked" from "asked and found
      // nothing" (`attempted: true` with no proven shift).
      prepend,
      counts,
      recoverableBytes,
      crcCoverage: Number(crcCoverage.toFixed(4)),
      entries,
      warnings,
      limitations,
      elapsedMs: Date.now() - t0,
      ...extra,
    };
  }
}

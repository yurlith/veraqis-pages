// VERAQIS Studio — single-entry verified extraction.
//
// One entry, already classified VERIFIED, produced as one local download and
// re-verified against the checksum the archive itself records. Nothing else:
// no rebuilt archive, no batch, no speculative recovery, no local-header-only
// salvage, no encrypted entry, no password.
//
// The design rule that decides everything else here:
//
//     EXTRACTED_VERIFIED means the CRC-32 was recomputed over EXACTLY the bytes
//     that become the download.
//
// That forbids the cheap version — CRC a streamed read, then hand back a fresh
// `File.slice()` Blob — because those are bytes read at a second point in time
// and a file can change underneath a browser between the two reads. So the
// produced bytes are accumulated once, and the accumulation is both what is
// checksummed and what is delivered. Accumulation costs memory, which is why
// policy.js caps the output size instead of pretending the cost is free.
//
// The plan the caller supplies is treated as a hypothesis. Every field that
// decides WHICH BYTES ARE READ is re-derived from the archive itself before a
// byte is produced, so a hand-edited project cannot redirect extraction at a
// range it was never entitled to.
//
// No DOM, no network, no storage. Runs in the worker.

import { Crc32, crcHex } from './crc32.js';
import { StudioError, ERR, EXTRACT_STAGE, toStudioError } from './errors.js';
import { DEFAULT_EXTRACTION_POLICY } from './policy.js';
import { sanitizeDownloadFilename } from './filename.js';
import { evaluateExtractionEligibility, OPERATION_STATUS } from './eligibility.js';
import { verifySourceBinding } from './project.js';
import { EXTRACT_PHASE } from './protocol.js';

export const EXTRACT_ENGINE_VERSION = '1.0.0';

const SIG_LFH = 0x04034b50;
const LFH_FIXED = 30;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * A known-answer test for the browser's raw-DEFLATE decoder.
 *
 * `new DecompressionStream('deflate-raw')` not throwing proves the constructor
 * exists, not that the decoder produces correct bytes for a ZIP payload. This is
 * 27 bytes of real raw DEFLATE with its expected output and CRC-32, so the probe
 * fails on a decoder that is present but wrong — including one that silently
 * treats the input as zlib-wrapped.
 */
export const DEFLATE_RAW_PROBE = {
  compressed: new Uint8Array([11, 115, 13, 114, 12, 244, 12, 86, 72, 73, 77, 203, 73, 44, 73,
    213, 45, 74, 44, 87, 40, 40, 202, 79, 74, 5, 0]),
  expectedText: 'VERAQIS deflate-raw probe',
  expectedBytes: 25,
  expectedCrc32: 0xc14330e6,
};

/** Run the known-answer test. Returns {ok, reason}. Never throws. */
export async function probeDeflateRaw() {
  if (typeof DecompressionStream === 'undefined') {
    return { ok: false, reason: 'DecompressionStream is not implemented in this browser' };
  }
  let ds;
  try { ds = new DecompressionStream('deflate-raw'); }
  catch (e) { return { ok: false, reason: `deflate-raw is not a supported format (${String(e && e.message).slice(0, 80)})` }; }
  try {
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    const crc = new Crc32();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crc.update(value);
      }
    })();
    await writer.write(DEFLATE_RAW_PROBE.compressed);
    await writer.close();
    await pump;
    if (crc.bytes !== DEFLATE_RAW_PROBE.expectedBytes) {
      return { ok: false, reason: `the decoder produced ${crc.bytes} bytes, expected ${DEFLATE_RAW_PROBE.expectedBytes}` };
    }
    if (crc.value !== DEFLATE_RAW_PROBE.expectedCrc32) {
      return { ok: false, reason: `the decoder produced the wrong bytes (CRC ${crcHex(crc.value)}, expected ${crcHex(DEFLATE_RAW_PROBE.expectedCrc32)})` };
    }
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: `the decoder failed on a known-good stream (${String(e && e.message).slice(0, 80)})` };
  }
}

/* --------------------------------------------------------------- readers */

/** Bounded reader over a Blob/File. Clamps; never allocates from a declared length. */
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

const abortIfCancelled = (signal, entryId, discarded) => {
  if (signal && signal.aborted) {
    throw new StudioError(ERR.CANCELLED, {
      stage: EXTRACT_STAGE.READ, entryId, outputDiscarded: discarded,
    });
  }
};

/* ------------------------------------------------- local-header re-validation */

/**
 * Re-read the local file header from the archive and check it against the plan.
 *
 * This is the step that makes a hand-edited project harmless. The plan says
 * "entry X lives at offset N and is M bytes"; this reads offset N out of the
 * real file and refuses unless the header found there is genuinely the header
 * for entry X. A project that points at a different range is a project that
 * describes a different file, so the failure is SOURCE_FILE_MISMATCH.
 *
 * @returns {Promise<{dataOffset:number, compressedSize:number, uncompressedSize:number,
 *                    crc32:number, method:number, flags:number, name:string}>}
 */
export async function readAndValidateLocalHeader(reader, plan) {
  const entryId = plan.entryId;
  const at = plan.localHeaderOffset;

  if (!Number.isFinite(at) || at < 0 || at + LFH_FIXED > reader.size) {
    throw new StudioError(ERR.ENTRY_RANGE_INVALID, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
      detail: `the local header offset ${at} is not inside the ${reader.size}-byte file`,
    });
  }

  const head = await reader.read(at, LFH_FIXED);
  if (head.length < LFH_FIXED || u32(head, 0) !== SIG_LFH) {
    throw new StudioError(ERR.SOURCE_FILE_MISMATCH, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
      detail: `no local file header signature at offset ${at}`,
    });
  }

  const flags = u16(head, 6);
  const method = u16(head, 8);
  const lfhCrc = u32(head, 14);
  const lfhCsize = u32(head, 18);
  const lfhUsize = u32(head, 22);
  const nameLen = u16(head, 26);
  const extraLen = u16(head, 28);
  const dataOffset = at + LFH_FIXED + nameLen + extraLen;

  // Encryption is refused here as well as in the gate. The gate reads the
  // project's view; this reads the file's.
  if ((flags & ((1 << 0) | (1 << 6))) !== 0) {
    throw new StudioError(ERR.ENCRYPTED_ENTRY_UNSUPPORTED, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
      detail: 'the local header sets an encryption flag',
    });
  }
  if ((flags & ((1 << 5) | (1 << 13))) !== 0) {
    throw new StudioError(ERR.UNSUPPORTED_ENTRY_FLAGS, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
      detail: `general-purpose flags 0x${flags.toString(16)} include a feature this release does not extract`,
    });
  }

  if (method !== plan.method) {
    throw new StudioError(ERR.SOURCE_FILE_MISMATCH, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
      detail: `the local header declares method ${method}; the analysis recorded ${plan.method}`,
    });
  }

  // The name proves this header belongs to the entry the user selected, not to
  // some other entry that happens to sit at the same offset in a swapped file.
  if (nameLen > 4096 || at + LFH_FIXED + nameLen > reader.size) {
    throw new StudioError(ERR.SOURCE_FILE_MISMATCH, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId, detail: 'the local header declares an implausible name length',
    });
  }
  const nameBytes = await reader.read(at + LFH_FIXED, nameLen);
  let name;
  try { name = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes); }
  catch { name = ''; }
  if (name !== plan.name) {
    throw new StudioError(ERR.SOURCE_FILE_MISMATCH, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
      detail: 'the local file header at that offset names a different entry',
    });
  }

  // Sizes and CRC. A local header may legitimately carry zeros when bit 3 is
  // set; when it carries values they must agree with the index, or the two
  // views of the archive disagree and neither can be preferred without guessing.
  const hasDescriptor = (flags & (1 << 3)) !== 0;
  const lfhCarriesValues = lfhCsize !== 0 || lfhUsize !== 0 || lfhCrc !== 0;

  if (hasDescriptor && !lfhCarriesValues) {
    throw new StudioError(ERR.DATA_DESCRIPTOR_AMBIGUOUS, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
      detail: 'the local header records the size after the data and carries no values of its own',
    });
  }
  // Compare whenever the header is SUPPOSED to be authoritative — which is every
  // entry without a data descriptor, including a legitimately empty one whose
  // three fields are all zero. Gating the comparison on "the header carries
  // non-zero values" would have silently skipped it for exactly that entry, and
  // would also have let a non-descriptor header full of zeros pass beside an
  // index that says otherwise.
  if (lfhCarriesValues || !hasDescriptor) {
    if (lfhCsize !== plan.compressedSize || lfhUsize !== plan.uncompressedSize || lfhCrc !== plan.crc32) {
      throw new StudioError(
        hasDescriptor ? ERR.DATA_DESCRIPTOR_AMBIGUOUS : ERR.SOURCE_FILE_MISMATCH,
        {
          stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
          detail: `local header (crc ${crcHex(lfhCrc)}, ${lfhCsize}/${lfhUsize} bytes) disagrees with the index (crc ${crcHex(plan.crc32)}, ${plan.compressedSize}/${plan.uncompressedSize} bytes)`,
        }
      );
    }
  }

  if (dataOffset + plan.compressedSize > reader.size) {
    throw new StudioError(ERR.ENTRY_RANGE_INVALID, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
      detail: `the entry's data would end at ${dataOffset + plan.compressedSize}, past the end of the ${reader.size}-byte file`,
    });
  }
  if (Number.isFinite(plan.dataOffset) && plan.dataOffset !== dataOffset) {
    throw new StudioError(ERR.SOURCE_FILE_MISMATCH, {
      stage: EXTRACT_STAGE.LOCAL_HEADER, entryId,
      detail: `the data begins at ${dataOffset}; the analysis recorded ${plan.dataOffset}`,
    });
  }

  return {
    dataOffset,
    compressedSize: plan.compressedSize,
    uncompressedSize: plan.uncompressedSize,
    crc32: plan.crc32,
    method, flags, name,
  };
}

/* ------------------------------------------------------------ the extractor */

/**
 * Extract one VERIFIED entry.
 *
 * @param {Blob|File} file       the source archive, opened read-only by the browser
 * @param {string} entryId       which entry (must match options.plan.entryId)
 * @param {object} options       { plan, project, capabilities, policy }
 * @param {object} callbacks     { onProgress(p), onAccepted(a) }
 * @param {AbortSignal} [abortSignal]
 * @returns {Promise<object>} the extraction result (see the fields below)
 */
export async function extractVerifiedEntry(file, entryId, options = {}, callbacks = {}, abortSignal = undefined) {
  const t0 = Date.now();
  const policy = options.policy || DEFAULT_EXTRACTION_POLICY;
  const capabilities = options.capabilities || {};
  const project = options.project || null;
  const plan = options.plan || null;
  const onProgress = typeof callbacks.onProgress === 'function' ? callbacks.onProgress : () => {};
  const onAccepted = typeof callbacks.onAccepted === 'function' ? callbacks.onAccepted : () => {};
  const warnings = [];
  const limitations = [];

  if (!plan || plan.entryId !== entryId) {
    throw new StudioError(ERR.INTERNAL_EXTRACTION_ERROR, {
      stage: EXTRACT_STAGE.ELIGIBILITY, entryId, detail: 'the extraction plan does not describe the requested entry',
    });
  }

  /* --- 1. the gate, re-run here and not merely on the button --------------- */
  onProgress({ phase: EXTRACT_PHASE.ELIGIBILITY, percent: 0 });
  const entry = project && Array.isArray(project.entries)
    ? project.entries.find((e) => e && e.entryId === entryId)
    : null;
  if (!entry) {
    throw new StudioError(ERR.INTERNAL_EXTRACTION_ERROR, {
      stage: EXTRACT_STAGE.ELIGIBILITY, entryId, detail: 'the entry is not present in the supplied project',
    });
  }
  const gate = evaluateExtractionEligibility(project, entry, capabilities, policy);
  if (!gate.eligible) {
    const first = gate.reasons[0] || { code: ERR.ENTRY_NOT_VERIFIED, message: 'not eligible' };
    throw new StudioError(first.code, {
      stage: EXTRACT_STAGE.ELIGIBILITY, entryId, detail: first.message,
    });
  }
  warnings.push(...gate.warnings);

  /* --- 2. is this the analysed file? -------------------------------------- */
  onProgress({ phase: EXTRACT_PHASE.BINDING, percent: 0 });
  const fingerprint = project.source && project.source.fingerprint;
  const binding = await verifySourceBinding(fingerprint, file);
  if (binding.match !== true) {
    throw new StudioError(ERR.SOURCE_FILE_MISMATCH, {
      stage: EXTRACT_STAGE.SOURCE_BINDING, entryId, detail: binding.reason,
    });
  }
  abortIfCancelled(abortSignal, entryId, false);

  /* --- 3. what do the actual bytes say? ------------------------------------ */
  onProgress({ phase: EXTRACT_PHASE.LOCAL_HEADER, percent: 0 });
  const reader = readerFromBlob(file);
  const header = await readAndValidateLocalHeader(reader, {
    entryId,
    localHeaderOffset: entry.localHeaderOffset,
    dataOffset: entry.dataOffset,
    name: entry.name,
    method: entry.method,
    crc32: entry.declaredCrc32,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
  });
  abortIfCancelled(abortSignal, entryId, false);

  const safe = sanitizeDownloadFilename(entry.name || '', policy);
  if (!safe.filename) {
    throw new StudioError(ERR.SAFE_FILENAME_FAILED, { stage: EXTRACT_STAGE.LOCAL_HEADER, entryId });
  }

  onAccepted({
    entryId,
    outputFilename: safe.filename,
    filenameModified: safe.modified,
    compressionMethod: header.method,
    compressedBytesTotal: header.compressedSize,
    outputBytesExpected: header.uncompressedSize,
    crcExpected: header.crc32,
    sourceFingerprint: binding.checks.join('+'),
  });

  /* --- 4. produce the bytes ------------------------------------------------ */
  const produced = header.method === 0
    ? await readStored(reader, header, policy, onProgress, abortSignal, entryId)
    : await readDeflate(reader, header, policy, onProgress, abortSignal, entryId);

  // Cancelled after the last chunk but before verification: the bytes exist but
  // were never confirmed, so they are dropped rather than kept "just in case".
  if (abortSignal && abortSignal.aborted) {
    produced.discard();
    throw new StudioError(ERR.CANCELLED, {
      stage: EXTRACT_STAGE.CHECKSUM, entryId, outputDiscarded: true,
    });
  }

  /* --- 5. the checks that decide whether anything is offered at all -------- */
  onProgress({ phase: EXTRACT_PHASE.CHECKSUM, percent: 100, outputBytesProduced: produced.bytes });

  if (produced.bytes !== header.uncompressedSize) {
    produced.discard();
    throw new StudioError(ERR.OUTPUT_SIZE_MISMATCH, {
      stage: EXTRACT_STAGE.CHECKSUM, entryId, outputDiscarded: true,
      detail: `produced ${produced.bytes} bytes; the archive declares ${header.uncompressedSize}`,
    });
  }
  if (produced.crc !== (header.crc32 >>> 0)) {
    produced.discard();
    throw new StudioError(ERR.CRC_MISMATCH, {
      stage: EXTRACT_STAGE.CHECKSUM, entryId, outputDiscarded: true,
      detail: `recomputed CRC-32 ${crcHex(produced.crc)} does not match the stored ${crcHex(header.crc32)}`,
    });
  }

  /* --- 6. only now does an output exist ------------------------------------ */
  onProgress({ phase: EXTRACT_PHASE.FINALIZING, percent: 100, outputBytesProduced: produced.bytes });
  let blob;
  try {
    // application/octet-stream on purpose: the browser must save this, never
    // render it. A verified output is bytes, not a document to be opened.
    blob = new Blob(produced.chunks, { type: 'application/octet-stream' });
  } catch (e) {
    produced.discard();
    throw new StudioError(ERR.BLOB_CREATION_FAILED, {
      stage: EXTRACT_STAGE.FINALIZE, entryId, outputDiscarded: true,
      detail: String(e && e.message).slice(0, 160),
    });
  }
  produced.release();   // the Blob owns the bytes now; drop our references

  if (blob.size !== header.uncompressedSize) {
    throw new StudioError(ERR.OUTPUT_SIZE_MISMATCH, {
      stage: EXTRACT_STAGE.FINALIZE, entryId, outputDiscarded: true,
      detail: `the prepared output is ${blob.size} bytes, expected ${header.uncompressedSize}`,
    });
  }

  const durationMs = Date.now() - t0;
  if (durationMs > policy.slowOperationWarnMs) {
    warnings.push(`This extraction took ${Math.round(durationMs / 1000)} s.`);
  }
  if (safe.modified) {
    limitations.push(`Saved as "${safe.filename}" rather than the archive path "${entry.name}".`);
  }
  limitations.push('A matching CRC-32 shows the extracted bytes are the bytes the archive recorded. It is not a cryptographic signature and does not establish authorship.');

  return {
    schema: 'veraqis-extraction/1',
    taskId: options.taskId || null,
    entryId,
    entryName: entry.name,
    // The evidence status is reported back unchanged. Extraction observes it; it
    // never edits it. This field existing, and being separate from
    // operationStatus below, is the whole point of the two-axis model.
    evidenceStatus: entry.status,
    operationStatus: OPERATION_STATUS.EXTRACTED_VERIFIED,
    sourceFingerprint: { match: binding.match, checks: binding.checks, reason: binding.reason },
    outputFilename: safe.filename,
    filenameModified: safe.modified,
    filenameReasons: safe.reasons,
    compressionMethod: header.method,
    compressedBytesRead: produced.compressedRead,
    outputBytesProduced: produced.bytes,
    expectedOutputBytes: header.uncompressedSize,
    crcExpected: header.crc32 >>> 0,
    crcActual: produced.crc >>> 0,
    crcExpectedHex: crcHex(header.crc32),
    crcActualHex: crcHex(produced.crc),
    crcMatch: true,
    durationMs,
    warnings,
    limitations,
    blob,
    engineVersion: EXTRACT_ENGINE_VERSION,
    policyVersion: policy.policyVersion,
  };
}

/* ---------------------------------------------------------- Store (method 0) */

async function readStored(reader, header, policy, onProgress, signal, entryId) {
  const chunks = [];
  const crc = new Crc32();
  let read = 0;
  let lastPost = 0;
  const total = header.compressedSize;

  // Stored means compressed size == uncompressed size by definition (APPNOTE
  // 4.4.8/4.4.9). A Stored entry that says otherwise is not a Stored entry.
  if (header.compressedSize !== header.uncompressedSize) {
    throw new StudioError(ERR.OUTPUT_SIZE_MISMATCH, {
      stage: EXTRACT_STAGE.READ, entryId,
      detail: `a stored entry declares ${header.compressedSize} compressed and ${header.uncompressedSize} uncompressed bytes`,
    });
  }
  if (total > policy.maxOutputBytes) {
    throw new StudioError(ERR.OUTPUT_LIMIT_EXCEEDED, { stage: EXTRACT_STAGE.READ, entryId });
  }

  while (read < total) {
    abortIfCancelled(signal, entryId, chunks.length > 0);
    const want = Math.min(policy.chunkBytes, total - read);
    const b = await reader.read(header.dataOffset + read, want);
    if (b.length === 0) {
      throw new StudioError(ERR.ENTRY_RANGE_INVALID, {
        stage: EXTRACT_STAGE.READ, entryId, outputDiscarded: true,
        detail: `the archive ended after ${read} of ${total} bytes`,
      });
    }
    crc.update(b);
    chunks.push(b);
    read += b.length;
    if (read > policy.maxOutputBytes) {
      throw new StudioError(ERR.DECOMPRESSION_LIMIT_EXCEEDED, {
        stage: EXTRACT_STAGE.READ, entryId, outputDiscarded: true,
        detail: `read ${read} bytes, above the ${policy.maxOutputBytes}-byte limit`,
      });
    }
    const now = Date.now();
    if (now - lastPost >= policy.progressIntervalMs || read === total) {
      lastPost = now;
      onProgress({
        phase: EXTRACT_PHASE.READING,
        compressedBytesRead: read, compressedBytesTotal: total,
        outputBytesProduced: read, outputBytesExpected: header.uncompressedSize,
        percent: total > 0 ? Math.round((read / total) * 100) : 100,
      });
    }
  }

  return makeProduced(chunks, crc, read);
}

/* -------------------------------------------------------- Deflate (method 8) */

async function readDeflate(reader, header, policy, onProgress, signal, entryId) {
  if (typeof DecompressionStream === 'undefined') {
    throw new StudioError(ERR.EXTRACTION_UNSUPPORTED, {
      stage: EXTRACT_STAGE.DECOMPRESS, entryId,
      detail: "this browser has no DecompressionStream('deflate-raw')",
    });
  }
  if (header.uncompressedSize > policy.maxOutputBytes) {
    throw new StudioError(ERR.OUTPUT_LIMIT_EXCEEDED, { stage: EXTRACT_STAGE.DECOMPRESS, entryId });
  }

  const chunks = [];
  const crc = new Crc32();
  let compressedRead = 0;
  let outBytes = 0;
  let lastPost = 0;
  let limitBreach = null;

  let ds;
  try { ds = new DecompressionStream('deflate-raw'); }
  catch (e) {
    throw new StudioError(ERR.EXTRACTION_UNSUPPORTED, {
      stage: EXTRACT_STAGE.DECOMPRESS, entryId, detail: String(e && e.message).slice(0, 120),
    });
  }

  const writer = ds.writable.getWriter();
  const outReader = ds.readable.getReader();

  // The output pump runs concurrently with the input feed. It enforces the
  // ceiling on ITS OWN count, not on the declared size, so a stream that lies
  // about how much it will produce is stopped by what it actually produces.
  const pump = (async () => {
    for (;;) {
      const { done, value } = await outReader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      outBytes += value.length;
      if (outBytes > header.uncompressedSize) {
        limitBreach = new StudioError(ERR.DECOMPRESSION_LIMIT_EXCEEDED, {
          stage: EXTRACT_STAGE.DECOMPRESS, entryId, outputDiscarded: true,
          detail: `the stream produced more than the declared ${header.uncompressedSize} bytes`,
        });
        break;
      }
      if (outBytes > policy.maxOutputBytes) {
        limitBreach = new StudioError(ERR.DECOMPRESSION_LIMIT_EXCEEDED, {
          stage: EXTRACT_STAGE.DECOMPRESS, entryId, outputDiscarded: true,
          detail: `the stream produced more than the ${policy.maxOutputBytes}-byte limit`,
        });
        break;
      }
      crc.update(value);
      chunks.push(value);
    }
  })();

  let feedError = null;
  try {
    while (compressedRead < header.compressedSize) {
      if (limitBreach) break;
      abortIfCancelled(signal, entryId, chunks.length > 0);
      const want = Math.min(policy.chunkBytes, header.compressedSize - compressedRead);
      const b = await reader.read(header.dataOffset + compressedRead, want);
      if (b.length === 0) {
        feedError = new StudioError(ERR.ENTRY_RANGE_INVALID, {
          stage: EXTRACT_STAGE.READ, entryId, outputDiscarded: true,
          detail: `the archive ended after ${compressedRead} of ${header.compressedSize} compressed bytes`,
        });
        break;
      }
      await writer.write(b);
      compressedRead += b.length;
      const now = Date.now();
      if (now - lastPost >= policy.progressIntervalMs) {
        lastPost = now;
        onProgress({
          phase: EXTRACT_PHASE.DECOMPRESSING,
          compressedBytesRead: compressedRead, compressedBytesTotal: header.compressedSize,
          outputBytesProduced: outBytes, outputBytesExpected: header.uncompressedSize,
          percent: header.compressedSize > 0
            ? Math.round((compressedRead / header.compressedSize) * 100) : 100,
        });
      }
    }
    if (feedError || limitBreach) {
      // Tear the stream down rather than closing it: closing would ask the
      // decoder to finish a stream we have decided not to trust.
      try { await writer.abort(); } catch { /* already errored */ }
      try { await outReader.cancel(); } catch { /* already closed */ }
    } else {
      await writer.close();
    }
  } catch (e) {
    try { await writer.abort(); } catch { /* already errored */ }
    try { await outReader.cancel(); } catch { /* already closed */ }
    await pump.catch(() => {});
    chunks.length = 0;
    if (e instanceof StudioError) throw e;
    throw new StudioError(ERR.DECOMPRESSION_FAILED, {
      stage: EXTRACT_STAGE.DECOMPRESS, entryId, outputDiscarded: true,
      detail: String(e && e.message).slice(0, 160),
    });
  }

  let pumpError = null;
  await pump.catch((e) => { pumpError = e; });

  if (limitBreach || feedError || pumpError) {
    chunks.length = 0;
    if (limitBreach) throw limitBreach;
    if (feedError) throw feedError;
    throw new StudioError(ERR.DECOMPRESSION_FAILED, {
      stage: EXTRACT_STAGE.DECOMPRESS, entryId, outputDiscarded: true,
      detail: String(pumpError && pumpError.message).slice(0, 160),
    });
  }

  return makeProduced(chunks, crc, compressedRead);
}

/* ------------------------------------------------------------------ helpers */

/**
 * The produced bytes plus the two ways of letting go of them.
 *
 * `discard()` is failure: the bytes are dropped and nothing is offered.
 * `release()` is success: the Blob has taken ownership, so our references go.
 * Both exist so the call sites read as decisions rather than as bookkeeping.
 */
function makeProduced(chunks, crc, compressedRead) {
  return {
    chunks,
    crc: crc.value,
    bytes: crc.bytes,
    compressedRead,
    discard() { chunks.length = 0; },
    release() { chunks.length = 0; },
  };
}

export { toStudioError };

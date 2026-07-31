// VERAQIS Studio — extraction safety policy, version 1.
//
// One versioned object. Every limit that governs extraction is here, with the
// measurement or the specification clause it comes from written next to it, so
// no number in this file is a guess. `policyVersion` is recorded in the
// operation record and in the report, which is what makes a past result
// re-interpretable.
//
// Nothing here is a preference. A user cannot raise these; §12 of the phase
// brief forbids a user override in this release.
//
// No DOM, no network, no storage.

export const EXTRACTION_POLICY_VERSION = 'veraqis-extraction-policy/1';

const MiB = 1048576;

/**
 * DEFLATE's proven maximum expansion.
 *
 * RFC 1951 §3.2.7 fixed-Huffman: the longest match is 258 bytes and its shortest
 * encoding is 7 (length) + 5 (distance) bits = the well-known 1032:1 ceiling that
 * zip-bomb literature quotes. A *real* DEFLATE stream therefore cannot exceed it.
 * A declared ratio above 1032:1 is not "suspiciously compressible data" — it is
 * proof that the declared sizes are internally inconsistent, so refusing it is a
 * correctness check rather than a heuristic. That distinction matters: it means
 * the guard has no false-positive class to trade against.
 */
export const DEFLATE_MAX_RATIO = 1032;

/**
 * Build the policy for this device.
 *
 * Two facts drive the output ceiling:
 *
 *  1. `EXTRACTED_VERIFIED` must mean "the CRC-32 was recomputed over *these exact
 *     bytes*". That forbids the cheap trick of CRC-ing a streamed read and then
 *     handing back a fresh `File.slice()` Blob — those are bytes read at a second
 *     point in time. So the produced bytes are accumulated and the accumulation
 *     is what is checksummed and what becomes the download. Accumulation costs
 *     memory, so the ceiling has to respect memory.
 *  2. Measured on this project's benchmark fixtures (see
 *     docs/web-studio/VERIFIED_EXTRACTION_BENCHMARKS.md): a 100 MB Store
 *     extraction completes in Chrome 150 / Edge 150 / Firefox 153 without a
 *     main-thread stall above 50 ms, because all of it runs in the worker and
 *     only the final Blob crosses the boundary.
 *
 * `navigator.deviceMemory` is absent in Firefox, which is why 4 GB is assumed
 * there — the same assumption `capabilities.sizePolicy` already makes, kept
 * identical on purpose so two limits never disagree about the same device.
 *
 * @param {object} caps result of capabilities.detect()
 */
export function extractionPolicy(caps = {}) {
  const memGB = caps.deviceMemoryGB || 4;
  // 32 MiB of extractable output per GB of reported memory, floored at 64 MiB so
  // a low-memory device can still extract an ordinary document, and capped at
  // 512 MiB so a 32 GB workstation does not invite a half-gigabyte JS allocation.
  const maxOutputBytes = Math.min(512 * MiB, Math.max(64 * MiB, memGB * 32 * MiB));

  return {
    policyVersion: EXTRACTION_POLICY_VERSION,

    /* --- what may be extracted ------------------------------------------- */
    // The evidence status an entry must already hold. One value, no list: this
    // release extracts VERIFIED entries and nothing else.
    requiredEvidenceStatus: 'VERIFIED',
    // ZIP compression methods this release can produce output for.
    // 0 = Stored (RFC/APPNOTE 4.4.5), 8 = Deflate (RFC 1951).
    supportedMethods: [0, 8],
    // Extraction binds to the analysed file by content, never by name. A project
    // whose fingerprint carries no content hash cannot be re-bound safely, so it
    // cannot extract. See docs/web-studio/VERIFIED_EXTRACTION_SECURITY.md.
    requireContentFingerprint: true,

    /* --- size and shape --------------------------------------------------- */
    maxOutputBytes,
    // Compressed input is normally <= output, but an incompressible DEFLATE
    // stream carries stored-block overhead, so allow a margin rather than a
    // false refusal on a legitimate entry.
    maxCompressedBytesRead: maxOutputBytes + 16 * MiB,
    maxCompressionRatio: DEFLATE_MAX_RATIO,
    // Above this the UI explains the cost before starting. Not a refusal.
    largeOutputWarnBytes: 64 * MiB,

    /* --- streaming and responsiveness ------------------------------------- */
    chunkBytes: 1 * MiB,          // matches the analysis reader's unit
    progressIntervalMs: 80,       // == protocol.PROGRESS_INTERVAL_MS
    cancelCheckEveryChunks: 1,    // cancellation is honoured at every chunk
    // A single extraction that runs longer than this is reported as slow in the
    // operation record. It is not aborted: slow is not unsafe.
    slowOperationWarnMs: 30000,

    /* --- output naming ---------------------------------------------------- */
    maxFilenameLength: 100,       // conservative across Windows/macOS/Linux + browser download UI
    fallbackFilename: 'veraqis-extracted-file.bin',
    // A single-file download is always flattened to a basename: a browser
    // download must never be able to address a directory.
    flattenDirectories: true,

    /* --- lifecycle --------------------------------------------------------- */
    // A prepared output that is never downloaded is revoked after this long.
    blobUrlTtlMs: 120000,
    // Grace period between click and revoke, so revoking cannot cancel the
    // download the click just started.
    blobUrlRevokeDelayMs: 20000,
    // One extraction at a time. Concurrency would make "which output is this?"
    // a question the UI has to answer, and getting it wrong hands over the
    // wrong bytes.
    maxConcurrentExtractions: 1,

    basis: caps.deviceMemoryGB
      ? `navigator.deviceMemory = ${caps.deviceMemoryGB} GB`
      : 'navigator.deviceMemory unavailable (Firefox); assuming a 4 GB device',
  };
}

/** The policy used when no capability probe is available (tests, worker boot). */
export const DEFAULT_EXTRACTION_POLICY = extractionPolicy({});

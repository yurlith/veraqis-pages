// VERAQIS Studio — report builders.
//
// A report is a record of what was established. It carries entry names, sizes,
// offsets, checksum results, evidence statuses, the reasons behind them, what
// extraction was attempted and whether the output re-verified, and — new in
// this release — what verified batch exports were built, which entries they
// included, and, just as importantly, which entries were LEFT OUT and why.
//
// The exclusion list is not padding. An export that silently drops the entries
// it could not prove looks identical to one that had nothing to drop, and a
// reader deserves to tell those apart without rerunning the analysis.
//
// It carries NO data from inside the analysed files: no archive bytes, no
// decompressed content, no Blob URL, no device path. A test asserts that on
// every run, over both formats, using a canary string planted in the fixture.
//
// Pure: no DOM, no network, no storage. Extracted from app.js so it can be
// tested in Node rather than only through a browser.

import { crcHex } from './crc32.js';

export const REPORT_SCHEMA = 'veraqis-studio-report/3';

/** HTML-escape every interpolated value. Entry names are untrusted input. */
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The machine-readable report.
 *
 * Built by naming every field rather than by serialising the project, so a
 * future field cannot leak into a published artifact just by existing.
 */
export function buildJsonReport(project) {
  const a = project.analysis || {};
  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    generator: { name: project.generator, version: project.generatorVersion },
    source: {
      name: project.source.name,
      size: project.source.size,
      // The fingerprint MODE is reported; the hashes are not. Which method was
      // used is what a reader needs; the digest of someone's file is not.
      fingerprintMode: project.source.fingerprint ? project.source.fingerprint.mode : 'none',
    },
    analysis: {
      timestamp: a.timestamp || null,
      engine: a.engine || null,
      format: a.format || null,
      verdict: a.verdict || null,
      counts: a.counts || null,
      crcCoverage: a.crcCoverage ?? null,
      recoverableBytes: a.recoverableBytes ?? null,
      eocd: a.eocd || null,
      zip64: a.zip64 || null,
      centralDirectory: a.centralDirectory || null,
      localHeaderScan: a.localHeaderScan || null,
    },
    entries: (project.entries || []).map((e) => ({
      entryId: e.entryId,
      name: e.name,
      method: e.method,
      methodName: e.methodName,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
      localHeaderOffset: e.localHeaderOffset,
      declaredCrc32: e.declaredCrc32,
      declaredCrc32Hex: e.declaredCrc32 === null || e.declaredCrc32 === undefined ? null : crcHex(e.declaredCrc32),
      crcChecked: e.crcChecked,
      crcOk: e.crcOk,
      evidenceStatus: e.status,
      reasons: e.reasons,
    })),
    // The extraction ledger. Present and empty when nothing was extracted, so a
    // reader can tell "none attempted" from "this build did not record them".
    operations: (project.operations || []).map((o) => ({
      operationId: o.operationId,
      operationType: o.operationType,
      entryId: o.entryId,
      entryName: o.entryName,
      evidenceStatusAtStart: o.evidenceStatusAtStart,
      operationStatus: o.operationStatus,
      startedAt: o.startedAt,
      finishedAt: o.finishedAt,
      durationMs: o.durationMs,
      compressionMethod: o.compressionMethod,
      expectedSize: o.expectedSize,
      actualSize: o.actualSize,
      crcExpected: o.crcExpected,
      crcExpectedHex: o.crcExpected === null || o.crcExpected === undefined ? null : crcHex(o.crcExpected),
      crcActual: o.crcActual,
      crcActualHex: o.crcActual === null || o.crcActual === undefined ? null : crcHex(o.crcActual),
      crcMatch: o.crcMatch,
      outputFilename: o.outputFilename,
      filenameModified: o.filenameModified,
      sourceFingerprintMatch: o.sourceFingerprintMatch,
      engineVersion: o.engineVersion,
      policyVersion: o.policyVersion,
      errorCode: o.errorCode,
      warnings: o.warnings,
    })),
    // The batch export ledger. Same contract as `operations`: present and empty
    // when nothing was exported.
    batchOperations: (project.batchOperations || []).map((o) => ({
      operationId: o.operationId,
      operationType: o.operationType,
      planId: o.planId,
      planHash: o.planHash,
      operationStatus: o.operationStatus,
      startedAt: o.startedAt,
      finishedAt: o.finishedAt,
      durationMs: o.durationMs,
      engineVersion: o.engineVersion,
      writerVersion: o.writerVersion,
      policyVersion: o.policyVersion,
      sourceFingerprintMatch: o.sourceFingerprintMatch,
      includedCount: o.includedCount,
      excludedCount: o.excludedCount,
      outputName: o.outputName,
      outputSize: o.outputSize,
      // The digest of the archive VERAQIS itself produced, not of the user's
      // source file. It lets a reader confirm the artifact they hold is the one
      // this report describes; the source fingerprint stays out of the report.
      outputSha256: o.outputSha256,
      manifestName: o.manifestName,
      entryCount: o.entryCount,
      selfVerified: o.selfVerified,
      verificationSummary: o.verificationSummary,
      pathMappings: o.pathMappings || [],
      excludedEntries: o.excludedEntries || [],
      errorCode: o.errorCode,
      warnings: o.warnings,
    })),
    warnings: project.warnings || [],
    limitations: project.limitations || [],
    meaning: {
      VERIFIED: 'The entry was read, decompressed where needed, and its recomputed CRC-32 matched the value stored in the archive.',
      EXTRACTED_VERIFIED: 'A local copy of this entry was produced in the browser and its CRC-32, recomputed over exactly those bytes, matched the value the archive records. It does not establish authorship and is not a cryptographic authenticity guarantee.',
      BATCH_EXPORT_VERIFIED: 'A new archive was built in the browser from entries that were VERIFIED at export time, each entry’s CRC-32 was recomputed over exactly the bytes written, and the finished archive was then re-parsed by the analysis engine and every entry in it re-verified. It does not establish authorship and is not a cryptographic authenticity guarantee.',
    },
  };
}

/**
 * The standalone HTML report: no external resources, no scripts, and its own
 * `default-src 'none'` policy so it stays inert wherever it is opened.
 */
export function buildHtmlReport(project) {
  const p = project;
  const a = p.analysis;
  const c = a.counts || {};
  const rows = (p.entries || []).map((e) => `<tr><td>${esc(e.name)}</td><td>${esc(e.methodName)}</td>`
    + `<td>${esc(e.compressedSize)}</td><td>${esc(e.uncompressedSize)}</td>`
    + `<td>${e.crcChecked ? (e.crcOk ? 'matched' : 'mismatch') : 'not verified'}</td>`
    + `<td>${esc(e.status)}</td><td>${esc((e.reasons || []).join('; '))}</td></tr>`).join('\n');

  const ops = p.operations || [];
  const opRows = ops.map((o) => `<tr><td>${esc(o.entryName)}</td><td>${esc(o.evidenceStatusAtStart)}</td>`
    + `<td>${esc(o.operationStatus)}</td>`
    + `<td>${o.crcExpected === null || o.crcExpected === undefined ? '—' : esc(crcHex(o.crcExpected))}</td>`
    + `<td>${o.crcActual === null || o.crcActual === undefined ? '—' : esc(crcHex(o.crcActual))}</td>`
    + `<td>${o.crcMatch ? 'match' : 'no match'}</td>`
    + `<td>${o.actualSize === null || o.actualSize === undefined ? '—' : esc(o.actualSize)}</td>`
    + `<td>${esc(o.outputFilename || '—')}</td><td>${esc(o.errorCode || '')}</td></tr>`).join('\n');

  const opSection = ops.length === 0 ? '' : `
<h2>Extraction operations</h2>
<p class="note"><strong>EXTRACTED_VERIFIED</strong> means a local copy of that entry was produced in
the browser and its CRC-32, recomputed over exactly the bytes that were offered for download,
matched the value the archive records. It does <strong>not</strong> establish authorship and is not
a cryptographic authenticity guarantee. The evidence status of an entry is not changed by extracting
it.</p>
<table><thead><tr><th>Entry</th><th>Evidence status</th><th>Operation</th><th>CRC expected</th>
<th>CRC recomputed</th><th>Match</th><th>Bytes</th><th>Saved as</th><th>Error</th></tr></thead>
<tbody>${opRows}</tbody></table>
<p class="note">Engine ${esc(ops[0].engineVersion || '')} · policy ${esc(ops[0].policyVersion || '')}.
This report contains no extracted bytes.</p>`;

  const bops = p.batchOperations || [];
  const batchSection = bops.length === 0 ? '' : bops.map((b) => {
    const included = (b.pathMappings || []).map((m) => `<tr><td>${esc(m.originalPath)}</td>`
      + `<td>${esc(m.outputPath)}</td>`
      + `<td>${m.modified ? 'renamed for safety' : 'unchanged'}</td>`
      + `<td>${esc((m.reasons || []).join('; '))}</td></tr>`).join('\n');
    // Excluded entries are rendered even when the list is long: "why is my file
    // not in there" is the first question anyone asks of an export.
    const excluded = (b.excludedEntries || []).map((e) => `<tr><td>${esc(e.name)}</td>`
      + `<td>${esc(e.evidenceStatus)}</td><td>${esc((e.reasonCodes || []).join('; '))}</td></tr>`).join('\n');
    return `
<h2>Verified batch export</h2>
<dl><dt>Result</dt><dd>${esc(b.operationStatus)}${b.errorCode ? ' — ' + esc(b.errorCode) : ''}</dd>
<dt>Archive</dt><dd>${esc(b.outputName || '—')}${b.outputSize ? ' · ' + esc(b.outputSize) + ' bytes' : ''}</dd>
<dt>SHA-256 of the archive</dt><dd><code>${esc(b.outputSha256 || '—')}</code></dd>
<dt>Entries written</dt><dd>${esc(b.includedCount)} included · ${esc(b.excludedCount)} excluded</dd>
<dt>Re-verified after building</dt><dd>${b.selfVerified ? 'yes — the finished archive was re-parsed and every entry re-checked' : 'no'}</dd>
<dt>Plan</dt><dd><code>${esc(b.planId || '—')}</code> · hash <code>${esc(b.planHash || '—')}</code></dd></dl>
<p class="note"><strong>BATCH_EXPORT_VERIFIED</strong> means every entry in the new archive was
VERIFIED at the moment it was written, its CRC-32 was recomputed over exactly the bytes written, and
the finished archive was then re-parsed independently and every entry in it re-verified. The archive
was built from scratch: none of the original archive's central directory or end-of-central-directory
record was copied. It does <strong>not</strong> establish authorship and is not a cryptographic
authenticity guarantee.</p>
${included ? `<h3>Entries included</h3>
<table><thead><tr><th>Original path</th><th>Path in the new archive</th><th>Change</th><th>Why</th></tr></thead>
<tbody>${included}</tbody></table>` : ''}
${excluded ? `<h3>Entries left out</h3>
<p class="note">These were not written. Only entries with evidence status VERIFIED are eligible.</p>
<table><thead><tr><th>Entry</th><th>Evidence status</th><th>Reason</th></tr></thead>
<tbody>${excluded}</tbody></table>` : ''}
<p class="note">Engine ${esc(b.engineVersion || '')} · writer ${esc(b.writerVersion || '')} ·
policy ${esc(b.policyVersion || '')}. This report contains no exported bytes.</p>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>VERAQIS report — ${esc(p.source.name)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;line-height:1.55;color:#17211f}
table{width:100%;border-collapse:collapse;font-size:14px;margin:1rem 0}
th,td{border-bottom:1px solid #dbe4df;padding:8px;text-align:left;vertical-align:top;word-break:break-word}
th{font-size:12px;text-transform:uppercase;color:#5d6b67}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px}dt{color:#5d6b67}dd{margin:0}
.note{color:#5d6b67;font-size:13px}h1{font-size:22px}
</style></head><body>
<h1>VERAQIS analysis report</h1>
<p class="note">Generated by ${esc(p.generator)} ${esc(p.generatorVersion)} on ${esc(p.analysis.timestamp)}.
This report describes work performed entirely in a browser. No file was uploaded.</p>
<h2>Source</h2>
<dl><dt>File</dt><dd>${esc(p.source.name)}</dd>
<dt>Size</dt><dd>${esc(p.source.size)} bytes</dd>
<dt>Format</dt><dd>${esc(a.format ? a.format.label : '')}</dd>
<dt>Verdict</dt><dd>${esc(a.verdict)}</dd></dl>
<h2>Findings</h2>
<dl><dt>Entries</dt><dd>${esc(c.total)}</dd>
<dt>Verified</dt><dd>${esc(c.verified)}</dd>
<dt>Structurally valid</dt><dd>${esc(c.structurallyValid)}</dd>
<dt>Potentially recoverable</dt><dd>${esc(c.potentiallyRecoverable)}</dd>
<dt>Damaged</dt><dd>${esc(c.damaged)}</dd>
<dt>Unknown</dt><dd>${esc(c.unknown)}</dd>
<dt>CRC coverage</dt><dd>${Math.round((a.crcCoverage || 0) * 100)}%</dd></dl>
<h2>Entries</h2>
<table><thead><tr><th>Name</th><th>Method</th><th>Compressed</th><th>Uncompressed</th><th>CRC-32</th><th>Status</th><th>Reason</th></tr></thead>
<tbody>${rows}</tbody></table>${opSection}${batchSection}
<h2>Method and limits</h2>
<ul>${(p.limitations || []).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p class="note">An entry is VERIFIED only when its CRC-32 was recomputed from the archive's bytes and matched.
A matching CRC-32 is evidence against accidental damage; it is not a cryptographic signature.
This report contains no data from inside the analysed files.</p>
</body></html>`;
}

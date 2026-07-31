// VERAQIS Studio — message catalog.
//
// A lightweight i18n seam, not a framework: stable IDs, English default,
// `{name}` interpolation, and a `_plural` convention. It exists so UI strings
// stop being scattered through DOM code — the audit recorded that as debt D7.
//
// Documentation stays English; only the interface is catalogued.

const EN = {
  'app.name': 'VERAQIS Studio',
  'app.tagline': 'Private archive analysis in your browser',

  'privacy.local': 'Files stay on this device',
  'privacy.detail': 'No uploads, no account, no application backend. Your archive is read in this tab and is never modified.',

  'worker.starting': 'Starting the analysis engine…',
  'worker.ready': 'Engine ready',
  'worker.running': 'Analysing',
  'worker.idle': 'Idle',
  'worker.crashed': 'The engine stopped and was restarted',
  'worker.unavailable': 'The analysis engine is unavailable in this browser',
  'worker.versionMismatch': 'A newer version of Studio is available — reload to continue',

  'storage.memory': 'Not saved — this analysis disappears when you reload',
  'storage.durable': 'Saved on this device',
  'storage.unavailable': 'Local saving is unavailable in this browser',

  'action.analyze': 'Analyze a local archive',
  'action.chooseFile': 'Choose a file',
  'action.cancel': 'Cancel',
  'action.clear': 'Start over',
  'action.saveProject': 'Save project on this device',
  'action.deleteProject': 'Delete project',
  'action.exportProject': 'Export project file',
  'action.importProject': 'Import project file',
  'action.importReport': 'Import a diagnostic report',
  'action.downloadReport': 'Download report (JSON)',
  'action.downloadHtml': 'Download report (HTML)',
  'action.openProject': 'Open a local VERAQIS project',
  'action.reload': 'Reload safely',

  'state.noProjects': 'No saved projects on this device yet.',
  'state.analysing': 'Analysing {name}',
  'state.done': 'Analysis complete',

  'verdict.INTACT_VERIFIED': 'Archive intact',
  'verdict.INTACT_STRUCTURE': 'Structure intact',
  'verdict.PARTIALLY_RECOVERABLE': 'Partially readable',
  'verdict.DAMAGED': 'Damaged',
  'verdict.UNDETERMINED': 'Could not be determined',
  'verdict.EMPTY_ARCHIVE': 'Empty archive',
  'verdict.NO_ENTRIES_FOUND': 'No entries found',
  'verdict.NOT_A_ZIP': 'Not a ZIP archive',

  'status.VERIFIED': 'Verified',
  'status.STRUCTURALLY_VALID': 'Structurally valid',
  'status.POTENTIALLY_RECOVERABLE': 'Potentially recoverable',
  'status.DAMAGED': 'Damaged',
  'status.UNKNOWN': 'Unknown',

  'count.total': 'Entries found',
  'count.verified': 'Verified',
  'count.structurallyValid': 'Structurally valid',
  'count.potentiallyRecoverable': 'Potentially recoverable',
  'count.damaged': 'Damaged',
  'count.unknown': 'Unknown',

  'entries.showing': 'Showing {from}–{to} of {total}',
  'entries.page': 'Page {page} of {pages}',
  'entries.none': 'No entries with this status.',
  'entries.search': 'Search entry names',

  'fingerprint.mismatch': 'This is not the file this project was made from.',
  'fingerprint.weak': 'The size matches but the modification time differs.',

  // Extraction. Every label states the state it belongs to, because a button
  // whose text does not match what it will do is the defect §17 exists to stop.
  'extract.heading': 'Download a verified file',
  'extract.none': 'No entry is selected.',
  'extract.unavailable': 'Extraction unavailable',
  'extract.ready': 'Download verified file',
  'extract.running': 'Extracting…',
  'extract.cancel': 'Cancel extraction',
  'extract.cancelling': 'Cancelling…',
  'extract.download': 'Download verified output',
  'extract.again': 'Run extraction again',
  'extract.expired': 'This output has expired — run the extraction again',
  'extract.started': 'Extracting {name}.',
  'extract.half': 'Extraction half complete.',
  'extract.verified': 'Extraction verified. {bytes} bytes, checksum {crc} matches. Ready to download.',
  'extract.failed': 'Extraction failed. {reason}',
  'extract.cancelled': 'Extraction cancelled. Nothing was produced.',
  'extract.discarded': 'Any bytes produced before the failure were discarded. Nothing partial is offered as a download.',
  'extract.notDiscarded': 'Nothing was produced, and your archive was not modified.',
  'extract.crcMeaning': 'CRC confirms that the extracted bytes match the checksum recorded by the archive. CRC is not a cryptographic authenticity guarantee.',

  'operation.READY': 'Ready',
  'operation.EXTRACTING': 'Extracting',
  'operation.CANCELLING': 'Cancelling',
  'operation.EXTRACTED_VERIFIED': 'Extracted and verified',
  'operation.FAILED': 'Failed',
  'operation.CANCELLED': 'Cancelled',
  'operation.OUTPUT_EXPIRED': 'Output expired',

  'import.untrusted': 'Imported files are treated as untrusted: validated, never executed.',
  'import.downgraded': '{n} entry claimed VERIFIED without a matching checksum and was downgraded to UNKNOWN.',
  'import.downgraded_plural': '{n} entries claimed VERIFIED without a matching checksum and were downgraded to UNKNOWN.',
  'import.unknownFields': 'Ignored {n} unrecognised field from a newer version.',
  'import.unknownFields_plural': 'Ignored {n} unrecognised fields from a newer version.',

  'update.available': 'A new VERAQIS version is available',
  'update.notDuringAnalysis': 'The update will apply after the current analysis finishes.',

  'offline.ready': 'Studio is available offline',
  'offline.now': 'You are offline — Studio is running from its local copy',
};

let catalog = EN;

/**
 * @param {string} id
 * @param {Record<string,string|number>} [vars]
 * @param {number} [count] selects the `_plural` variant when not exactly 1
 */
export function t(id, vars = {}, count = undefined) {
  let key = id;
  if (count !== undefined && count !== 1 && catalog[`${id}_plural`]) key = `${id}_plural`;
  let s = catalog[key];
  if (s === undefined) s = EN[key] !== undefined ? EN[key] : id;
  return String(s).replace(/\{(\w+)\}/g, (m, k) => {
    if (k === 'n' && count !== undefined) return String(count);
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
  });
}

export function setLocale(messages) { catalog = { ...EN, ...(messages || {}) }; }
export function messageIds() { return Object.keys(EN); }

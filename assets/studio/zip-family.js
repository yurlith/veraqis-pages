// VERAQIS Studio — ZIP-family classification, shared by every ZIP engine.
//
// This lived inside engine.js and was therefore reachable only by the
// JavaScript engine. When wasmZipEngine went to the front of the REGISTRY it
// had no way to reach it, so its results carried no `format` at all and the UI
// showed an em dash where the detected format belongs. Splitting the table out
// is what lets both engines answer that question the same way.
//
// Detection only — a match here never implies semantic recovery of the
// Office/APK/EPUB layer, which is not implemented.

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

export const extOf = (name) => {
  const i = String(name || '').lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
};

/** Classify a ZIP by the names it contains. Detection only — no semantic claim. */
export function classifyZipFamily(fileName, entries) {
  const ext = extOf(fileName);
  const names = (entries || []).map((e) => e.name || '');
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

const NESTED = /\.(zip|jar|apk|docx|xlsx|pptx|epub|7z|rar|tar|gz)$/i;

/** Archives found inside an archive. Detected, never opened automatically. */
export function nestedArchivesOf(entries) {
  return (entries || [])
    .filter((e) => NESTED.test(e.name || ''))
    .map((e) => ({ name: e.name, size: e.compressedSize, status: e.status }));
}

// GENERATED — do not edit. Source of truth: crates/phx_format_id/src/lib.rs
// Regenerate: cargo run -p phx_format_id --example emit_js
//
// What a file actually is, decided from its bytes — and, kept separate, what its
// name claims. Those are different statements: a RAR named .zip and a .zip whose
// signature was destroyed both fail a ZIP check, and they need opposite advice.
//
// This is a copy of the table the recovery engine uses, generated from it rather
// than retyped, so the two cannot drift into telling a user different things about
// the same bytes.

/** The shortest prefix that can decide every rule below. */
export const REQUIRED_PREFIX = 32775;

/** Magic-byte rules, in order. First match wins — the order is the engine's.
 *  Do not sort. */
export const SIGNATURES = [
  { format: 'zip', offset: 0, minLen: 4, magic: [0x50, 0x4b, 0x03] },
  { format: 'zip', offset: 0, minLen: 4, magic: [0x50, 0x4b, 0x05] },
  { format: 'zip', offset: 0, minLen: 4, magic: [0x50, 0x4b, 0x07] },
  { format: 'gzip', offset: 0, minLen: 2, magic: [0x1f, 0x8b] },
  { format: 'sqlite', offset: 0, minLen: 16, magic: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00] },
  { format: 'pdf', offset: 0, minLen: 5, magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { format: 'bzip2', offset: 0, minLen: 3, magic: [0x42, 0x5a, 0x68] },
  { format: 'xz', offset: 0, minLen: 6, magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { format: 'zstd', offset: 0, minLen: 4, magic: [0x28, 0xb5, 0x2f, 0xfd] },
  { format: 'lz4', offset: 0, minLen: 4, magic: [0x04, 0x22, 0x4d, 0x18] },
  { format: '7z', offset: 0, minLen: 6, magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { format: 'rar', offset: 0, minLen: 7, magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { format: 'cab', offset: 0, minLen: 4, magic: [0x4d, 0x53, 0x43, 0x46] },
  { format: 'wim', offset: 0, minLen: 8, magic: [0x4d, 0x53, 0x57, 0x49, 0x4d, 0x00, 0x00, 0x00] },
  { format: 'qcow2', offset: 0, minLen: 4, magic: [0x51, 0x46, 0x49, 0xfb] },
  { format: 'tar', offset: 257, minLen: 263, magic: [0x75, 0x73, 0x74, 0x61, 0x72] },
  { format: 'iso9660', offset: 32769, minLen: 32775, magic: [0x43, 0x44, 0x30, 0x30, 0x31] },
];

/** Everything else worth saying about a format, keyed by its identifier. */
export const FORMATS = {
  zip: { label: 'ZIP archive', multiMember: true, extensions: ['.zip', '.jar', '.apk', '.docx', '.xlsx', '.pptx', '.epub', '.odt', '.ods'] },
  tar: { label: 'TAR archive', multiMember: true, extensions: ['.tar'] },
  iso9660: { label: 'ISO 9660 disc image', multiMember: true, extensions: ['.iso'] },
  gzip: { label: 'gzip stream', multiMember: false, extensions: ['.gz', '.tgz'] },
  sqlite: { label: 'SQLite database', multiMember: false, extensions: ['.db', '.sqlite', '.sqlite3'] },
  '7z': { label: '7-Zip archive', multiMember: true, extensions: ['.7z'] },
  rar: { label: 'RAR archive', multiMember: true, extensions: ['.rar'] },
  pdf: { label: 'PDF document', multiMember: false, extensions: ['.pdf'] },
  bzip2: { label: 'bzip2 stream', multiMember: false, extensions: ['.bz2'] },
  xz: { label: 'xz stream', multiMember: false, extensions: ['.xz'] },
  zstd: { label: 'Zstandard stream', multiMember: false, extensions: ['.zst', '.zstd'] },
  lz4: { label: 'LZ4 stream', multiMember: false, extensions: ['.lz4'] },
  cab: { label: 'Microsoft Cabinet archive', multiMember: true, extensions: ['.cab'] },
  wim: { label: 'Windows image (WIM)', multiMember: true, extensions: ['.wim'] },
  qcow2: { label: 'QCOW2 disk image', multiMember: false, extensions: ['.qcow2', '.qcow'] },
};

/** What the bytes say. `null` when nothing matched — a real answer, not a failure. */
export function identify(head) {
  for (const s of SIGNATURES) {
    if (head.length < s.minLen) continue;
    let hit = true;
    for (let i = 0; i < s.magic.length; i++) {
      if (head[s.offset + i] !== s.magic[i]) { hit = false; break; }
    }
    if (hit) return s.format;
  }
  return null;
}

/** What the name claims. The longest matching extension wins, so `.sqlite3` is not `.sqlite`. */
export function fromExtension(name) {
  const lower = String(name || '').toLowerCase();
  let best = null;
  for (const [id, meta] of Object.entries(FORMATS)) {
    for (const ext of meta.extensions) {
      if (lower.endsWith(ext) && (best === null || ext.length > best.len)) best = { len: ext.length, id };
    }
  }
  return best && best.id;
}

/**
 * Both answers, kept apart, plus how they relate:
 *
 *   match        both say the same thing
 *   mismatch     both spoke and disagree — renamed, or the wrong extension. Content wins.
 *   content-only the bytes identify it; the name says nothing
 *   name-only    the name claims a format the bytes do not confirm — usually a damaged
 *                signature, and the most useful thing there is to be able to say
 *   unknown      neither identifies anything
 */
export function identification(head, name) {
  const byContent = identify(head);
  const byName = fromExtension(name);
  let agreement;
  if (byContent && byName) agreement = byContent === byName ? 'match' : 'mismatch';
  else if (byContent) agreement = 'content-only';
  else if (byName) agreement = 'name-only';
  else agreement = 'unknown';
  return { byContent, byName, agreement, bestEffort: byContent || byName || null };
}

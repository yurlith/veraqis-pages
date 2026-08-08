// VERAQIS Studio — safe download filenames.
//
// A ZIP entry name is attacker-controlled. It is never handed to a download
// unchanged, because the download name is the one place where a crafted archive
// gets to influence the local filesystem.
//
// This module produces a BASENAME only. Directory structure is deliberately
// discarded: a single-file download has no business addressing a directory, so
// "../../../.ssh/authorized_keys" and "a/b/c.txt" both collapse to a leaf name.
// That makes traversal impossible by construction rather than by filtering.
//
// Character classes are expressed as code-point predicates rather than regex
// literals on purpose. A literal control character or bidi override inside a
// source file is invisible, survives copy-paste badly, and is exactly the kind
// of thing this module exists to defend against — so none appear here.
//
// No DOM, no network, no storage.

import { DEFAULT_EXTRACTION_POLICY } from './policy.js';

// These are reserved regardless of extension, and a reserved name can behave
// as a device rather than a file. They are refused on every platform so a
// project exported anywhere cannot produce a name that misbehaves elsewhere.
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// Punctuation that common filesystems refuse outright and that several browsers rewrite
// silently in a download name. `/` and `\` never reach here — the split removes
// them — but they are listed so the predicate is complete on its own terms.
const RESERVED_PUNCT = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

/** C0 controls (0x00-0x1F) and DEL (0x7F). NUL is the important one: it can
 *  truncate a name inside a C API further down the stack. */
function isControl(cp) { return cp < 0x20 || cp === 0x7f; }

/** Invisible or direction-changing formatting characters.
 *   U+200B-U+200F zero-width, LRM, RLM      U+202A-U+202E embedding / override
 *   U+2060-U+2064 invisible operators       U+2066-U+2069 directional isolates
 *   U+FEFF byte-order mark
 *  A RIGHT-TO-LEFT OVERRIDE lets a crafted name *render* as "invoice exe.jpg"
 *  while the bytes say something else, so the extension a user reads is not the
 *  one the system uses. There is no legitimate use of one in a download name. */
function isConfusable(cp) {
  return (cp >= 0x200b && cp <= 0x200f)
    || (cp >= 0x202a && cp <= 0x202e)
    || (cp >= 0x2060 && cp <= 0x2064)
    || (cp >= 0x2066 && cp <= 0x2069)
    || cp === 0xfeff;
}

/**
 * @typedef {Object} SafeName
 * @property {boolean}  ok            a usable name was produced (true; failure is reported by the caller's error model)
 * @property {string}   filename      the name to hand to the download
 * @property {string}   original      the entry name as it appears in the archive
 * @property {boolean}  modified      filename differs from the entry's own leaf name
 * @property {string[]} reasons       why it was modified, in the order applied
 * @property {boolean}  usedFallback  the generated fallback name was used
 */

/**
 * Derive a safe download basename from a ZIP entry name.
 *
 * @param {string} originalEntryName
 * @param {object} [policy]
 * @returns {SafeName}
 */
export function sanitizeDownloadFilename(originalEntryName, policy = DEFAULT_EXTRACTION_POLICY) {
  const original = typeof originalEntryName === 'string' ? originalEntryName : '';
  const reasons = [];
  const maxLen = Math.max(8, policy.maxFilenameLength || 100);

  let s = original;

  // 1. Strip UNC and drive prefixes before splitting, so "C:" cannot survive as
  //    a segment and "\\host\share" cannot leave an empty leading segment.
  if (s.startsWith('\\\\') || s.startsWith('//')) {
    reasons.push('UNC path prefix removed');
    s = s.replace(/^[\\/]+/, '');
  }
  if (/^[A-Za-z]:/.test(s)) {
    reasons.push('drive letter removed');
    s = s.replace(/^[A-Za-z]:[\\/]?/, '');
  }
  if (/^[\\/]/.test(s)) {
    reasons.push('absolute path made relative');
    s = s.replace(/^[\\/]+/, '');
  }

  // 2. Take the leaf. Both separators count: a ZIP written on any platform may use
  //    backslashes even though APPNOTE 4.4.17.1 says forward slashes.
  const segments = s.split(/[\\/]+/).filter((x) => x.length > 0);
  const hadDirectories = /[\\/]/.test(s);
  let leaf = segments.length ? segments[segments.length - 1] : '';
  if (hadDirectories && policy.flattenDirectories !== false) {
    reasons.push('directory path removed — a single file is saved as one file');
  }

  // 3. ".." and "." are directory operators, never a filename. A leaf that is one
  //    of them named no file at all.
  if (leaf === '..' || leaf === '.') {
    reasons.push('the name resolves to a directory, not a file');
    leaf = '';
  }

  // 4. Remove characters that are invisible, misleading, or illegal.
  let stripped = '';
  let removedInvisible = false;
  let replacedIllegal = false;
  for (const ch of leaf) {
    const cp = ch.codePointAt(0);
    if (isConfusable(cp)) { removedInvisible = true; continue; }
    if (isControl(cp) || RESERVED_PUNCT.has(ch)) { stripped += '_'; replacedIllegal = true; continue; }
    stripped += ch;
  }
  if (removedInvisible) reasons.push('invisible or direction-changing characters removed');
  if (replacedIllegal) reasons.push('characters not permitted in a filename replaced with "_"');
  leaf = stripped;

  // 5. Trailing dots and spaces are dropped by some filesystems *after* any check we did,
  //    which turns "report.txt." into "report.txt" behind our back. Do it here so
  //    the name we show is the name the filesystem will hold.
  const beforeTrim = leaf;
  leaf = leaf.replace(/[ .]+$/, '').replace(/^ +/, '');
  if (leaf !== beforeTrim) reasons.push('trailing dots or spaces removed');

  // 6. Reserved device names, with or without an extension.
  const stem = leaf.replace(/\.[^.]*$/, '');
  if (RESERVED.has(stem.toLowerCase())) {
    reasons.push(`"${stem}" is a reserved device name on some filesystems`);
    leaf = `_${leaf}`;
  }

  // 7. Nothing usable survived. ".gitignore" is a real name; "..." is not.
  if (leaf === '' || /^\.+$/.test(leaf)) {
    return {
      ok: true,
      filename: policy.fallbackFilename || 'veraqis-extracted-file.bin',
      original,
      modified: true,
      reasons: [...reasons, 'no usable filename remained — a generated name is used'],
      usedFallback: true,
    };
  }

  // 8. Length. Truncate the stem and keep the extension: the extension is what
  //    makes the file openable, so it is the last thing to lose.
  if (leaf.length > maxLen) {
    const dot = leaf.lastIndexOf('.');
    const ext = dot > 0 && leaf.length - dot <= 12 ? leaf.slice(dot) : '';
    const keep = Math.max(1, maxLen - ext.length);
    leaf = leaf.slice(0, keep) + ext;
    reasons.push(`shortened to ${maxLen} characters`);
  }

  const leafOfOriginal = original.split(/[\\/]+/).filter(Boolean).pop() || '';
  return {
    ok: true,
    filename: leaf,
    original,
    modified: leaf !== leafOfOriginal || reasons.length > 0,
    reasons,
    usedFallback: false,
  };
}

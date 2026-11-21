// VERAQIS Play — Magic Bytes.
// Name the format from the bytes, not from the name. Signatures follow
// https://veraqis.tech/formats/identification/ ; the dumps are generated, the signatures are real.
import { Game, h, hud, loop, toast, pop, shake, makeRng, fmtInt, reducedMotion } from './core.js';

const hx = (s) => s.trim().split(/\s+/).map((b) => parseInt(b, 16));
const asc = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) { let c = 0xFFFFFFFF; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const le16 = (n) => [n & 0xff, (n >>> 8) & 0xff];

// Each format: name shown on the answer button, the leading bytes, how many of them are the signature, why.
const F = {
  zip: { name: 'ZIP archive', head: hx('50 4B 03 04 14 00 08 00 08 00'), sig: 4, why: '50 4B 03 04 — “PK” then 03 04 — opens a ZIP local file header.' },
  pdf: { name: 'PDF document', head: [...asc('%PDF-1.7\n%'), ...hx('E2 E3 CF D3 0A')], sig: 5, why: '“%PDF-” at byte 0 opens every PDF; the version follows.' },
  png: { name: 'PNG image', head: hx('89 50 4E 47 0D 0A 1A 0A 00 00 00 0D 49 48 44 52'), sig: 8, why: '89, “PNG”, then CR LF 1A LF — chosen so line-ending conversion visibly breaks it.' },
  jpeg: { name: 'JPEG image', head: hx('FF D8 FF E0 00 10 4A 46 49 46 00 01 01 01 00 48'), sig: 3, why: 'FF D8 is the JPEG start-of-image marker; FF E0 begins the JFIF segment.' },
  gzip: { name: 'gzip stream', head: hx('1F 8B 08 00 3C 1A 6F 6A 00 03'), sig: 2, why: '1F 8B is gzip; the 08 right after it means deflate.' },
  sevenz: { name: '7-Zip archive', head: hx('37 7A BC AF 27 1C 00 04'), sig: 6, why: '“7z” followed by BC AF 27 1C.' },
  bzip2: { name: 'bzip2 stream', head: hx('42 5A 68 39 31 41 59 26 53 59'), sig: 3, why: '“BZh”, then the block-size digit. The next six bytes, 31 41 59 26 53 59, are π — the block magic.' },
  xz: { name: 'xz stream', head: hx('FD 37 7A 58 5A 00 00 04 E6 D6 B4 46'), sig: 6, why: 'FD, “7zXZ”, 00 — and the stream flags that follow carry their own CRC-32.' },
  rar4: { name: 'RAR 4 archive', head: hx('52 61 72 21 1A 07 00 CF 90 73 00 00 0D 00'), sig: 7, why: '“Rar!” 1A 07 00 — the 00 marks the RAR 1.5–4.x format.' },
  rar5: { name: 'RAR 5 archive', head: hx('52 61 72 21 1A 07 01 00'), sig: 8, why: '“Rar!” 1A 07 01 00 — the extra 01 marks RAR 5.' },
  sqlite: { name: 'SQLite database', head: [...asc('SQLite format 3'), 0, ...hx('10 00 01 01 00 40 20 20 00 00 00 2A 00 00 00 05')], sig: 16, why: 'The 16-byte header string “SQLite format 3” plus a NUL. 10 00 after it is the page size, 4096.' },
  elf: { name: 'ELF executable (Linux, Android)', head: hx('7F 45 4C 46 02 01 01 00'), sig: 4, why: '7F then “ELF”. 02 means 64-bit, 01 little-endian.' },
  pe: { name: 'Windows executable (MZ)', head: hx('4D 5A 90 00 03 00 00 00 04 00 00 00 FF FF 00 00'), sig: 2, why: '“MZ” — the DOS header every Windows .exe and .dll still starts with.' },
  zstd: { name: 'Zstandard stream', head: hx('28 B5 2F FD 24 00'), sig: 4, why: '28 B5 2F FD is the Zstandard frame magic, 0xFD2FB528 stored little-endian.' },
  lz4: { name: 'LZ4 stream', head: hx('04 22 4D 18 64 40 A7'), sig: 4, why: '04 22 4D 18 is the LZ4 frame magic, 0x184D2204 little-endian.' },
  cab: { name: 'Microsoft Cabinet', head: hx('4D 53 43 46 00 00 00 00'), sig: 4, why: '“MSCF” opens a Cabinet archive.' },
  wim: { name: 'Windows image (WIM)', head: hx('4D 53 57 49 4D 00 00 00 D0 00 00 00'), sig: 8, why: '“MSWIM” and three NULs.' },
  qcow2: { name: 'QCOW2 disk image', head: hx('51 46 49 FB 00 00 00 03'), sig: 4, why: '“QFI” then FB — QEMU’s copy-on-write image; 00 00 00 03 is version 3.' },
  vhdx: { name: 'VHDX virtual disk', head: [...asc('vhdxfile'), ...hx('4D 00 69 00 63 00 72 00')], sig: 8, why: '“vhdxfile” at byte 0, followed by the creator in UTF-16.' },
  vmdk: { name: 'VMDK virtual disk', head: hx('4B 44 4D 56 01 00 00 00'), sig: 4, why: '“KDMV” — the VMware sparse-extent header.' },
  tar: { name: 'TAR archive', special: 'tar', why: '“ustar” sits at byte 257, after the first file’s name. Byte 0 is just a file name.' },
  iso: { name: 'ISO 9660 image', special: 'iso', why: '“CD001” at byte 32769. The first 32 KB are a system area, often all zeros.' },
};

const CONTAINERS = {
  docx: { name: 'DOCX document', names: ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'docProps/core.xml'], key: 'word/document.xml', why: 'word/document.xml is the main part of a Word document.' },
  xlsx: { name: 'XLSX spreadsheet', names: ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'], key: 'xl/workbook.xml', why: 'xl/workbook.xml makes it an Excel workbook.' },
  pptx: { name: 'PPTX presentation', names: ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slides/slide1.xml'], key: 'ppt/presentation.xml', why: 'ppt/presentation.xml makes it a PowerPoint deck.' },
  apk: { name: 'APK (Android app)', names: ['AndroidManifest.xml', 'classes.dex', 'resources.arsc', 'res/layout/main.xml', 'META-INF/CERT.RSA'], key: 'classes.dex', why: 'classes.dex plus a binary AndroidManifest.xml — an Android package.' },
  jar: { name: 'JAR (Java archive)', names: ['META-INF/MANIFEST.MF', 'com/example/App.class', 'com/example/Util.class'], key: 'META-INF/MANIFEST.MF', why: 'META-INF/MANIFEST.MF with .class files — a Java archive.' },
  epub: { name: 'EPUB e-book', stored: 'application/epub+zip', names: ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/chapter1.xhtml'], key: 'mimetype', why: 'An EPUB’s first entry is “mimetype”, stored uncompressed: application/epub+zip — readable right in the header.' },
  odt: { name: 'ODT document', stored: 'application/vnd.oasis.opendocument.text', names: ['mimetype', 'content.xml', 'styles.xml', 'META-INF/manifest.xml'], key: 'mimetype', why: 'OpenDocument stores its MIME type first, uncompressed: application/vnd.oasis.opendocument.text.' },
  zipplain: { name: 'Plain ZIP archive', names: ['photos/IMG_0001.jpg', 'photos/IMG_0002.jpg', 'notes.txt'], key: null, why: 'Ordinary files and none of the marker entries a DOCX, APK, JAR or EPUB needs.' },
};

const L = (ids) => ids;
const LEVELS = [
  { name: 'Everyday files', blurb: 'ZIP, PDF, PNG, JPEG, gzip', say: 'A file’s name is only a claim. Its first bytes — the magic number — say what it really is.', count: 10, time: 12, pool: L(['zip', 'pdf', 'png', 'jpeg', 'gzip']), hint: true,
    brief: [['bytes', 'Every format announces itself in its first bytes — the magic number. The highlighted region is where to look.', true],
      ['answer', 'Pick the format with 1–4 or a click. Faster answers score more; three mistakes end the level.'],
      ['50/50', 'Four right answers in a row charge a 50/50: press H to strike two wrong options.']],
    lesson: 'A file’s first few bytes say what it is far more reliably than its name. Every tool that opens a file reads these bytes first.',
    learn: { href: '/formats/identification/', text: 'Identifying a file by its bytes' } },
  { name: 'Compressed streams', blurb: 'gzip, bzip2, xz, Zstandard, LZ4, 7z', say: 'Six compressors, six signatures. Careful: xz and 7-Zip both contain “7z”.', count: 10, time: 11, pool: L(['gzip', 'bzip2', 'xz', 'zstd', 'lz4', 'sevenz']),
    brief: [['streams', 'Six compressors with six signatures. xz and 7-Zip both contain “7z” — look at the bytes around it.', true],
      ['endian', 'Zstandard and LZ4 store their magic numbers little-endian, so the bytes read “backwards”.']],
    lesson: 'Compressed streams differ in more than the signature: xz and bzip2 carry per-block checksums, which is what makes damage past a bad block recoverable.',
    learn: { href: '/formats/xz-bzip2/', text: 'Why xz and bzip2 recover well' } },
  { name: 'Archive family', blurb: 'ZIP, 7z, RAR 4 vs RAR 5, CAB, WIM', say: 'RAR 4 and RAR 5 start the same. One more byte tells them apart.', count: 10, time: 10, pool: L(['zip', 'sevenz', 'rar4', 'rar5', 'cab', 'wim']),
    brief: [['RAR', 'RAR 4 and RAR 5 share “Rar!” 1A 07. One more byte decides: 00 for RAR 4, 01 00 for RAR 5.', true],
      ['MS', 'Microsoft has two: “MSCF” is a Cabinet, “MSWIM” a Windows image.']],
    lesson: 'Version markers matter: RAR 4 and RAR 5 are different formats behind the same first six bytes.',
    learn: { href: '/formats/7z/', text: 'What solid 7z compression costs you' } },
  { name: 'Programs & databases', blurb: 'ELF, MZ, SQLite, disk images', say: 'Programs, databases and virtual disks sign their headers too.', count: 10, time: 10, pool: L(['elf', 'pe', 'sqlite', 'qcow2', 'vmdk', 'vhdx', 'zip']),
    brief: [['code', '“MZ” is a Windows program, 7F “ELF” a Linux or Android one.', true],
      ['data', 'SQLite spells its name out in full. Virtual disks have their own magic: QFI, KDMV, vhdxfile.', true]],
    lesson: 'Databases and disk images are files too, and the same rule applies: the header says what they are.',
    learn: { href: '/formats/sqlite/', text: 'SQLite: the checksums are in the other file' } },
  { name: 'Not at byte zero', blurb: 'TAR at 257, ISO at 32769', say: 'Some formats hide their signature deeper in. Read the whole dump, not just byte 0.', count: 10, time: 12, pool: L(['tar', 'iso', 'zip', 'sevenz', 'qcow2', 'vhdx', 'pdf']),
    brief: [['offset', 'Some formats do not start with their signature. TAR keeps “ustar” at byte 257; an ISO image keeps “CD001” at byte 32769.', true],
      ['read on', 'Byte 0 of a TAR is just a file name, and an ISO often starts with 32 KB of zeros. Read the whole dump.']],
    lesson: 'Looking only at byte 0 misidentifies TAR and ISO. Identification has to know where each signature lives.',
    learn: { href: '/formats/iso/', text: 'ISO 9660: one sector decides the image' } },
  { name: 'Same box, different file', blurb: 'DOCX, APK, JAR, EPUB — all ZIP inside', say: 'Lots of files are ZIP inside. When you see “PK”, look at the entries.', count: 10, time: 13, pool: 'containers',
    brief: [['ZIP', 'DOCX, XLSX, APK, JAR, EPUB and ODT are all ZIP archives — every one starts with “PK”. The entries inside decide.', true],
      ['tell', 'word/ → DOCX, xl/ → XLSX, classes.dex → APK, MANIFEST.MF → JAR. EPUB and ODT store their MIME type as the very first entry.']],
    lesson: 'Half the files on a computer are ZIP archives under another name. Telling them apart means reading the entries, not the signature.',
    learn: { href: '/formats/zip/', text: 'The ZIP format and where it breaks' } },
  { name: 'Renamed or damaged?', blurb: 'The name and the bytes disagree', say: 'Bytes say one format, name says another? Renamed. No signature at all? Damaged.', count: 10, time: 13, pool: 'renamed',
    brief: [['renamed', 'Bytes say one format, the name another: the file was renamed. The file is fine — open it as what the bytes say.', true],
      ['damaged', 'Named like an archive but no signature at all: that is what a destroyed header looks like. Treat it as damaged.', true],
      ['honest', 'Sometimes the name is simply right.']],
    lesson: 'A renamed file needs a different program; a damaged one needs recovery. Folding the two together is how damage gets missed.',
    learn: { href: '/formats/identification/', text: 'Bytes say vs name says' } },
  { name: 'Speed round', blurb: 'Everything, six seconds each', say: 'Fifteen dumps, six seconds each. You know every one of these now.', count: 15, time: 6, pool: 'all',
    brief: [['final', 'Fifteen dumps, six seconds each, every format so far. Clear it to unlock the endless mode.']],
    lesson: 'You now know the magic numbers VERAQIS uses to identify archives, streams, images and disk files — and why the name is only a claim.',
    learn: { href: '/formats/identification/', text: 'The full signature table' } },
];
const ENDLESS = { name: 'Endless dump', tag: 'ENDLESS', blurb: 'Every format, shrinking timer', say: 'Every format, and the clock keeps shrinking. How far can we get?', time: 10, pool: 'all',
  brief: [['endless', 'Random dumps from every level. The timer shrinks as you go; three mistakes end the run.']],
  lesson: 'Endless runs mix every format. The best score is kept in this browser only.' };

const SINGLE_ALL = Object.keys(F);
const FAMILY = { rar4: ['rar5'], rar5: ['rar4'], sevenz: ['xz'], xz: ['sevenz'], cab: ['wim'], wim: ['cab'], elf: ['pe'], pe: ['elf'], qcow2: ['vmdk', 'vhdx'], vmdk: ['qcow2', 'vhdx'], vhdx: ['vmdk', 'qcow2'], tar: ['iso'], iso: ['tar'], zstd: ['lz4'], lz4: ['zstd'], gzip: ['bzip2'], bzip2: ['gzip'] };

// ---------- dump construction ----------
function fill(r, arr, len) {
  const out = arr.slice(0, len);
  while (out.length < len) out.push(r.int(0, 255));
  return out;
}
function singleQuestion(r, id) {
  const f = F[id];
  const rows = [];
  const sig = new Set();
  if (f.special === 'tar') {
    const name = r.pick(['photos/IMG_0001', 'backup/home.cfg', 'src/main.c\0\0\0\0\0', 'docs/report.odt']);
    rows.push({ off: 0, bytes: fill(r, asc(name), 16).map((b, i) => (i < name.length ? b : 0)) });
    rows.push({ skip: true });
    const user = r.pick(['alex', 'root', 'yuri', 'dana']);
    rows.push({ off: 0x100, bytes: fill(r, [0, ...asc('ustar'), 0, ...asc('00'), ...asc(user)], 16).map((b, i) => (i < 9 + user.length ? b : 0)) });
    for (let i = 1; i <= 5; i++) sig.add(`2:${i}`);
  } else if (f.special === 'iso') {
    rows.push({ off: 0, bytes: new Array(16).fill(0) });
    rows.push({ skip: true });
    rows.push({ off: 0x8000, bytes: [1, ...asc('CD001'), 1, 0, ...asc('LINUX   ')] });
    for (let i = 1; i <= 5; i++) sig.add(`2:${i}`);
  } else {
    const head = f.head;
    const total = Math.max(32, Math.ceil(head.length / 16) * 16);
    const all = fill(r, head, total);
    for (let o = 0; o < total; o += 16) rows.push({ off: o, bytes: all.slice(o, o + 16) });
    for (let i = 0; i < f.sig; i++) sig.add(`${Math.floor(i / 16)}:${i % 16}`);
  }
  return { kind: 'single', answer: id, rows, sig, why: f.why };
}
function zipHeader(r, name, stored) {
  const nameB = asc(name);
  if (stored) {
    const data = asc(stored);
    return [...hx('50 4B 03 04 0A 00 00 00 00 00'), ...le16(0x5A21 + r.int(0, 400)), ...le16(0x5B71), ...le32(crc32(data)), ...le32(data.length), ...le32(data.length), ...le16(nameB.length), 0, 0, ...nameB, ...data];
  }
  return [...hx('50 4B 03 04 14 00 06 00 08 00'), ...le16(r.int(0, 65535)), ...le16(r.int(0, 65535)), ...le32(r.int(0, 0xFFFFFFF)), ...le32(r.int(300, 9000)), ...le32(r.int(9000, 40000)), ...le16(nameB.length), 0, 0, ...nameB];
}
function containerQuestion(r, id) {
  const c = CONTAINERS[id];
  const head = zipHeader(r, c.names[0], c.stored);
  const total = Math.ceil(head.length / 16) * 16;
  const all = fill(r, head, total);
  const rows = [];
  for (let o = 0; o < total; o += 16) rows.push({ off: o, bytes: all.slice(o, o + 16) });
  const sig = new Set();
  if (c.stored) { const s = 30 + c.names[0].length; for (let i = s; i < s + c.stored.length; i++) sig.add(`${Math.floor(i / 16)}:${i % 16}`); }
  else for (let i = 0; i < 4; i++) sig.add(`0:${i}`);
  return { kind: 'container', answer: id, rows, sig, list: c.names, key: c.key, why: c.why };
}
function renamedQuestion(r) {
  const roll = r.next();
  if (roll < 0.42) { // renamed
    const real = r.pick(['rar5', 'sevenz', 'zip', 'pdf', 'png', 'sqlite', 'gzip']);
    const claimed = r.pick(Object.entries({ zip: '.zip', rar5: '.rar', sevenz: '.7z', pdf: '.pdf', png: '.jpg', sqlite: '.db', gzip: '.tar.gz' }).filter(([k]) => k !== real));
    const q = singleQuestion(r, real);
    const base = r.pick(['holiday-photos', 'contract-final', 'backup-2026', 'invoice_0193', 'export']);
    q.kind = 'renamed';
    q.file = base + claimed[1];
    q.options = [`Renamed — really ${article(F[real].name)}`, `It is what the name says (${claimed[1]})`, 'Damaged — no signature at all', `Renamed — really ${article(F[pickOther(r, real)].name)}`];
    q.correct = 0;
    q.why = `The name says ${claimed[1]}, the bytes say ${F[real].name}. ${F[real].why}`;
    return q;
  }
  if (roll < 0.74) { // damaged
    const claimed = r.pick([['zip', '.zip'], ['rar5', '.rar'], ['sevenz', '.7z'], ['pdf', '.pdf']]);
    const base = r.pick(['backup', 'archive-2026-11', 'photos', 'project-files']);
    const zeros = r.int(6, 12);
    const tail = fill(r, F[claimed[0]].head || [], 32);
    const all = tail.map((b, i) => (i < zeros ? 0 : b));
    const rows = [{ off: 0, bytes: all.slice(0, 16) }, { off: 16, bytes: all.slice(16, 32) }];
    return { kind: 'renamed', file: base + claimed[1], rows, sig: new Set(Array.from({ length: zeros }, (_, i) => `${Math.floor(i / 16)}:${i % 16}`)),
      options: ['Damaged — no signature where one should be', `It is what the name says (${claimed[1]})`, `Renamed — really ${article(F[pickOther(r, claimed[0])].name)}`, 'Renamed — really a text file'],
      correct: 0, why: `Named ${claimed[1]}, but the first ${zeros} bytes are zeros — no signature at all. That is what a destroyed header looks like: route it to recovery, not to another program.` };
  }
  const real = r.pick(['zip', 'pdf', 'png', 'sqlite', 'sevenz']);
  const ext = { zip: '.zip', pdf: '.pdf', png: '.png', sqlite: '.sqlite', sevenz: '.7z' }[real];
  const q = singleQuestion(r, real);
  q.kind = 'renamed';
  q.file = r.pick(['report', 'scan-0042', 'site-backup', 'contacts']) + ext;
  const o1 = pickOther(r, real);
  let o2 = pickOther(r, real);
  while (o2 === o1) o2 = pickOther(r, real);
  q.options = [`It is what the name says (${ext})`, `Renamed — really ${article(F[o1].name)}`, 'Damaged — no signature at all', `Renamed — really ${article(F[o2].name)}`];
  q.correct = 0;
  q.why = `Name and bytes agree: ${F[real].why}`;
  return q;
}
function article(name) { return /^[AEIOU]/i.test(name) ? `an ${name}` : `a ${name}`; }
function pickOther(r, id) { let o = id; while (o === id) o = r.pick(['zip', 'rar5', 'sevenz', 'pdf', 'png', 'gzip', 'xz', 'sqlite']); return o; }

function makeQuestion(r, lv, prevAnswer) {
  let q;
  if (lv.pool === 'renamed') q = renamedQuestion(r);
  else if (lv.pool === 'containers') q = containerQuestion(r, r.pick(Object.keys(CONTAINERS)));
  else {
    const pool = lv.pool === 'all' ? SINGLE_ALL : lv.pool;
    let id = r.pick(pool);
    if (id === prevAnswer && pool.length > 1) id = r.pick(pool.filter((x) => x !== id));
    q = (lv.pool === 'all' && r.chance(0.18)) ? (r.chance(0.5) ? containerQuestion(r, r.pick(Object.keys(CONTAINERS))) : renamedQuestion(r)) : singleQuestion(r, id);
  }
  if (q.kind === 'single') {
    const pool = (lv.pool === 'all' || !Array.isArray(lv.pool)) ? SINGLE_ALL : lv.pool;
    const near = (FAMILY[q.answer] || []).filter((x) => x !== q.answer);
    const others = r.shuffle([...near, ...r.shuffle(pool.filter((x) => x !== q.answer && !near.includes(x)))]).slice(0, 3);
    const ids = r.shuffle([q.answer, ...others]);
    q.options = ids.map((id) => F[id].name);
    q.correct = ids.indexOf(q.answer);
    q.file = q.file || r.pick(['mystery.bin', 'unknown.dat', 'attachment', 'file.tmp', 'download']);
  } else if (q.kind === 'container') {
    const ids = r.shuffle([q.answer, ...r.shuffle(Object.keys(CONTAINERS).filter((x) => x !== q.answer)).slice(0, 3)]);
    q.options = ids.map((id) => CONTAINERS[id].name);
    q.correct = ids.indexOf(q.answer);
    q.file = r.pick(['download.bin', 'attachment', 'file-0193', 'unknown']);
  } else {
    const order = r.shuffle([0, 1, 2, 3]);
    q.options = order.map((i) => q.options[i]);
    q.correct = order.indexOf(q.correct);
  }
  q.prev = q.answer;
  return q;
}

// ---------- play ----------
function play(api) {
  const lv = api.level;
  const { fx, sfx } = api;
  const r = makeRng(api.seed);
  const endless = api.endless;
  const total = endless ? Infinity : lv.count;
  const motion = !reducedMotion();
  const st = { i: 0, lives: 3, score: 0, streak: 0, best: 0, mistakes: 0, right: 0, charge: 0, times: [] };
  let q = null;
  let t = 0;
  let limit = lv.time;
  let phase = 'decode';   // decode → ask → reveal
  let decodeT = 0;
  let revealTimer = null;
  let prev = null;
  let stopLoop = null;
  const byteEls = [];

  const meter = h('span', { class: 'meter' }, h('i'));
  const bar = hud(api.area, [
    ['n', 'Dump', endless ? '1' : `1/${total}`],
    ['score', 'Score', '0'],
    ['lives', 'Lives', '♥♥♥'],
    ['streak', 'Streak', '0'],
    ['power', '50/50 · H', meter],
  ], () => api.quit());
  const nameEl = h('span', { class: 'mb-name', translate: 'no' });
  const ringNum = h('span', null, '');
  const ring = h('div', { class: 'mb-ring', 'aria-hidden': 'true' }, ringNum);
  const dump = h('div', { class: 'mb-dump', role: 'img' });
  const listEl = h('ul', { class: 'mb-list' });
  const why = h('p', { class: 'mb-why', 'aria-live': 'off' });
  const opts = h('div', { class: 'mb-opts' });
  api.area.append(
    h('div', { class: 'mb-top' }, h('div', { class: 'mb-file' }, h('span', { class: 'mb-q' }, 'File:'), nameEl, h('span', { class: 'mb-q' }, '— what is it really?')), ring),
    dump, listEl, opts, why);

  function setMeter() {
    meter.firstChild.style.width = `${Math.min(100, (st.charge / 4) * 100)}%`;
    meter.classList.toggle('full', st.charge >= 4);
  }
  function hex2(b) { return b.toString(16).toUpperCase().padStart(2, '0'); }

  function render() {
    dump.textContent = '';
    byteEls.length = 0;
    dump.classList.remove('scan');
    q.rows.forEach((row, ri) => {
      if (row.skip) { dump.append(h('div', { class: 'mb-row mb-skip' }, '…')); return; }
      const hexBox = h('span', { class: 'mb-hex' });
      const ascBox = h('span', { class: 'mb-asc' });
      row.bytes.forEach((b, bi) => {
        if (bi === 8) hexBox.append(h('span', { class: 'gap' }));
        const isSig = q.sig.has(`${ri}:${bi}`);
        const el = h('span', { class: 'mb-b' + (b === 0 ? ' nul' : '') + (lv.hint && isSig && q.kind === 'single' ? ' hint' : '') }, motion ? hex2(r.int(0, 255)) : hex2(b));
        const ch = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·';
        const ce = h('span', null, ch);
        byteEls.push({ el, ce, b, sig: isSig });
        hexBox.append(el);
        ascBox.append(ce);
      });
      dump.append(h('div', { class: 'mb-row' }, h('span', { class: 'mb-off' }, row.off.toString(16).toUpperCase().padStart(8, '0')), hexBox, ascBox));
    });
    dump.setAttribute('aria-label', 'Hex dump: ' + q.rows.filter((x) => !x.skip).map((row) => `offset ${row.off}: ${row.bytes.map(hex2).join(' ')}`).join('; '));
    listEl.textContent = '';
    listEl.hidden = !q.list;
    if (q.list) {
      listEl.append(h('li', { class: 'g-dim' }, 'Entries (central directory):'));
      q.list.forEach((n) => listEl.append(h('li', { dataset: null, 'data-name': n }, n)));
    }
    nameEl.textContent = q.file;
    opts.textContent = '';
    q.options.forEach((label, i) => {
      opts.append(h('button', { class: 'g-btn mb-opt', type: 'button', onclick: () => answer(i) }, h('span', { class: 'g-key' }, String(i + 1)), label));
    });
    why.textContent = '';
    why.className = 'mb-why';
  }

  function next() {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    if (st.i >= total || st.lives <= 0) return end();
    if (endless) limit = Math.max(4, lv.time - Math.floor(st.i / 5) * 0.6);
    q = makeQuestion(r, lv, prev);
    prev = q.answer;
    t = 0; decodeT = 0;
    phase = motion ? 'decode' : 'ask';
    bar.set('n', endless ? String(st.i + 1) : `${st.i + 1}/${total}`);
    render();
    if (motion) { dump.classList.add('scan'); sfx.scan(); }
    api.say(`Dump ${st.i + 1}. File named ${q.file}. Options: ${q.options.map((o, i) => `${i + 1}, ${o}`).join('; ')}.`);
  }

  function revealSig() {
    for (const be of byteEls) { be.el.textContent = hex2(be.b); if (be.sig) { be.el.classList.add('sig'); be.ce.classList.add('sig'); } }
    if (q.list && q.key) listEl.querySelectorAll('li').forEach((li) => { if (li.getAttribute('data-name') === q.key) li.classList.add('sig'); });
  }

  function answer(i) {
    if (phase !== 'ask') {
      if (phase === 'reveal') next();
      return;
    }
    phase = 'reveal';
    const buttons = opts.querySelectorAll('.mb-opt');
    const right = i === q.correct;
    revealSig();
    buttons[q.correct].classList.add('right');
    st.i++;
    if (right) {
      st.right++; st.streak++; st.best = Math.max(st.best, st.streak);
      st.charge = Math.min(4, st.charge + 1);
      const mult = Math.min(3, 1 + Math.floor(st.streak / 3) * 0.5);
      const pts = Math.round((100 + 100 * Math.max(0, 1 - t / limit)) * mult);
      st.score += pts; st.times.push(t);
      bar.set('score', fmtInt(st.score), 'bump');
      bar.set('streak', `${st.streak}${mult > 1 ? ` ×${mult}` : ''}`, mult > 1 ? 'warn bump' : '');
      pop(api.stage, buttons[i], `+${pts}`, mult >= 2 ? 'big' : '');
      const sigEl = byteEls.find((b) => b.sig)?.el || buttons[i];
      fx.burst(sigEl, '61,220,151', 30, 280); fx.ring(sigEl, '61,220,151', 140);
      fx.mood = Math.min(1, st.streak / 12);
      sfx.good(st.streak);
      why.className = 'mb-why';
      why.textContent = '';
      why.append(h('strong', null, '✓ '), q.why);
    } else {
      st.mistakes++; st.lives--; st.streak = 0;
      if (i >= 0) buttons[i].classList.add('wrong');
      bar.set('lives', '♥'.repeat(st.lives) + '♡'.repeat(3 - st.lives), st.lives <= 1 ? 'bad' : '');
      bar.set('streak', '0');
      fx.flash('255,95,109', 0.3); fx.alert = 0.8; fx.burst(buttons[q.correct], '255,95,109', 20, 220);
      sfx.bad(); shake(api.view);
      why.className = 'mb-why bad';
      why.textContent = '';
      why.append(h('strong', null, i < 0 ? '⏱ Time — ' : '✕ '), `It was ${q.options[q.correct]}. `, q.why);
    }
    setMeter();
    api.say(right ? `Correct. ${q.why}` : `Wrong. It was ${q.options[q.correct]}. ${q.why}`);
    revealTimer = window.setTimeout(next, right ? 1500 : 3200);
  }

  function fifty() {
    if (st.charge < 4 || phase !== 'ask') return;
    st.charge = 0; setMeter();
    const wrong = r.shuffle([0, 1, 2, 3].filter((x) => x !== q.correct)).slice(0, 2);
    const buttons = opts.querySelectorAll('.mb-opt');
    wrong.forEach((w) => buttons[w].classList.add('gone'));
    fx.ring(ring, '94,231,255', 120); sfx.power();
  }

  function end() {
    if (stopLoop) stopLoop();
    if (revealTimer) clearTimeout(revealTimer);
    phase = 'over';
    const won = endless || st.lives > 0;
    const stars = !won ? 0 : st.mistakes === 0 ? 3 : st.mistakes === 1 ? 2 : 1;
    const avg = st.times.length ? (st.times.reduce((a, b) => a + b, 0) / st.times.length).toFixed(1) + ' s' : '—';
    api.finish({
      won, stars, score: st.score,
      title: endless ? 'Run over' : won ? (stars === 3 ? 'Perfect eye' : 'Level cleared') : 'Out of lives',
      stats: [['Correct', `${st.right}`], ['Mistakes', `${st.mistakes}`], ['Best streak', `${st.best}`], ['Avg answer', avg]],
      delay: 900,
    });
  }

  function onKey(ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (/^[1-4]$/.test(ev.key)) { ev.preventDefault(); answer(Number(ev.key) - 1); }
    else if (ev.key === 'h' || ev.key === 'H') { ev.preventDefault(); fifty(); }
    else if ((ev.key === 'Enter' || ev.key === ' ') && phase === 'reveal') { ev.preventDefault(); next(); }
  }
  document.addEventListener('keydown', onKey);
  bar.item('power').addEventListener('click', fifty);

  next();
  setMeter();
  stopLoop = loop((dt) => {
    if (phase === 'decode') {
      decodeT += dt;
      const settled = Math.floor(decodeT / 0.018);
      byteEls.forEach((be, k) => { be.el.textContent = k < settled ? hex2(be.b) : hex2(r.int(0, 255)); });
      if (settled >= byteEls.length) { phase = 'ask'; byteEls.forEach((be) => { be.el.textContent = hex2(be.b); }); }
      ring.style.setProperty('--p', '1');
      ringNum.textContent = String(Math.ceil(limit));
      return true;
    }
    if (phase !== 'ask') return true;
    t += dt;
    const left = Math.max(0, 1 - t / limit);
    ring.style.setProperty('--p', left.toFixed(3));
    ring.classList.toggle('low', left < 0.3);
    const secs = Math.ceil(limit - t);
    if (ringNum.textContent !== String(secs)) { ringNum.textContent = String(Math.max(0, secs)); if (left < 0.35) sfx.tick(); }
    if (t >= limit) answer(-1);
    return true;
  });

  return () => { if (stopLoop) stopLoop(); if (revealTimer) clearTimeout(revealTimer); document.removeEventListener('keydown', onKey); };
}

const root = document.getElementById('game');
if (root) {
  new Game(root, {
    id: 'magic-bytes',
    title: 'Magic Bytes',
    levels: LEVELS,
    endless: ENDLESS,
    controls: 'Answer: 1–4 or click · 50/50: H · after an answer, Enter skips ahead · M toggles sound · Esc returns to the levels.',
    howto: 'Progress is saved in this browser only. The dumps are generated here; the signatures are the real ones.',
    play,
  });
}

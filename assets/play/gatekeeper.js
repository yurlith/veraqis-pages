// VERAQIS Play — Gatekeeper.
// Entries from an untrusted archive arrive one at a time. Extract the safe ones, block the ones
// that would write outside the destination, expand into a bomb, or redirect later writes.
// The rules are the ones on https://veraqis.tech/security.html; the archives are simulated.
import { Game, h, hud, loop, toast, pop, shake, makeRng, fmtBytes, fmtInt, reducedMotion } from './core.js';

const KB = 1024, MB = KB * 1024, GB = MB * 1024, PB = GB * 1024 * 1024;
const CAP = GB;      // this game's output cap
const RATIO = 1000;  // and expansion-ratio gate

const SAFE_FILES = [
  'docs/report-2026-Q3.pdf', 'photos/2026/IMG_4410.jpg', 'photos/2026/IMG_4411.jpg', 'src/main.rs',
  'src/parser/zip.rs', 'README.md', 'LICENSE', 'music/01 - Intro.flac', 'data/export.csv', 'site/index.html',
  'site/assets/app.js', 'backup/contacts.sqlite', 'fonts/Inter-Regular.woff2', 'notes/todo.txt', 'models/house.obj',
  'invoices/2026-11/INV-0042.pdf', 'logs/app.log', 'config/settings.json', 'video/holiday.mp4', 'thesis/chapter-3.docx',
  'scans/receipt-0193.png', 'game/saves/slot1.dat', 'recipes/borscht.md', 'maps/route.gpx', 'design/logo.svg',
  'budget/2027.xlsx', 'audio/interview.m4a', 'src/ui/button.tsx', 'docs/manual.epub', 'photos/2025/beach.heic',
];
const SAFE_DIRS = ['photos/', 'photos/2026/', 'src/', 'docs/', 'site/assets/', 'music/', 'invoices/2026-11/'];
const TEXT_RE = /(\.(txt|md|csv|log|json|html|js|rs|tsx|sql|xml|svg|gpx|obj|diff)$)|LICENSE|README/i;

const DECOYS = [
  ['a/b/../c.txt', 'a/b/../c.txt resolves to a/c.txt — it never leaves the folder.'],
  ['photos/../photos/IMG_0007.jpg', 'It steps out of photos/ and straight back in. It stays inside.'],
  ['releases/v1.2..v1.3.diff', 'Two dots inside a name are not a path step. Only a whole “..” segment climbs.'],
  ['docs/..notes.txt', '“..notes.txt” is a name that starts with two dots, not a “..” step.'],
  ['console.log.txt', 'Only the exact device names (CON, NUL, AUX…) are reserved — “console” is an ordinary name.'],
  ['auxiliary/aux-notes.md', '“aux-notes” is not the device name AUX.'],
  ['nul-results.csv', '“nul-results” is not the device name NUL.'],
  ['C-drive-notes.txt', 'No colon after the C, so no drive letter — an ordinary name.'],
  ['backup/IMG_4410.jpg', 'Same file name as one in photos/, but a different folder: two different files.'],
];
const BIG_SAFE = [
  ['logs/server-2026-11.log', 4 * MB, 31 * MB, 'Logs compress 5–10× routinely. 8× is normal and far under the cap.'],
  ['data/table.csv', 12 * MB, 96 * MB, 'CSV text compresses about 8×. Normal, and under 1 GB.'],
  ['db/dump.sql', 80 * MB, 640 * MB, 'An 8× SQL dump that stays under the 1 GB cap is fine.'],
  ['video/raw-take.mov', 870 * MB, 905 * MB, 'Big, but video barely compresses (1.04×) and it stays under 1 GB.'],
  ['vm/disk.img', 300 * MB, 950 * MB, 'About 3× and just under the cap — allowed.'],
];

const T = {
  traversal: [
    ['../../.ssh/authorized_keys', 'Each “../” climbs one folder. This entry lands two levels above the folder you chose — the Zip Slip attack.'],
    ['../../../etc/cron.d/backup', 'Three “../” steps climb out of the destination into a scheduled-task folder.'],
    ['docs/../../../home/alex/.bashrc', 'docs/ then three “..”: two levels above the destination.'],
    ['images/../../../../var/www/html/shell.php', 'One folder down, four up: it lands in a web-server folder.'],
    ['../Startup/update.bat', 'A single “../” is enough to leave the folder.'],
    ['a/b/../../../outside.txt', 'Down two, up three: one level above the destination.'],
    ['assets/../../.config/autostart/run.desktop', 'Down one, up two — outside, in an autostart folder.'],
  ],
  absolute: [
    ['/etc/passwd', 'A path that starts with “/” is absolute: it ignores the folder you chose.'],
    ['/home/alex/.profile', 'Absolute path into a home folder, not the destination.'],
    ['/usr/local/bin/update', 'Absolute path into a system program folder.'],
    ['/Library/LaunchAgents/com.update.plist', 'Absolute path into macOS launch agents.'],
    ['C:/Windows/System32/drivers/etc/hosts', 'A drive letter followed by a slash is an absolute Windows path.'],
    ['C:\\Users\\Public\\Desktop\\open-me.lnk', 'Drive letter plus backslash: absolute on Windows.'],
  ],
  windows: [
    ['C:evil.exe', '“C:name” has no slash after the colon: it is relative to drive C’s current folder, not to your destination.'],
    ['D:payload.dll', 'Drive-relative: it resolves against drive D, not the destination.'],
    ['\\\\fileserver\\share\\dropper.exe', 'A UNC path names a share on another machine.'],
    ['\\\\?\\C:\\Windows\\win.ini', 'An extended “\\\\?\\” path is absolute.'],
    ['..\\..\\Windows\\win.ini', 'On Windows “\\” is a separator too: “..\\” climbs exactly like “../”.'],
    ['docs\\..\\..\\..\\autoexec.bat', 'Backslash traversal: down one, up three.'],
    ['CON', 'CON is a device name on Windows, not a file.'],
    ['aux.txt', 'AUX stays a device name even with an extension.'],
    ['NUL.log', 'NUL plus an extension is still the NUL device on Windows.'],
    ['logs/COM1.txt', 'COM1 is a serial-port device name, in any folder.'],
    ['printer/LPT1', 'LPT1 is a printer-port device name.'],
    ['prn.pdf', 'PRN is reserved even with “.pdf” after it.'],
  ],
  link: [
    ['lib/current', '../../../../usr/bin', 'A symlink can point anywhere; the next entry written through it lands where it points.'],
    ['cfg', '/etc', 'A link to /etc turns “cfg/passwd” in a later entry into /etc/passwd.'],
    ['docs/latest', 'v2', 'Even a link that points inside is refused: one entry’s link decides where a later entry lands.'],
    ['home', '/home/alex', 'A link into a home folder lets the next entry overwrite its files.'],
    ['cache', '../../.cache', 'Links are refused whatever they point at — this one points outside anyway.'],
    ['tools', 'C:\\Windows\\System32', 'A link into System32 redirects any later write beneath “tools/”.'],
  ],
  bomb: [
    ['42.zip', 42 * KB, 4.5 * PB, 'The classic: 42 KB of nested archives expands to 4.5 PB.'],
    ['data/zeros.bin', 10 * MB, 10 * GB, '1,024× — and 10 GB is ten times the cap.'],
    ['logs/flood.log', 1 * MB, 2.4 * GB, 'About 2,450× expansion.'],
    ['layer1.zip', 2.1 * KB, 1.3 * GB, 'Over 600,000×: a nested bomb layer.'],
    ['assets/textures.pak', 600 * KB, 1.9 * GB, 'More than 3,300× and nearly twice the cap.'],
    ['backup/inner.tar', 340 * KB, 900 * MB, 'Under the cap, but about 2,700× — over the ratio gate.'],
    ['video/huge.mkv', 1.1 * GB, 1.2 * GB, 'It barely compresses, but 1.2 GB is past the 1 GB output cap.'],
  ],
};

const RULES = {
  traversal: '“../” that climbs out',
  absolute: 'absolute paths',
  windows: 'drive-relative, UNC & device names',
  bomb: `>${RATIO.toLocaleString('en-US')}× or >1 GB`,
  link: 'every symlink',
  dup: 'duplicate names',
  overlap: 'overlapping data',
};

const ALL = ['traversal', 'absolute', 'windows', 'bomb', 'link', 'dup', 'overlap'];
const LEVELS = [
  { name: 'Zip Slip', blurb: 'Entries that climb out with ../', count: 12, bad: 0.42, time: 6.5, threats: ['traversal'],
    brief: [['../', 'An entry name is a path. Every “../” climbs one folder. If the resolved path leaves the folder you chose, block it — that is the Zip Slip attack.', true],
      ['extract', 'Ordinary names stay inside the folder. Let them through.'],
      ['timer', 'When the bar runs out the entry is extracted anyway. Undecided is the dangerous default.']],
    lesson: 'Zip Slip is a path that resolves outside the destination. The check is on the resolved path, not on whether the name contains dots.',
    learn: { href: '/security.html', text: 'How VERAQIS handles untrusted input' } },
  { name: 'Absolute paths', blurb: 'Names that ignore the folder you chose', count: 14, bad: 0.42, time: 5.8, threats: ['absolute', 'traversal'],
    brief: [['/', 'A name starting with “/” — or a drive letter and a slash, like “C:/” — is absolute. It ignores the destination entirely. Block it.', true],
      ['../', 'Zip Slip entries are still in the mix.']],
    lesson: 'An archive entry is only ever a path relative to the folder you picked. Anything absolute is refused before a byte is written.',
    learn: { href: '/security.html', text: 'Path safety on the security page' } },
  { name: 'Windows names', blurb: 'Drive letters, UNC shares, device names', count: 16, bad: 0.45, time: 5.4, threats: ['windows', 'traversal', 'absolute'], decoys: true,
    brief: [['C:x', '“C:name” without a slash is drive-relative. “\\\\server\\share” is a UNC path to another machine. Block both.', true],
      ['..\\', 'Backslash is a separator on Windows: “..\\” climbs like “../”.', true],
      ['CON', 'CON, PRN, AUX, NUL, COM1–9 and LPT1–9 are device names — even with an extension like “aux.txt”.', true],
      ['careful', 'Look-alikes such as “console.log.txt” or “a/b/../c.txt” are safe. Blocking a safe file costs points.']],
    lesson: 'Windows adds drive-relative paths, UNC paths and reserved device names to the list. Look-alikes are fine — a false refusal loses a real file.',
    learn: { href: '/security.html', text: 'Drive-relative, UNC and reserved names' } },
  { name: 'Compression bombs', blurb: 'Tiny entries that expand to terabytes', count: 16, bad: 0.42, time: 5.2, threats: ['bomb', 'traversal'], decoys: true, bombDecoys: true, showRatio: true,
    brief: [['size', 'Each entry shows packed → unpacked size. Block anything that would expand more than 1,000× or past 1 GB.', true],
      ['normal', 'Text compresses 5–10× routinely. A 30 MB log from 4 MB is fine.'],
      ['ratio', 'The ×ratio is shown on this level only. Later you will have to read the sizes yourself.']],
    lesson: 'VERAQIS gates extraction on an incremental, output-capped ratio check: a bomb is stopped before it fills the disk, not after.',
    learn: { href: '/security.html', text: 'Bomb and overlap defences' } },
  { name: 'Symlinks', blurb: 'Links that redirect where later entries land', count: 16, bad: 0.45, time: 4.9, threats: ['link', 'absolute', 'traversal', 'bomb'], decoys: true,
    brief: [['link', 'A symlink entry points somewhere else. A later entry written “through” it lands wherever it points. Refuse every symlink — even one that points inside.', true],
      ['mix', 'Paths and bombs are back too.']],
    lesson: 'Symlinks turn one entry into a redirect for every later one. Refusing all of them is simpler and safer than judging each target.',
    learn: { href: '/security.html', text: 'Why symlinks are refused' } },
  { name: 'Collisions & overlaps', blurb: 'Duplicates and entries sharing bytes', count: 18, bad: 0.4, time: 4.7, threats: ['dup', 'overlap', 'link', 'bomb', 'windows'], decoys: true, offsets: true,
    brief: [['dup', 'Watch the Extracted list. A second entry with a name already written — or the same name in different case, like README.md and readme.MD — would replace the first. Block it.', true],
      ['overlap', 'Some entries show where their data starts. If it starts inside another entry’s bytes, block it: overlapping entries are how non-recursive zip bombs work.', true],
      ['folders', 'Same file name in a different folder is a different file. That one is fine.']],
    lesson: 'Two entries for one name means one silently overwrites the other; two entries for one set of bytes is the overlap trick. Both are refused.',
    learn: { href: '/security.html', text: 'Overlapping-entry defences' } },
  { name: 'Rush hour', blurb: 'Everything at once, faster', count: 24, bad: 0.45, time: 3.9, threats: ALL, decoys: true, offsets: true,
    brief: [['all', 'Every rule so far, mixed, with less time per entry. No ratio hints.'],
      ['tip', 'Keyboard: ← or A blocks, → or D extracts. On a phone, swipe the card.']],
    lesson: 'Real archives mix all of this. The point of a single safety gate is that every entry goes through every rule, every time.',
    learn: { href: '/security.html', text: 'The full safety model' } },
  { name: 'Night shift', blurb: '32 entries, three seconds each', count: 32, bad: 0.5, time: 3.2, threats: ALL, decoys: true, offsets: true,
    brief: [['final', 'Thirty-two entries, about three seconds each, half of them hostile. Clear it to unlock the endless shift.']],
    lesson: 'You have now seen every class of hostile entry VERAQIS refuses before extraction: traversal, absolute and Windows paths, bombs, symlinks, duplicates and overlaps.',
    learn: { href: '/mobile.html', text: 'The scan in VERAQIS Archiver Mobile' } },
];
const ENDLESS = { name: 'Endless shift', tag: 'ENDLESS', blurb: 'How long can you keep the folder clean?', bad: 0.47, time: 4.6, threats: ALL, decoys: true, offsets: true,
  brief: [['endless', 'Entries keep coming and the timer keeps shrinking. Three shields; your score is how long the folder stays clean.']],
  lesson: 'Endless runs use every rule. The best score is kept in this browser only.' };

// ---------- entry generation ----------
function flipCase(name) {
  const slash = name.lastIndexOf('/');
  const dir = name.slice(0, slash + 1);
  const base = name.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const flip = (s) => (s === s.toUpperCase() ? s.toLowerCase() : s.toUpperCase());
  const out = dir + (stem === stem.toLowerCase() ? stem.toUpperCase() : stem.toLowerCase()) + flip(ext);
  return out === name ? dir + base.toUpperCase() : out;
}
function sizesFor(r, path) {
  if (path.endsWith('/')) return [0, 0];
  if (TEXT_RE.test(path)) {
    const size = r.int(3, 900) * KB;
    return [Math.max(300, Math.round(size / (3 + r.next() * 6))), size];
  }
  const size = r.int(60, 9000) * KB;
  return [Math.round(size * (0.92 + r.next() * 0.07)), size];
}
function hex(n) { return '0x' + n.toString(16).toUpperCase(); }

function threatEntry(type, r, ctx) {
  const files = ctx.extracted.filter((e) => e.kind === 'file');
  switch (type) {
    case 'traversal': case 'absolute': case 'windows': {
      const [path, why] = r.pick(T[type]);
      const [packed, size] = sizesFor(r, path);
      return { path, kind: 'file', packed, size, bad: true, type, why };
    }
    case 'link': {
      const [path, target, why] = r.pick(T.link);
      return { path, kind: 'link', target, packed: 0, size: 0, bad: true, type, why };
    }
    case 'bomb': {
      const [path, packed, size, why] = r.pick(T.bomb);
      return { path, kind: 'file', packed, size, bad: true, type, why };
    }
    case 'dup': {
      if (!files.length) return null;
      const orig = r.pick(files.slice(-6));
      const variant = r.chance(0.5);
      const path = variant ? flipCase(orig.path) : orig.path;
      const [packed, size] = sizesFor(r, path);
      return { path, kind: 'file', packed, size, bad: true, type,
        why: variant ? `“${path}” and “${orig.path}” are the same file on Windows and macOS — the second would silently replace the first.`
          : `“${orig.path}” was already written. A second entry with the same name silently replaces it.` };
    }
    case 'overlap': {
      if (!files.length) return null;
      const other = r.pick(files.slice(-6));
      const start = other.offset + Math.max(64, Math.floor(other.packedLen * (0.2 + r.next() * 0.5)));
      return { path: r.pick(['assets/blob-07.bin', 'data/part-2.dat', 'media/chunk.bin', 'lib/extra.so', 'cache/tile-19.bin']),
        kind: 'file', packed: r.int(20, 90) * KB, size: r.int(200, 900) * MB, bad: true, type,
        note: `data starts at ${hex(start)} — inside the bytes of “${other.path}” (${hex(other.offset)}–${hex(other.offset + other.packedLen)})`,
        why: 'Its data starts inside another entry’s bytes. Overlapping entries are how non-recursive zip bombs reuse the same compressed data again and again.' };
    }
    default: return null;
  }
}
function decoyEntry(r, lv) {
  if (lv.bombDecoys && r.chance(0.6)) {
    const [path, packed, size, safeWhy] = r.pick(BIG_SAFE);
    return { path, kind: 'file', packed, size, bad: false, safeWhy };
  }
  const [path, safeWhy] = r.pick(DECOYS);
  const [packed, size] = sizesFor(r, path);
  return { path, kind: 'file', packed, size, bad: false, safeWhy };
}
function safeEntry(r) {
  if (r.chance(0.12)) return { path: r.pick(SAFE_DIRS), kind: 'dir', packed: 0, size: 0, bad: false, safeWhy: 'A plain folder inside the destination.' };
  const path = r.pick(SAFE_FILES);
  const [packed, size] = sizesFor(r, path);
  return { path, kind: 'file', packed, size, bad: false, safeWhy: 'An ordinary relative path that stays inside the folder.' };
}
function nextEntry(r, lv, ctx) {
  for (let attempt = 0; attempt < 12; attempt++) {
    let e = null;
    if (r.chance(lv.bad)) {
      const weights = lv.threats.map((_, i) => (i === 0 && lv.threats.length < ALL.length ? 3 : 1));
      let roll = r.next() * weights.reduce((a, b) => a + b, 0);
      let type = lv.threats[0];
      for (let i = 0; i < weights.length; i++) { roll -= weights[i]; if (roll <= 0) { type = lv.threats[i]; break; } }
      e = threatEntry(type, r, ctx) || threatEntry('traversal', r, ctx);
    } else {
      e = lv.decoys && r.chance(0.32) ? decoyEntry(r, lv) : safeEntry(r);
    }
    const key = e.path + '|' + e.kind;
    if (e.bad && e.type === 'dup') return e;           // duplicates repeat on purpose
    if (ctx.used.has(key) && attempt < 11) continue;
    ctx.used.add(key);
    return e;
  }
  return safeEntry(r);
}

// ---------- play ----------
const SLOWMO_CHARGE = 8;   // correct decisions to fill the scanner
const SLOWMO_TIME = 4;     // seconds of slowed time
const SLOWMO_SCALE = 0.35;

function play(api) {
  const lv = api.level;
  const { fx, sfx } = api;
  const r = makeRng(api.seed);
  const endless = api.endless;
  const total = endless ? Infinity : lv.count;
  const motion = !reducedMotion();
  const st = { i: 0, shields: 3, score: 0, streak: 0, best: 0, mistakes: 0, refused: 0, falseRefusals: 0, charge: 0, slow: 0 };
  const ctx = { extracted: [], used: new Set(), offset: 0x400 };
  let entry = null;
  let t = 0;
  let limit = lv.time;
  let busy = false;
  let stopLoop = null;
  let card = null;
  let timerFill = null;
  let timerBox = null;
  let cardX = 0;

  const meter = h('span', { class: 'meter' }, h('i'));
  const bar = hud(api.area, [
    ['n', 'Entry', endless ? '1' : `1/${total}`],
    ['score', 'Score', '0'],
    ['shields', 'Shields', '◆◆◆'],
    ['combo', 'Combo', '×1'],
    ['power', 'Slow-mo · Space', meter],
  ], () => api.quit());

  const refusedN = h('span', { class: 'gk-bin-n' }, '0');
  const outN = h('span', { class: 'gk-bin-n' }, '0');
  const outList = h('ul', { class: 'gk-files', 'aria-label': 'Extracted so far' });
  const refusedBin = h('div', { class: 'gk-bin' }, h('span', { class: 'gk-bin-h' }, 'Refused'), refusedN);
  const outBin = h('div', { class: 'gk-bin gk-bin--out' }, h('span', { class: 'gk-bin-h' }, 'Extracted to ~/archive/'), outN, outList);
  const track = h('div', { class: 'gk-track' });
  const blockBtn = h('button', { class: 'g-btn g-btn--bad g-btn--big', type: 'button', onclick: () => decide('block') }, '✕ Block ', h('span', { class: 'g-key' }, '←'));
  const extractBtn = h('button', { class: 'g-btn g-btn--good g-btn--big', type: 'button', onclick: () => decide('extract') }, '✓ Extract ', h('span', { class: 'g-key' }, '→'));
  const rules = h('p', { class: 'gk-rule' }, h('b', null, 'Block: '), lv.threats.map((k) => RULES[k]).join(' · '));
  api.area.append(h('div', { class: 'gk-board' },
    refusedBin,
    h('div', { class: 'gk-lane' }, track, h('div', { class: 'gk-buttons' }, blockBtn, extractBtn), rules),
    outBin));

  function setMeter() {
    meter.firstChild.style.width = `${Math.min(100, (st.charge / SLOWMO_CHARGE) * 100)}%`;
    meter.classList.toggle('full', st.charge >= SLOWMO_CHARGE);
  }
  function slowmo() {
    if (st.charge < SLOWMO_CHARGE || st.slow > 0 || !entry) return;
    st.charge = 0; st.slow = SLOWMO_TIME; setMeter();
    api.stage.classList.add('slowmo');
    fx.flash('94,231,255', 0.22); fx.ring(card, '94,231,255', 260);
    sfx.power();
    toast(api.toasts, 'Slow-mo: time runs at a third for four seconds.', 'info', 1600);
  }

  function renderCard(e) {
    const n = st.i + 1;
    timerFill = h('i');
    timerBox = h('div', { class: 'timer', 'aria-hidden': 'true' }, timerFill);
    const ratio = e.packed > 0 ? e.size / e.packed : 0;
    card = h('div', { class: 'gk-card in' },
      h('div', { class: 'gk-top' },
        h('span', { class: 'gk-kind gk-kind--' + e.kind }, e.kind === 'link' ? 'symlink' : e.kind === 'dir' ? 'folder' : 'file'),
        h('span', { class: 'gk-num' }, endless ? `#${n}` : `#${n} of ${total}`)),
      h('div', { class: 'gk-path', translate: 'no' }, e.path),
      e.kind === 'file' ? h('div', { class: 'gk-meta' },
        h('span', null, `packed ${fmtBytes(e.packed)}`), h('span', { class: 'arrow' }, '→'), h('span', null, `${fmtBytes(e.size)}`),
        lv.showRatio && ratio ? h('span', { class: 'gk-ratio' }, `×${ratio >= 100 ? fmtInt(ratio) : ratio.toFixed(1)}`) : null) : null,
      e.kind === 'link' ? h('div', { class: 'gk-target' }, 'points to ', h('b', null, e.target)) : null,
      e.note ? h('div', { class: 'gk-note' }, e.note) : null,
      timerBox);
    let x0 = null;
    card.addEventListener('pointerdown', (ev) => { x0 = ev.clientX; });
    card.addEventListener('pointerup', (ev) => {
      if (x0 == null) return;
      const dx = ev.clientX - x0; x0 = null;
      if (Math.abs(dx) > 60) decide(dx < 0 ? 'block' : 'extract');
    });
    track.textContent = '';
    track.append(card);
    cardX = 0;
    const what = e.kind === 'link' ? `symlink ${e.path} pointing to ${e.target}` : `${e.kind === 'dir' ? 'folder' : 'file'} ${e.path}`;
    api.say(`Entry ${n}: ${what}${e.kind === 'file' ? `, ${fmtBytes(e.packed)} expanding to ${fmtBytes(e.size)}` : ''}${e.note ? `. ${e.note}` : ''}.`);
  }

  function spawn() {
    if (st.i >= total) return end();
    if (endless) limit = Math.max(2.2, lv.time - Math.floor(st.i / 8) * 0.2);
    entry = nextEntry(r, lv, ctx);
    if (lv.offsets && entry.kind === 'file' && !entry.note && r.chance(0.35) && ctx.extracted.length) {
      const prev = ctx.extracted[ctx.extracted.length - 1];
      entry.note = `data starts at ${hex(ctx.offset)} — after the bytes of “${prev.path}”`;
    }
    t = 0;
    busy = false;
    bar.set('n', endless ? String(st.i + 1) : `${st.i + 1}/${total}`);
    renderCard(entry);
  }

  function award(points) {
    st.score = Math.max(0, st.score + points);
    bar.set('score', fmtInt(st.score), 'bump');
  }
  function comboMult() { return Math.min(5, 1 + Math.floor(st.streak / 5)); }

  function decide(action) {
    if (busy || !entry) return;
    busy = true;
    const e = entry;
    const speed = Math.max(0, 1 - t / limit);
    const mult = comboMult();
    let ok = false;
    const btn = action === 'block' ? blockBtn : action === 'extract' ? extractBtn : null;
    if (btn) { btn.classList.add('pressed'); window.setTimeout(() => btn.classList.remove('pressed'), 120); }
    if (action === 'block') {
      if (e.bad) {
        ok = true; st.refused++; refusedN.textContent = String(st.refused);
        const pts = Math.round((100 + 50 * speed) * mult);
        award(pts);
        pop(api.stage, card, `+${pts}`, mult >= 3 ? 'big' : '');
        fx.burst(card, '255,95,109', 34 + mult * 6, 320); fx.ring(card, '255,95,109', 190);
        sfx.zap();
        refusedBin.classList.remove('hit'); void refusedBin.offsetWidth; refusedBin.classList.add('hit');
      } else {
        st.mistakes++; st.falseRefusals++;
        award(-40);
        pop(api.stage, card, '−40', 'bad');
        sfx.bad(); shake(api.view);
        toast(api.toasts, `That one was safe — ${e.safeWhy || 'It stays inside the folder.'} Refusing it loses a real file.`, 'bad', 3400);
      }
    } else {
      if (e.bad) {
        st.mistakes++; st.shields--;
        bar.set('shields', '◆'.repeat(st.shields) + '◇'.repeat(3 - st.shields), st.shields <= 1 ? 'bad' : '');
        fx.flash('255,95,109', 0.45); fx.alert = 1; fx.burst(outBin, '255,95,109', 50, 380);
        sfx.boom(); shake(api.view, true);
        api.stage.classList.add('breach'); window.setTimeout(() => api.stage.classList.remove('breach'), 700);
        toast(api.toasts, `${action === 'timeout' ? 'Time ran out, so it was extracted. ' : ''}✕ BREACH — ${e.why}`, 'bad', 4200);
      } else {
        ok = true;
        if (action === 'extract') {
          const pts = Math.round((40 + 25 * speed) * mult);
          award(pts);
          pop(api.stage, card, `+${pts}`);
          sfx.good(mult);
        }
        fx.burst(outBin, '61,220,151', 18, 200);
      }
      if (!e.bad || e.kind !== 'link') {
        if (e.kind === 'file') {
          const len = Math.max(256, Math.min(e.packed, 0x40000));
          ctx.extracted.push({ path: e.path, kind: 'file', offset: ctx.offset, packedLen: len });
          ctx.offset += len + 64;
        }
        outN.textContent = String(Number(outN.textContent) + 1);
        outList.prepend(h('li', null, e.path));
        while (outList.children.length > 8) outList.lastChild.remove();
      }
    }
    if (ok) { st.streak++; st.charge = Math.min(SLOWMO_CHARGE, st.charge + 1); } else st.streak = 0;
    st.best = Math.max(st.best, st.streak);
    const m2 = comboMult();
    bar.set('combo', `×${m2}`, m2 > 1 ? 'warn' + (m2 > mult ? ' bump' : '') : '');
    if (m2 > mult) { sfx.power(); toast(api.toasts, `COMBO ×${m2}`, 'good', 1100); }
    fx.mood = (m2 - 1) / 4;
    setMeter();
    // card exit
    card.dataset.stamp = action === 'block' ? 'REFUSED' : 'EXTRACTED';
    card.classList.remove('in');
    card.classList.add('stamped');
    if (action !== 'block') card.classList.add('ok');
    if (motion) {
      const outTo = action === 'block' ? `translate(${cardX - 260}px, 30px) rotate(-14deg) scale(.7)` : `translate(${cardX + 260}px, 10px) scale(.5)`;
      window.setTimeout(() => { if (card) { card.classList.add(action === 'block' ? 'to-left' : 'to-right'); card.style.transform = outTo; } }, 160);
    }
    st.i++;
    if (st.shields <= 0) { entry = null; return end(); }
    window.setTimeout(spawn, ok ? 430 : 900);
  }

  function end() {
    if (stopLoop) stopLoop();
    entry = null;
    api.stage.classList.remove('slowmo');
    const won = endless || st.shields > 0;
    const stars = !won ? 0 : st.mistakes === 0 ? 3 : st.mistakes <= 2 ? 2 : 1;
    api.finish({
      won, stars, score: st.score,
      title: endless ? 'Shift over' : won ? (stars === 3 ? 'Flawless shift' : 'Level cleared') : 'Folder compromised',
      stats: [
        ['Refused', `${st.refused}`],
        ['Hostile let in', `${3 - st.shields}`],
        ['Safe refused', `${st.falseRefusals}`],
        ['Best streak', `${st.best}`],
        endless ? ['Entries', `${st.i}`] : ['Mistakes', `${st.mistakes}`],
      ],
      delay: 900,
    });
  }

  function onKey(ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const k = ev.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { ev.preventDefault(); decide('block'); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { ev.preventDefault(); decide('extract'); }
    else if (k === ' ' || k === 'Spacebar') { ev.preventDefault(); slowmo(); }
  }
  document.addEventListener('keydown', onKey);
  bar.item('power').addEventListener('click', slowmo);

  spawn();
  setMeter();
  stopLoop = loop((dt) => {
    if (st.slow > 0) {
      st.slow -= dt;
      if (st.slow <= 0) { st.slow = 0; api.stage.classList.remove('slowmo'); }
    }
    if (!entry || busy) return true;
    t += dt * (st.slow > 0 ? SLOWMO_SCALE : 1);
    const p = Math.min(1, t / limit);
    if (timerFill) timerFill.style.width = `${((1 - p) * 100).toFixed(1)}%`;
    if (timerBox) timerBox.classList.toggle('low', p > 0.7);
    if (motion && card) {
      cardX = Math.max(0, (track.clientWidth - card.offsetWidth - 52) * p);
      card.style.transform = `translateX(${cardX.toFixed(1)}px)`;
    }
    if (p > 0.7 && Math.floor(t * 4) !== Math.floor((t - dt) * 4)) sfx.tick();
    if (t >= limit) decide('timeout');
    return true;
  });

  return () => { if (stopLoop) stopLoop(); document.removeEventListener('keydown', onKey); api.stage.classList.remove('slowmo', 'breach'); };
}

const root = document.getElementById('game');
if (root) {
  new Game(root, {
    id: 'gatekeeper',
    title: 'Gatekeeper',
    levels: LEVELS,
    endless: ENDLESS,
    controls: 'Block: ← or A · Extract: → or D · swipe the card on a phone · Esc returns to the levels.',
    howto: 'Progress is saved in this browser only. Nothing is uploaded — the archives are simulated.',
    play,
  });
}

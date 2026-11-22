// VERAQIS Studio — the full engine's function catalog.
//
// One entry per function the page offers. "fields" describes the form;
// "build" turns the form into exactly the protocol-v1 request the desktop and
// Android apps send, plus the files to hand the engine. Inputs are read in place
// under /in; an operation that must write beside its input gets a copy under
// /work; everything an operation writes goes under /out. Entries with a "custom"
// key have their own interface in app.js (lists to pick from, previews, ...).

export const GROUPS = [
  { id: 'check', title: 'Check', blurb: 'Find out whether a file is healthy and exactly what is wrong with it. Nothing is changed.' },
  { id: 'recover', title: 'Recover', blurb: 'Get back what the surviving bytes can prove. Your original is only read; results are new files you download.' },
  { id: 'protect', title: 'Protect', blurb: 'Add repair data before anything goes wrong, check protected files later, and rebuild damaged ones.' },
  { id: 'crypto', title: 'Encrypt and sign', blurb: 'Lock a file with a password or key, open it again, and sign files so changes are detectable.' },
  { id: 'inspect', title: 'Inspect and extract safely', blurb: 'Look inside archives and documents without opening them in another program, and extract only safe entries.' },
  { id: 'rar', title: 'RAR archives', blurb: 'List, test and extract RAR archives, including solid and multi-volume ones.' },
  { id: 'engine', title: 'Engine, history and advanced', blurb: 'What the engine can do, its self-test, your local history, and developer tools.' },
];

const HASHES = [['sha256', 'SHA-256'], ['sha3-512', 'SHA3-512']];
const hashField = { key: 'hash', type: 'select', label: 'Hash', options: HASHES };
const stem = (name) => name.replace(/\.[^./]+$/, '');
const tail = (name) => name.split('/').pop();

export const OPS = [
  // ---------------------------------------------------------------- Check
  {
    id: 'analyze', group: 'check', title: 'Analyze a file',
    desc: 'Health score, every detected problem with its evidence, and how likely recovery is.',
    fields: [
      { key: 'file', type: 'file', label: 'File' },
      { key: 'recursive', type: 'check', label: 'Also look inside archives that are inside it' },
      { key: 'strict', type: 'check', label: 'Strict mode (report borderline findings too)' },
      hashField,
    ],
    build: (v, h) => {
      const f = h.file(v.file);
      return { request: { op: 'analyze', path: '/in/' + f.name, recursive: v.recursive, strict: v.strict, hash: v.hash }, inputs: [f] };
    },
  },
  {
    id: 'verify', group: 'check', title: 'Verify integrity',
    desc: 'Hash the file and, if you have one, check it against a manifest.',
    fields: [
      { key: 'file', type: 'file', label: 'File' },
      { key: 'manifest', type: 'file', label: 'Manifest (optional)', optional: true },
      hashField,
    ],
    build: (v, h) => {
      const f = h.file(v.file);
      const m = h.optFile(v.manifest);
      const request = { op: 'verify', path: '/in/' + f.name, hash: v.hash };
      if (m) request.manifest = '/in/' + m.name;
      return { request, inputs: m ? [f, m] : [f] };
    },
  },
  {
    id: 'score', group: 'check', title: 'Health score only',
    desc: 'Just the numbers: health out of 100 and the recoverability estimate.',
    fields: [{ key: 'file', type: 'file', label: 'File' }, hashField],
    build: (v, h) => { const f = h.file(v.file); return { request: { op: 'score', path: '/in/' + f.name, hash: v.hash }, inputs: [f] }; },
  },
  {
    id: 'render', group: 'check', title: 'Readable report on screen',
    desc: 'The full analysis as text, Markdown, HTML or JSON — shown here and ready to download.',
    fields: [
      { key: 'file', type: 'file', label: 'File' },
      { key: 'format', type: 'select', label: 'Format', options: [['console', 'Plain text'], ['md', 'Markdown'], ['html', 'HTML'], ['json', 'JSON']] },
      hashField,
    ],
    build: (v, h) => { const f = h.file(v.file); return { request: { op: 'render', path: '/in/' + f.name, format: v.format, hash: v.hash, color: false }, inputs: [f], name: f.name }; },
    view: 'rendered',
  },
  {
    id: 'report', group: 'check', title: 'Save a report file',
    desc: 'Writes the analysis report as a file you can keep or send.',
    fields: [
      { key: 'file', type: 'file', label: 'File' },
      { key: 'format', type: 'select', label: 'Format', options: [['html', 'HTML'], ['md', 'Markdown'], ['json', 'JSON']] },
    ],
    build: (v, h) => {
      const f = h.file(v.file);
      return { request: { op: 'report', path: '/in/' + f.name, output: `/out/${tail(f.name)}.report.${v.format}`, format: v.format }, inputs: [f] };
    },
  },
  {
    id: 'safety_scan', group: 'check', title: 'Is it safe to open?',
    desc: 'Looks for zip bombs, paths that escape the folder, links and other traps before anything is extracted.',
    fields: [{ key: 'file', type: 'file', label: 'File' }],
    build: (v, h) => { const f = h.file(v.file); return { request: { op: 'safety_scan', path: '/in/' + f.name }, inputs: [f] }; },
  },

  // -------------------------------------------------------------- Recover
  { id: 'hub', group: 'recover', title: 'Recovery assistant', custom: 'hub',
    desc: 'Checks the file, shows which recovery methods apply to it, and runs the one you pick.' },
  {
    id: 'recover_plan', group: 'recover', title: 'Repair plan (dry look)',
    desc: 'Which repairs the engine would make and how risky each is — without writing anything.',
    fields: [{ key: 'file', type: 'file', label: 'File' }],
    build: (v, h) => { const f = h.file(v.file); return { request: { op: 'recover_plan', path: '/in/' + f.name }, inputs: [f] }; },
  },
  {
    id: 'recover', group: 'recover', title: 'Structural repair',
    desc: 'Repairs headers, directories and checksums (ZIP, TAR, GZIP, ISO, SQLite, 7z) and writes a repaired copy with a signed repair manifest.',
    fields: [
      { key: 'file', type: 'file', label: 'Damaged file' },
      { key: 'strategy', type: 'text', label: 'Strategy (optional — leave empty to let the engine choose)', placeholder: 'e.g. zip-rebuild' },
      { key: 'aggressive', type: 'check', label: 'Aggressive: also try repairs that are less certain' },
      { key: 'dry_run', type: 'check', label: 'Dry run: plan and check, write nothing' },
    ],
    build: (v, h) => {
      const f = h.file(v.file);
      const request = { op: 'recover', path: '/in/' + f.name, output: '/out', aggressive: v.aggressive, dry_run: v.dry_run };
      if (v.strategy.trim()) request.strategy = v.strategy.trim();
      return { request, inputs: [f] };
    },
  },
  {
    id: 'recover_semantic', group: 'recover', title: 'Recover contents (rows, parts, objects)',
    desc: 'Rebuilds what is inside: SQLite tables and rows, Office document parts, PDF objects, 7z and RAR inventories. Only provable items are marked verified.',
    fields: [
      { key: 'file', type: 'file', label: 'Damaged file' },
      { key: 'kind', type: 'select', label: 'Kind of file', options: [['sqlite', 'SQLite database'], ['opc', 'Office document (DOCX, XLSX, PPTX)'], ['pdf', 'PDF'], ['7z', '7-Zip archive'], ['rar', 'RAR archive']] },
    ],
    build: (v, h) => { const f = h.file(v.file); return { request: { op: 'recover_semantic', path: '/in/' + f.name, kind: v.kind, output: '/out/' + v.kind }, inputs: [f] }; },
  },
  {
    id: 'recover_salvage', group: 'recover', title: 'Salvage a damaged .bz2 or .xz',
    desc: 'Recovers every block of a damaged bzip2 or xz stream that still passes its own checksum.',
    fields: [{ key: 'file', type: 'file', label: 'Damaged .bz2 or .xz file' }],
    build: (v, h) => { const f = h.file(v.file); return { request: { op: 'recover_salvage', path: '/in/' + f.name, output: '/out/salvage' }, inputs: [f] }; },
  },
  {
    id: 'recover_reconcile', group: 'recover', title: 'Reconcile duplicate records (ZIP, ISO)',
    desc: 'Uses the copies a format keeps of its own records to fix fields that disagree — only where at least two independent copies agree.',
    fields: [{ key: 'file', type: 'file', label: 'Damaged ZIP or ISO' }],
    build: (v, h) => { const f = h.file(v.file); return { request: { op: 'recover_reconcile', path: '/in/' + f.name, output: '/out/reconcile' }, inputs: [f] }; },
  },
  {
    id: 'recover_shield', group: 'recover', title: 'Restore from repair data (.phxs)',
    desc: 'Rebuilds a damaged file byte for byte from the repair data made earlier with “Add repair data”.',
    fields: [
      { key: 'file', type: 'file', label: 'Damaged file' },
      { key: 'sidecar', type: 'file', label: 'Its repair data (.phxs)', prefer: /\.phxs$/i },
    ],
    build: (v, h) => {
      const f = h.file(v.file); const s = h.file(v.sidecar);
      return { request: { op: 'recover_shield', path: '/in/' + f.name, sidecar: '/in/' + s.name, output: '/out' }, inputs: [f, s] };
    },
  },
  {
    id: 'recover_xcr', group: 'recover', experimental: true, title: 'Rebuild from your own earlier copy (experimental)',
    desc: 'Copies damaged regions back from an earlier copy of the same file that you own — only where the bytes match exactly and an independent checksum confirms the placement.',
    fields: [
      { key: 'file', type: 'file', label: 'Damaged file' },
      { key: 'manifest', type: 'file', label: 'Its region manifest (.phxx.json)', prefer: /\.phxx\.json$/i },
      { key: 'index', type: 'folder', label: 'Folder with your earlier copies' },
    ],
    build: (v, h) => {
      const f = h.file(v.file); const m = h.file(v.manifest); const dir = h.folder(v.index);
      const inputs = [f, { name: f.name + '.phxx.json', file: m.file }, ...dir.files.map((x) => ({ name: 'owner-index/' + x.rel, file: x.file }))];
      return { request: { op: 'recover_xcr', path: '/in/' + f.name, index: '/in/owner-index', output: '/out' }, inputs };
    },
  },

  // -------------------------------------------------------------- Protect
  {
    id: 'protect_shield', group: 'protect', title: 'Add repair data to a file',
    desc: 'Creates a small .phxs file next to yours. Keep both: if the file is damaged later, it can be rebuilt byte for byte.',
    fields: [
      { key: 'file', type: 'file', label: 'File to protect' },
      { key: 'budget', type: 'number', label: 'Repair data size (% of the file)', value: 10, min: 1, max: 100, step: 1 },
    ],
    build: (v, h) => {
      const f = h.file(v.file);
      return { request: { op: 'protect_shield', path: '/in/' + f.name, output: `/out/${tail(f.name)}.phxs`, budget: Number(v.budget) }, inputs: [f] };
    },
  },
  {
    id: 'protect_batch', group: 'protect', title: 'Protect a whole folder',
    desc: 'Adds repair data for every file in a folder plus a manifest. You get a ZIP with the new files — unpack it into the same folder.',
    fields: [
      { key: 'folder', type: 'folder', label: 'Folder' },
      { key: 'budget', type: 'number', label: 'Repair data size (% of each file)', value: 10, min: 1, max: 100, step: 1 },
      { key: 'update', type: 'check', label: 'Update: only redo files that changed since last time' },
    ],
    build: (v, h) => {
      const d = h.folder(v.folder);
      return {
        request: { op: 'protect_batch', path: '/work/' + d.name, budget: Number(v.budget), update: v.update },
        inputs: d.files.map((x) => ({ name: d.name + '/' + x.rel, file: x.file })), writable: true, zipName: d.name + '-repair-data.zip',
      };
    },
  },
  {
    id: 'protect_check', group: 'protect', title: 'Check a protected folder',
    desc: 'Finds files that changed, rotted or went missing since the folder was protected. Read-only.',
    fields: [{ key: 'folder', type: 'folder', label: 'Protected folder (with its .phxs files and manifest)' }],
    build: (v, h) => {
      const d = h.folder(v.folder);
      return { request: { op: 'protect_check', path: '/in/' + d.name }, inputs: d.files.map((x) => ({ name: d.name + '/' + x.rel, file: x.file })) };
    },
  },
  {
    id: 'protect_repair', group: 'protect', title: 'Repair a protected folder',
    desc: 'Rebuilds damaged files of a protected folder byte for byte. Your folder is not touched; repaired files come back as downloads.',
    fields: [{ key: 'folder', type: 'folder', label: 'Protected folder' }],
    build: (v, h) => {
      const d = h.folder(v.folder);
      return { request: { op: 'protect_repair', path: '/in/' + d.name, output: '/out/repaired' }, inputs: d.files.map((x) => ({ name: d.name + '/' + x.rel, file: x.file })) };
    },
  },

  // ------------------------------------------------------- Encrypt and sign
  {
    id: 'protect_encrypt', group: 'crypto', title: 'Encrypt a file',
    desc: 'AES-256-GCM container (.phx). Use a password or a key file. Without it the file cannot be opened — there is no recovery.',
    fields: [
      { key: 'file', type: 'file', label: 'File' },
      { key: 'password', type: 'password', label: 'Password' },
      { key: 'key', type: 'file', label: 'Or a key file instead of a password', optional: true },
    ],
    build: (v, h) => {
      const f = h.file(v.file); const k = h.optFile(v.key);
      const request = { op: 'protect_encrypt', path: '/in/' + f.name, output: `/out/${tail(f.name)}.phx` };
      if (k) request.key_file = '/in/' + k.name; else if (v.password) request.password = v.password;
      else throw new Error('Enter a password or choose a key file.');
      return { request, inputs: k ? [f, k] : [f] };
    },
  },
  {
    id: 'protect_decrypt', group: 'crypto', title: 'Decrypt a .phx file',
    desc: 'Opens a container made with “Encrypt a file”. A wrong password gives no output at all.',
    fields: [
      { key: 'file', type: 'file', label: 'Encrypted .phx file', prefer: /\.phx$/i },
      { key: 'password', type: 'password', label: 'Password' },
      { key: 'key', type: 'file', label: 'Or its key file', optional: true },
    ],
    build: (v, h) => {
      const f = h.file(v.file); const k = h.optFile(v.key);
      const out = /\.phx$/i.test(f.name) ? stem(tail(f.name)) : tail(f.name) + '.decrypted';
      const request = { op: 'protect_decrypt', path: '/in/' + f.name, output: '/out/' + out };
      if (k) request.key_file = '/in/' + k.name; else if (v.password) request.password = v.password;
      else throw new Error('Enter the password or choose the key file.');
      return { request, inputs: k ? [f, k] : [f] };
    },
  },
  {
    id: 'protect_info', group: 'crypto', title: 'About an encrypted file',
    desc: 'Shows the original name, size, algorithm and date of a .phx container — no password needed.',
    fields: [{ key: 'file', type: 'file', label: 'Encrypted .phx file', prefer: /\.phx$/i }],
    build: (v, h) => { const f = h.file(v.file); return { request: { op: 'protect_info', path: '/in/' + f.name }, inputs: [f] }; },
  },
  {
    id: 'protect_sign', group: 'crypto', title: 'Sign a file', custom: 'keygen',
    desc: 'Creates a detached Ed25519 signature (.sig). Anyone with your public key can check the file was not changed.',
    fields: [
      { key: 'file', type: 'file', label: 'File to sign' },
      { key: 'key', type: 'file', label: 'Your private signing key (32 bytes)', prefer: /\.ed25519$/i },
    ],
    build: (v, h) => {
      const f = h.file(v.file); const k = h.file(v.key);
      const name = tail(f.name);
      return { request: { op: 'protect_sign', path: '/work/' + name, key: '/work/signing.key' }, inputs: [{ name, file: f.file }, { name: 'signing.key', file: k.file }], writable: true };
    },
  },
  {
    id: 'protect_verify', group: 'crypto', title: 'Check a signature',
    desc: 'Checks a file against its .sig and the signer’s public key. One changed byte makes it fail.',
    fields: [
      { key: 'file', type: 'file', label: 'Signed file' },
      { key: 'sig', type: 'file', label: 'Its signature (.sig)', prefer: /\.sig$/i },
      { key: 'key', type: 'file', label: 'Signer’s public key (32 bytes)', prefer: /\.pub$/i },
    ],
    build: (v, h) => {
      const f = h.file(v.file); const s = h.file(v.sig); const k = h.file(v.key);
      const name = tail(f.name);
      return { request: { op: 'protect_verify', path: '/in/' + name, key: '/in/signer.pub' }, inputs: [{ name, file: f.file }, { name: name + '.sig', file: s.file }, { name: 'signer.pub', file: k.file }] };
    },
  },

  // ---------------------------------------------------- Inspect and extract
  { id: 'inspect', group: 'inspect', title: 'Look inside', custom: 'inspect',
    desc: 'Shows the tree of an archive or document and previews entries without extracting anything.' },
  { id: 'safe_extract', group: 'inspect', title: 'Extract safe entries', custom: 'safe_extract',
    desc: 'Lists what can be extracted safely, lets you pick, and extracts only those — traps are refused.' },

  // ----------------------------------------------------------------- RAR
  { id: 'rar', group: 'rar', title: 'Open a RAR archive', custom: 'rar',
    desc: 'List, test (decompress and check every checksum) or extract. For multi-volume archives add every volume.' },

  // --------------------------------------------------------------- Engine
  { id: 'capabilities', group: 'engine', title: 'What this engine can do', custom: 'capabilities',
    desc: 'Every recovery method with its maturity and the kind of proof behind its results.' },
  { id: 'self_test', group: 'engine', title: 'Self-test', custom: 'simple', request: { op: 'self_test' },
    desc: 'Runs the engine’s own start-up checks in this browser.' },
  { id: 'history', group: 'engine', title: 'Your history on this device', custom: 'history',
    desc: 'A summary of what you analysed here. It is stored only in this browser, and you can clear it.' },
  {
    id: 'license_info', group: 'engine', title: 'Read a license file', advanced: true,
    desc: 'Not needed here — every function on this page is already open. Shows what a VERAQIS license file contains.',
    fields: [{ key: 'file', type: 'file', label: 'License file' }],
    build: (v, h) => { const f = h.file(v.file); return { request: { op: 'license_info', path: '/in/' + f.name }, inputs: [f] }; },
  },
  {
    id: 'license_verify', group: 'engine', title: 'Check a license signature', advanced: true,
    desc: 'Not needed here. Checks a license file’s signature against a public key (64 hex characters).',
    fields: [
      { key: 'file', type: 'file', label: 'License file' },
      { key: 'key', type: 'text', label: 'Public key, 64 hex characters', placeholder: '0123…' },
    ],
    build: (v, h) => {
      const f = h.file(v.file);
      const request = { op: 'license_verify', path: '/in/' + f.name };
      if (v.key.trim()) request.key = v.key.trim();
      return { request, inputs: [f] };
    },
  },
  { id: 'raw', group: 'engine', title: 'Developer: send any request', custom: 'raw', advanced: true,
    desc: 'Send a protocol-v1 request exactly as the apps do. Your files are at /in/<name>; write under /out.' },
];

// VERAQIS — ZIP checker UI controller.
//
// Owns the DOM only. All parsing happens in worker.js; this file never touches
// archive bytes. Every value that reaches the DOM goes through textContent or
// createTextNode — there is no innerHTML path for untrusted data anywhere here.

const $ = (id) => document.getElementById(id);

const el = {
  app: $('checker-app'),
  noscript: $('checker-fallback'),
  drop: $('drop-zone'),
  input: $('file-input'),
  pick: $('pick-button'),
  idle: $('state-idle'),
  busy: $('state-busy'),
  done: $('state-done'),
  busyName: $('busy-name'),
  busySize: $('busy-size'),
  busyPhase: $('busy-phase'),
  bar: $('progress-bar'),
  cancel: $('cancel-button'),
  live: $('live-region'),
  verdict: $('verdict'),
  verdictNote: $('verdict-note'),
  diagnosis: $('diagnosis'),
  summary: $('summary-grid'),
  structure: $('structure-list'),
  warnings: $('warnings'),
  limitations: $('limitations'),
  filters: $('filters'),
  tableBody: $('entries-body'),
  tableWrap: $('entries-wrap'),
  entryCount: $('entry-count'),
  download: $('download-report'),
  reset: $('reset-button'),
  error: $('error-box'),
};

let worker = null;
let currentResult = null;
let activeFilter = 'ALL';
let objectUrl = null;

const STATUS_LABEL = {
  VERIFIED: 'Verified',
  STRUCTURALLY_VALID: 'Structurally valid',
  POTENTIALLY_RECOVERABLE: 'Potentially recoverable',
  DAMAGED: 'Damaged',
  UNKNOWN: 'Unknown',
};
// Status is carried by text + a glyph as well as colour (WCAG 1.4.1).
const STATUS_GLYPH = {
  VERIFIED: '✓',
  STRUCTURALLY_VALID: '≡',
  POTENTIALLY_RECOVERABLE: '△',
  DAMAGED: '✕',
  UNKNOWN: '?',
};

const VERDICT_TEXT = {
  INTACT_VERIFIED: ['Archive intact', 'Every entry decoded and its stored CRC-32 matched. Nothing here needs recovery.'],
  INTACT_STRUCTURE: ['Structure intact', 'The archive structure is consistent. Some entries could not be checked against a CRC — see the table.'],
  PARTIALLY_RECOVERABLE: ['Partially readable', 'Some entries can be proven, others cannot. VERAQIS found data ranges that may be recoverable. This browser check does not extract or repair the archive.'],
  DAMAGED: ['Damaged', 'Confirmed contradictions were found. See the per-entry reasons below.'],
  UNDETERMINED: ['Could not be determined', 'No damage was proven, but nothing could be verified either — usually encryption or a codec this check does not decode.'],
  EMPTY_ARCHIVE: ['Empty archive', 'A structurally valid ZIP that contains no entries.'],
  NO_ENTRIES_FOUND: ['No entries found', 'The file has ZIP structure but no readable entries could be located.'],
  NOT_A_ZIP: ['Not a ZIP archive', 'No usable ZIP structure was found in this file.'],
};

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MiB`;
  return `${(n / 1073741824).toFixed(2)} GiB`;
}

function show(state) {
  el.idle.hidden = state !== 'idle';
  el.busy.hidden = state !== 'busy';
  el.done.hidden = state !== 'done';
}

function announce(text) {
  el.live.textContent = text;
}

/* --------------------------------------------------------------- rendering */

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;               // textContent — never innerHTML
  return td;
}

function statusCell(status) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = 'zc-status zc-' + status.toLowerCase().replace(/_/g, '-');
  const glyph = document.createElement('span');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.className = 'zc-glyph';
  glyph.textContent = STATUS_GLYPH[status] || '?';
  span.appendChild(glyph);
  span.appendChild(document.createTextNode(' ' + (STATUS_LABEL[status] || status)));
  td.appendChild(span);
  return td;
}

function renderSummary(r) {
  el.summary.textContent = '';
  const stats = [
    ['Entries found', r.counts.total],
    ['Verified', r.counts.verified],
    ['Structurally valid', r.counts.structurallyValid],
    ['Potentially recoverable', r.counts.potentiallyRecoverable],
    ['Damaged', r.counts.damaged],
    ['Unknown', r.counts.unknown],
  ];
  for (const [label, value] of stats) {
    const d = document.createElement('div');
    d.className = 'zc-stat';
    const n = document.createElement('div');
    n.className = 'zc-stat-n';
    n.textContent = String(value);
    const l = document.createElement('div');
    l.className = 'zc-stat-l';
    l.textContent = label;
    d.append(n, l);
    el.summary.appendChild(d);
  }
}

function renderStructure(r) {
  el.structure.textContent = '';
  const rows = [
    ['File size', fmtBytes(r.file.size)],
    ['End-of-central-directory', r.eocd.found ? `found at offset ${r.eocd.offset}` : `not found — ${r.eocd.reason}`],
    ['Central directory', r.centralDirectory.status === 'OK' ? `read, ${r.centralDirectory.recordsRead} record(s)`
      : r.centralDirectory.status === 'PARTIAL' ? `partially read, ${r.centralDirectory.recordsRead} record(s)`
        : r.centralDirectory.status === 'DAMAGED' ? 'present but unreadable'
          : 'missing'],
    ['Local file headers found', String(r.localHeaderScan.candidatesFound)],
    ['CRC coverage', `${Math.round(r.crcCoverage * 100)}% of entries had their CRC-32 recomputed`],
    ['Potentially recoverable data', fmtBytes(r.recoverableBytes)],
    ['ZIP64', r.zip64 && r.zip64.present ? (r.zip64.usable ? 'present' : 'present but unusable') : 'not used'],
    ['Analysis time', `${r.elapsedMs} ms`],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    el.structure.append(dt, dd);
  }
}

function renderList(target, items, heading) {
  target.textContent = '';
  if (!items || items.length === 0) { target.hidden = true; return; }
  target.hidden = false;
  const h = document.createElement('h3');
  h.textContent = heading;
  target.appendChild(h);
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = document.createElement('li');
    li.textContent = it;
    ul.appendChild(li);
  }
  target.appendChild(ul);
}

function renderEntries() {
  const r = currentResult;
  el.tableBody.textContent = '';
  if (!r) return;
  const list = activeFilter === 'ALL' ? r.entries : r.entries.filter((e) => e.status === activeFilter);
  el.entryCount.textContent = activeFilter === 'ALL'
    ? `${list.length} entr${list.length === 1 ? 'y' : 'ies'}`
    : `${list.length} of ${r.entries.length} entr${r.entries.length === 1 ? 'y' : 'ies'}`;

  if (list.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = 'No entries with this status.';
    tr.appendChild(td);
    el.tableBody.appendChild(tr);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of list) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(e.name, 'zc-name'));
    tr.appendChild(cell(e.methodName));
    tr.appendChild(cell(fmtBytes(e.compressedSize)));
    tr.appendChild(cell(fmtBytes(e.uncompressedSize)));
    tr.appendChild(cell(e.localHeaderOffset == null ? '—' : String(e.localHeaderOffset), 'zc-num'));
    tr.appendChild(cell(e.crcChecked ? (e.crcOk ? 'matched' : 'mismatch') : 'not verified'));
    tr.appendChild(statusCell(e.status));
    tr.appendChild(cell(e.reasons.join('; ') || '—', 'zc-reason'));
    frag.appendChild(tr);
  }
  el.tableBody.appendChild(frag);
}

/**
 * What went wrong, and what to do about it.
 *
 * The verdict says how much can be trusted. This says why, and it is the part a person
 * with a broken archive actually needs: "the index is gone but your data is intact" and
 * "your data failed its checksum" are opposite situations that used to share one
 * sentence. Every line is written to be actionable rather than reassuring — where the
 * honest answer is "this data is gone", it says so.
 */
const DIAGNOSIS_TEXT = {
  INTACT: {
    title: 'Nothing is wrong with this archive',
    what: 'The structure is consistent and every entry that could be checked matched its stored checksum.',
    next: 'No action needed.',
  },
  CONTENT_CORRUPT: {
    title: 'The stored data is corrupted',
    what: 'The archive structure is readable, but the bytes of one or more entries no longer match the checksum recorded for them. Something altered the contents after the archive was written.',
    next: 'Recovering the original bytes is not possible from this file alone. If you have another copy, a backup, or the original source, compare against it. Entries that still verify below are unaffected and can be trusted.',
  },
  TRUNCATED: {
    title: 'The file is incomplete',
    what: 'Entries declare more data than the file actually contains — the archive was cut short, most often by an interrupted download, copy or disk write.',
    next: 'Re-download or re-copy the file if you can; a complete copy will simply work. Entries that lie entirely within the surviving bytes are still readable.',
  },
  INDEX_MISSING: {
    title: 'The index is missing — the data is not',
    what: 'The table of contents at the end of the archive is gone, which is why ordinary tools refuse to open this file. The entries themselves were found by scanning the archive directly, and their data is still present.',
    next: 'This is one of the most recoverable states there is. The entries below were located without the index; those marked verified matched their checksums.',
  },
  INDEX_DAMAGED: {
    title: 'The index is damaged — the data may not be',
    what: 'The archive index exists but could not be read in full. That is a fault in the table of contents, not necessarily in the entries it describes.',
    next: 'Entries were cross-checked against the local headers found in the file itself. Treat anything verified below as sound regardless of the index.',
  },
  PREPENDED_DATA: {
    title: 'Something is attached before the archive',
    what: 'The file does not start with a ZIP signature. That is normal for self-extracting archives, and it is also what a corrupted or wrongly-joined header looks like.',
    next: 'If this was meant to be a self-extracting archive, it is probably fine. Otherwise the leading bytes may be junk that a tool prepended by mistake.',
  },
  ENCRYPTED_OR_UNSUPPORTED: {
    title: 'Some entries could not be read here',
    what: 'One or more entries are encrypted, or use a compression method this browser check does not implement. That is not evidence of damage — it means this tool cannot answer the question.',
    next: 'Unreadable is not the same as broken. Use the tool that created the archive, or supply the password, to establish these entries.',
  },
  NOT_A_ZIP: {
    title: 'No ZIP structure was found',
    what: 'Nothing in this file looks like a ZIP archive.',
    next: 'Check that the file is what you think it is. A wrong extension is far more common than a destroyed archive.',
  },
  EMPTY: {
    title: 'The archive is empty',
    what: 'The structure is valid and declares no entries at all.',
    next: 'Nothing to recover — this archive was created empty.',
  },
};

function renderDiagnosis(r) {
  const host = el.diagnosis;
  if (!host) return;
  const d = r.diagnosis;
  if (!d || !DIAGNOSIS_TEXT[d.code]) { host.hidden = true; return; }
  const t = DIAGNOSIS_TEXT[d.code];
  host.hidden = false;
  host.className = 'zc-diagnosis zc-dx-' + d.code.toLowerCase().replace(/_/g, '-')
    + (d.dataLooksIntact ? ' zc-dx-data-ok' : '');
  host.textContent = '';

  const h = document.createElement('h3');
  h.className = 'zc-dx-title';
  h.textContent = t.title;
  host.appendChild(h);

  const what = document.createElement('p');
  what.className = 'zc-dx-what';
  what.textContent = t.what;
  host.appendChild(what);

  if (d.evidence && d.evidence.length) {
    const ev = document.createElement('p');
    ev.className = 'zc-dx-evidence';
    // Prefixed so a reader can tell the measurement apart from the explanation.
    ev.textContent = 'Observed: ' + d.evidence.join(' · ') + '.';
    host.appendChild(ev);
  }

  const next = document.createElement('p');
  next.className = 'zc-dx-next';
  next.textContent = t.next;
  host.appendChild(next);
}

function renderResult(r) {
  currentResult = r;
  const [title, note] = VERDICT_TEXT[r.verdict] || [r.verdict, ''];
  el.verdict.textContent = title;
  el.verdict.className = 'zc-verdict zc-verdict-' + r.verdict.toLowerCase().replace(/_/g, '-');
  el.verdictNote.textContent = note;
  renderDiagnosis(r);
  renderSummary(r);
  renderStructure(r);
  renderList(el.warnings, r.warnings, 'Warnings');
  renderList(el.limitations, r.limitations, 'What this check did not establish');
  activeFilter = 'ALL';
  for (const b of el.filters.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === 'ALL'));
  }
  renderEntries();

  // Diagnostic report: the analysis result verbatim. It contains offsets, sizes,
  // entry names and verdicts — and no archive content (asserted by a test).
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
  objectUrl = URL.createObjectURL(blob);
  el.download.href = objectUrl;
  // The download filename is derived from the user's filename, so it is sanitised
  // to a conservative character set before it becomes a filesystem name.
  const safeName = (r.file.name || 'archive').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  el.download.setAttribute('download', `veraqis-zip-check-${safeName}.json`);

  show('done');
  announce(`Analysis complete. ${title}. ${r.counts.total} entries: ${r.counts.verified} verified, ${r.counts.damaged} damaged, ${r.counts.potentiallyRecoverable} potentially recoverable.`);
}

/* ------------------------------------------------------------------ flow */

function showError(message) {
  el.error.hidden = false;
  el.error.textContent = message;
  show('idle');
  announce('Analysis failed. ' + message);
}

function startAnalysis(file) {
  if (!file) return;
  el.error.hidden = true;
  el.busyName.textContent = file.name;
  el.busySize.textContent = fmtBytes(file.size);
  el.busyPhase.textContent = 'Reading the end of the file…';
  el.bar.value = 0;
  show('busy');
  announce(`Analysing ${file.name}, ${fmtBytes(file.size)}.`);

  if (worker) worker.terminate();
  worker = new Worker('/assets/zip-checker/worker.js', { type: 'module' });

  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'progress') {
      const phase = {
        start: 'Starting…',
        eocd: 'Looking for the end-of-central-directory record…',
        'central-directory': 'Reading the central directory…',
        'local-headers': 'Scanning for local file headers…',
        crc: 'Recomputing CRC-32 checksums…',
      }[m.phase] || m.phase;
      el.busyPhase.textContent = m.message ? `${phase} (${m.message})` : phase;
      if (m.total > 0) { el.bar.max = m.total; el.bar.value = m.done; }
    } else if (m.type === 'result') {
      renderResult(m.result);
    } else if (m.type === 'cancelled') {
      show('idle');
      announce('Analysis cancelled.');
    } else if (m.type === 'error') {
      showError('The archive could not be analysed: ' + m.message);
    }
  };
  worker.onerror = () => showError('The analysis worker failed to start.');
  worker.postMessage({ type: 'analyze', file });
}

function reset() {
  if (worker) { worker.terminate(); worker = null; }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  currentResult = null;
  el.input.value = '';
  el.tableBody.textContent = '';
  el.error.hidden = true;
  show('idle');
  announce('Cleared. No file is loaded.');
  el.pick.focus();
}

/* --------------------------------------------------------------- wiring */

if (el.app) {
  el.app.hidden = false;
  if (el.noscript) el.noscript.hidden = true;

  el.pick.addEventListener('click', () => el.input.click());
  el.input.addEventListener('change', () => startAnalysis(el.input.files && el.input.files[0]));

  // The drop zone is a real <button>, so keyboard and screen-reader support come
  // from the platform rather than from ARIA patched onto a div.
  ['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => {
    e.preventDefault(); el.drop.classList.add('zc-dragover');
  }));
  ['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, () => el.drop.classList.remove('zc-dragover')));
  el.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) startAnalysis(f);
  });

  el.cancel.addEventListener('click', () => {
    if (worker) worker.postMessage({ type: 'cancel' });
  });
  el.reset.addEventListener('click', reset);

  el.filters.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    activeFilter = b.dataset.filter;
    for (const other of el.filters.querySelectorAll('button')) {
      other.setAttribute('aria-pressed', String(other === b));
    }
    renderEntries();
    announce(`Filter: ${b.textContent.trim()}.`);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.busy.hidden && worker) worker.postMessage({ type: 'cancel' });
  });
}

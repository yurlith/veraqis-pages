// VERAQIS Studio — application shell and workspace.
//
// Bootstraps only when its mount point exists, so a page without the shell is
// unaffected. All static content stays in the HTML; this file enhances it.
//
// Owns no parsing. Analysis goes through WorkerSupervisor -> worker -> engine.

import { WorkerSupervisor } from './supervisor.js';
import { detect, featureMatrix, sizePolicy, LEVEL } from './capabilities.js';
import { ProjectStore, loadSettings, saveSettings, resetSettings, deleteAllLocalData, DEFAULT_SETTINGS } from './store.js';
import {
  createProject, fingerprintFile, fingerprintMatches, serializeProject,
  projectFileName, recordOperation, OP_STATUS,
} from './project.js';
import { StudioError, ERR, toStudioError } from './errors.js';
import { STAGE_LABEL, EXTRACT_PHASE_LABEL } from './protocol.js';
import { extractionPolicy } from './policy.js';
import { evaluateExtractionEligibility, OPERATION_STATUS } from './eligibility.js';
import { OutputRegistry, sourceKeyOf } from './output.js';
import { crcHex } from './crc32.js';
import { buildHtmlReport, buildJsonReport } from './report.js';
import { t } from './messages.js';
import { $, el, clear, append, fmtBytes, fmtDate, makeAnnouncer, renderError, downloadText, statusPill } from './ui.js';

const root = $('studio-root');
if (root) boot(root).catch((e) => {
  const box = $('studio-error');
  if (box) renderError(box, toStudioError(e));
});

async function boot(mount) {
  const view = mount.dataset.view || 'home';

  const caps = await detect();
  const features = featureMatrix(caps);
  const sizes = sizePolicy(caps);
  const store = await ProjectStore.open();
  let settings = loadSettings();

  const policy = extractionPolicy(caps);

  const state = {
    caps, features, sizes, store, settings, policy,
    project: null,        // in-memory project (not persisted unless saved)
    file: null,           // the File the user selected this session
    saved: false,
    supervisor: null,
    page: 0,
    filter: 'ALL',
    query: '',
    // Extraction is a separate axis from analysis, and its state is separate
    // too: which entry is selected, whether one is running, and the single
    // prepared output. Nothing here is persisted.
    selectedEntryId: null,
    extracting: false,
    output: new OutputRegistry(policy),
  };

  // The shell is present in the HTML and visible from first paint; JavaScript
  // only attaches behaviour. Nothing is revealed after boot, because doing so
  // measured 0.244 CLS on the settings page. The no-JS notice is a native
  // <noscript>, which is simply absent when scripting is on.

  renderCapabilityStrip(state);
  wireGlobalActions(state);

  if (view === 'home') await renderHome(state);
  if (view === 'new') renderNew(state);
  if (view === 'reports') renderReports(state);
  if (view === 'settings') renderSettings(state);
  if (view === 'project') renderProjectView(state);
}

/* ------------------------------------------------------------- shell pieces */

function renderCapabilityStrip(s) {
  const host = $('studio-capabilities');
  if (!host) return;
  clear(host);
  const rows = [
    ['Analysis engine', s.features.analysis],
    ['Compressed-entry checksums', s.features.crcDeflate],
    ['Download a verified stored file', s.features.extractStored],
    ['Download a verified compressed file', s.features.extractDeflate],
    ['Save projects locally', s.features.saveProjects],
    ['Offline use', s.features.offline],
    ['Folder export', s.features.directoryExport],
  ];
  for (const [label, f] of rows) {
    const cls = f.level === LEVEL.SUPPORTED ? 'zc-verified'
      : f.level === LEVEL.UNSUPPORTED ? 'zc-unknown' : 'zc-potentially-recoverable';
    const item = el('div', { class: 'st-cap' }, [
      el('span', { class: 'zc-status ' + cls }, [
        el('span', { class: 'zc-glyph', 'aria-hidden': 'true', text: f.level === LEVEL.SUPPORTED ? '✓' : '—' }),
        ' ' + f.level,
      ]),
      el('span', { class: 'st-cap-label', text: label }),
    ]);
    if (f.why) item.appendChild(el('p', { class: 'note', text: f.why }));
    host.appendChild(item);
  }
}

function setWorkerStatus(text) {
  const n = $('studio-worker-status');
  if (n) n.textContent = text;
}

function setStorageStatus(s, text) {
  const n = $('studio-storage-status');
  if (!n) return;
  n.textContent = text || (s.saved ? t('storage.durable')
    : s.store.durable ? t('storage.memory') : t('storage.unavailable'));
}

function wireGlobalActions(s) {
  const del = $('studio-delete-all');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('Delete every VERAQIS project, setting and cached file stored by this browser? This cannot be undone.')) return;
    const r = await deleteAllLocalData(s.store);
    s.settings = { ...DEFAULT_SETTINGS };
    const out = $('studio-settings-result');
    if (out) {
      clear(out); out.hidden = false;
      out.appendChild(el('p', { text: `Deleted: projects ${r.projects ? 'yes' : 'no'}, settings ${r.settings ? 'yes' : 'no'}, caches ${r.caches ? 'yes' : 'no'}.` }));
      if (r.errors.length) out.appendChild(el('p', { class: 'note', text: r.errors.join('; ') }));
    }
    if ($('studio-project-list')) await renderHome(s);
  });
}

/* -------------------------------------------------------------------- home */

async function renderHome(s) {
  const list = $('studio-project-list');
  if (!list) return;
  clear(list);
  let projects = [];
  try { projects = await s.store.listProjects(); }
  catch { /* storage unavailable; the empty state below is correct */ }

  const empty = $('studio-empty-state');
  if (projects.length === 0) {
    if (empty) empty.hidden = false;
    list.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;
  list.hidden = false;

  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { scope: 'col', text: 'Source file' }),
    el('th', { scope: 'col', text: 'Verdict' }),
    el('th', { scope: 'col', text: 'Entries' }),
    el('th', { scope: 'col', text: 'Saved' }),
    el('th', { scope: 'col', text: 'Actions' }),
  ])));
  const tb = el('tbody');
  for (const p of projects) {
    const c = p.counts || {};
    tb.appendChild(el('tr', {}, [
      el('td', { class: 'zc-name', text: p.name }),
      el('td', { text: p.verdict ? t('verdict.' + p.verdict) : '—' }),
      el('td', { text: c.total !== undefined ? `${c.verified ?? 0}/${c.total ?? 0} verified` : '—' }),
      el('td', { text: fmtDate(p.updated) }),
      el('td', {}, [
        el('button', {
          type: 'button', class: 'btn ghost st-sm', text: 'Export',
          onclick: async () => {
            const json = await s.store.exportProject(p.id);
            downloadText(`${p.name.replace(/[^A-Za-z0-9._-]/g, '_')}.veraqis-project.json`, json);
          },
        }),
        ' ',
        el('button', {
          type: 'button', class: 'btn ghost st-sm', text: 'Delete',
          onclick: async () => {
            if (!confirm(`Delete the saved project for "${p.name}"? The original file is untouched.`)) return;
            await s.store.deleteProject(p.id);
            await renderHome(s);
          },
        }),
      ]),
    ]));
  }
  table.appendChild(tb);
  list.appendChild(el('div', { class: 'table-scroll' }, table));
}

/* --------------------------------------------------------------- new analysis */

function renderNew(s) {
  const drop = $('studio-drop');
  const input = $('studio-file');
  const pick = $('studio-pick');
  const errBox = $('studio-error');
  const live = $('studio-live');
  const announce = makeAnnouncer(live);

  if (!drop || !input || !pick) return;

  s.supervisor = new WorkerSupervisor({
    onStatus: ({ state, detail }) => {
      const map = {
        starting: t('worker.starting'), ready: t('worker.ready'), running: t('worker.running'),
        idle: t('worker.idle'), crashed: t('worker.crashed'),
        unavailable: t('worker.unavailable'), 'version-mismatch': t('worker.versionMismatch'),
      };
      setWorkerStatus(map[state] || state);
      if (state === 'crashed') {
        // A crashed worker may have been mid-extraction. Whatever it produced is
        // unverified by definition, so the prepared output goes with it.
        resetExtraction(s, 'the engine stopped');
        if (detail) announce(t('worker.crashed'), true);
      }
    },
  });

  if (s.features.analysis.level !== LEVEL.SUPPORTED) {
    pick.disabled = true; drop.disabled = true;
    renderError(errBox, new StudioError(ERR.BROWSER_UNSUPPORTED, { detail: s.features.analysis.why }));
    return;
  }

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', () => start(input.files && input.files[0]));
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('zc-dragover'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, () => drop.classList.remove('zc-dragover')));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) start(f);
  });

  const cancel = $('studio-cancel');
  if (cancel) cancel.addEventListener('click', () => s.supervisor.cancel());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('studio-busy') && !$('studio-busy').hidden) s.supervisor.cancel();
  });

  async function start(file) {
    if (!file) return;
    // A different source file invalidates anything prepared from the last one,
    // before any of it can be re-offered next to the new result.
    s.output.revokeIfStale({ sourceKey: sourceKeyOf(file) });
    resetExtraction(s, 'a new file was selected');
    errBox.hidden = true;
    if (file.size > s.sizes.hard) {
      renderError(errBox, new StudioError(ERR.MEMORY_LIMIT, {
        detail: `${fmtBytes(file.size)} exceeds this device's safe limit of ${fmtBytes(s.sizes.hard)} (${s.sizes.basis}).`,
      }));
      return;
    }
    if (file.size > s.settings.largeFileConfirmMB * 1048576) {
      if (!confirm(`${file.name} is ${fmtBytes(file.size)}. Analysis runs entirely in this browser and may take a while. Continue?`)) return;
    }

    show('busy');
    $('studio-busy-name').textContent = file.name;
    $('studio-busy-size').textContent = fmtBytes(file.size);
    announce(t('state.analysing', { name: file.name }), true);

    const bar = $('studio-progress');
    try {
      const result = await s.supervisor.analyze(file, { verifyCrc: s.settings.verifyCrc }, (p) => {
        const label = STAGE_LABEL[p.stage] || p.stage;
        $('studio-busy-stage').textContent = p.message ? `${label} (${p.message})` : label;
        if (bar && p.total > 0) { bar.max = p.total; bar.value = p.done; }
        announce(label);
      });
      const fp = await fingerprintFile(file, s.settings.fingerprintMode);
      s.file = file;
      s.project = createProject({ file, fingerprint: fp, engineResult: result, settings: s.settings });
      s.saved = false;
      if (s.settings.autoSaveProjects && s.features.saveProjects.level === LEVEL.SUPPORTED) {
        try { await s.store.saveProject(s.project); s.saved = true; } catch { /* reported below */ }
      }
      renderResult(s);
      show('done');
      const c = s.project.analysis.counts || {};
      announce(`${t('state.done')}. ${t('verdict.' + s.project.analysis.verdict)}. ${c.total ?? 0} entries, ${c.verified ?? 0} verified, ${c.damaged ?? 0} damaged.`, true);
    } catch (e) {
      const se = toStudioError(e);
      if (se.code === ERR.CANCELLED) { show('idle'); announce('Analysis cancelled.', true); return; }
      renderError(errBox, se);
      show('idle');
      announce(se.userMessage, true);
    }
  }

  const clearBtn = $('studio-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    resetExtraction(s, 'the workspace was cleared');
    s.project = null; s.file = null; s.saved = false; s.page = 0; s.filter = 'ALL'; s.query = '';
    input.value = '';
    if (s.supervisor) s.supervisor.terminate();
    show('idle');
    setStorageStatus(s);
    announce('Cleared. No file is loaded.', true);
    pick.focus();
  });

  function show(which) {
    for (const id of ['idle', 'busy', 'done']) {
      const n = $('studio-' + id);
      if (n) n.hidden = id !== which;
    }
  }
}

/* ------------------------------------------------------------------ results */

function renderResult(s) {
  const p = s.project;
  const a = p.analysis;

  $('studio-verdict').textContent = t('verdict.' + a.verdict);
  $('studio-verdict').className = 'zc-verdict zc-verdict-' + String(a.verdict).toLowerCase().replace(/_/g, '-');
  $('studio-format').textContent = `${p.source.name} · ${fmtBytes(p.source.size)} · ${a.format ? a.format.label : 'archive'}`;

  const grid = $('studio-summary');
  clear(grid);
  const c = a.counts || {};
  for (const [key, val] of [['total', c.total], ['verified', c.verified], ['structurallyValid', c.structurallyValid],
    ['potentiallyRecoverable', c.potentiallyRecoverable], ['damaged', c.damaged], ['unknown', c.unknown]]) {
    grid.appendChild(el('div', { class: 'zc-stat' }, [
      el('div', { class: 'zc-stat-n', text: String(val ?? 0) }),
      el('div', { class: 'zc-stat-l', text: t('count.' + key) }),
    ]));
  }

  const dl = $('studio-structure');
  clear(dl);
  const cd = a.centralDirectory || {};
  const rows = [
    ['Detected format', a.format ? `${a.format.label} — ${a.format.evidence}` : '—'],
    ['End-of-central-directory', a.eocd && a.eocd.found ? `found at offset ${a.eocd.offset}` : `not found — ${a.eocd ? a.eocd.reason : 'unknown'}`],
    ['Central directory', cd.status === 'OK' ? `read, ${cd.recordsRead} record(s)`
      : cd.status === 'PARTIAL' ? `partially read, ${cd.recordsRead} record(s)`
        : cd.status === 'DAMAGED' ? 'present but unreadable' : 'missing'],
    ['Local file headers found', String((a.localHeaderScan || {}).candidatesFound ?? 0)],
    ['CRC coverage', `${Math.round((a.crcCoverage || 0) * 100)}% of entries had their CRC-32 recomputed`],
    ['Potentially recoverable data', fmtBytes(a.recoverableBytes)],
    ['ZIP64', a.zip64 && a.zip64.present ? (a.zip64.usable ? 'present' : 'present but unusable') : 'not used'],
    ['Engine', a.engine ? `${a.engine.id} ${a.engine.version} (${a.engine.kind})` : '—'],
    ['Analysis time', `${a.elapsedMs} ms`],
    ['Source fingerprint', p.source.fingerprint ? p.source.fingerprint.mode : 'none'],
  ];
  if (a.nestedArchives && a.nestedArchives.length) {
    rows.push(['Nested archives detected', `${a.nestedArchives.length} — not opened automatically`]);
  }
  for (const [k, v] of rows) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); }

  renderNotes($('studio-warnings'), p.warnings, 'Warnings');
  renderNotes($('studio-limitations'), p.limitations, 'What this analysis did not establish');

  // A new result means any previously prepared output belongs to a different
  // analysis. Revoke before the new entry table is drawn, so there is no frame
  // in which a stale download button is enabled next to fresh rows.
  resetExtraction(s, 'a new analysis replaced the previous result');

  wireEntryExplorer(s);
  wireProjectActions(s);
  setStorageStatus(s);
}

function renderNotes(host, items, heading) {
  if (!host) return;
  clear(host);
  if (!items || !items.length) { host.hidden = true; return; }
  host.hidden = false;
  host.appendChild(el('h3', { text: heading }));
  const ul = el('ul');
  for (const i of items) ul.appendChild(el('li', { text: i }));
  host.appendChild(ul);
}

/* --------------------------------------------------------- entry explorer */

function wireEntryExplorer(s) {
  const filters = $('studio-filters');
  const search = $('studio-search');
  if (filters && !filters.dataset.wired) {
    filters.dataset.wired = '1';
    filters.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-filter]');
      if (!b) return;
      s.filter = b.dataset.filter; s.page = 0;
      for (const o of filters.querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
      renderEntries(s);
    });
  }
  if (search && !search.dataset.wired) {
    search.dataset.wired = '1';
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { s.query = search.value.trim().toLowerCase(); s.page = 0; renderEntries(s); }, 150);
    });
  }
  renderEntries(s);
}

function visibleEntries(s) {
  let list = s.project.entries;
  if (s.filter !== 'ALL') list = list.filter((e) => e.status === s.filter);
  if (s.query) list = list.filter((e) => e.name.toLowerCase().includes(s.query));
  return list;
}

// Paginated on purpose: the Phase 0 audit measured a 487 ms main-thread stall in
// Firefox when 10,000 rows were built at once. Pages keep every render small.
function renderEntries(s) {
  const body = $('studio-entries-body');
  const info = $('studio-entries-info');
  const pager = $('studio-pager');
  if (!body) return;
  clear(body);

  const list = visibleEntries(s);
  const per = Math.max(25, Math.min(1000, s.settings.entriesPerPage || 200));
  const pages = Math.max(1, Math.ceil(list.length / per));
  if (s.page >= pages) s.page = pages - 1;
  const from = s.page * per;
  const slice = list.slice(from, from + per);

  if (info) {
    info.textContent = list.length === 0
      ? t('entries.none')
      : `${t('entries.showing', { from: from + 1, to: from + slice.length, total: list.length })}`
        + (pages > 1 ? ` · ${t('entries.page', { page: s.page + 1, pages })}` : '');
  }

  const frag = document.createDocumentFragment();
  for (const e of slice) {
    // A native radio: keyboard-operable with no JavaScript key handling, exposed
    // to a screen reader as a real selection, and — importantly — selecting a row
    // never starts an extraction. That is a separate, explicit action.
    const radio = el('input', {
      type: 'radio', name: 'studio-entry-select', value: e.entryId,
      id: 'sel-' + e.entryId, class: 'st-entry-radio',
      checked: s.selectedEntryId === e.entryId,
    });
    radio.addEventListener('change', () => { selectEntry(s, e.entryId); });
    const label = el('label', { class: 'zc-visually-hidden', for: 'sel-' + e.entryId, text: `Select ${e.name}` });

    frag.appendChild(el('tr', {}, [
      el('td', {}, [radio, label]),
      el('td', { class: 'zc-name', text: e.name }),
      el('td', { text: e.methodName }),
      el('td', { text: fmtBytes(e.compressedSize) }),
      el('td', { text: fmtBytes(e.uncompressedSize) }),
      el('td', { class: 'zc-num', text: e.localHeaderOffset === null ? '—' : String(e.localHeaderOffset) }),
      el('td', { text: e.crcChecked ? (e.crcOk ? 'matched' : 'mismatch') : 'not verified' }),
      el('td', {}, statusPill(e.status, t('status.' + e.status))),
      el('td', { class: 'zc-reason', text: e.reasons.join('; ') || '—' }),
    ]));
  }
  body.appendChild(frag);

  if (pager) {
    clear(pager);
    if (pages > 1) {
      pager.hidden = false;
      pager.appendChild(el('button', {
        type: 'button', class: 'btn ghost st-sm', text: 'Previous', disabled: s.page === 0,
        onclick: () => { s.page--; renderEntries(s); },
      }));
      pager.appendChild(el('span', { class: 'note', text: ` ${s.page + 1} / ${pages} ` }));
      pager.appendChild(el('button', {
        type: 'button', class: 'btn ghost st-sm', text: 'Next', disabled: s.page >= pages - 1,
        onclick: () => { s.page++; renderEntries(s); },
      }));
    } else pager.hidden = true;
  }
}

/* ------------------------------------------------ verified single extraction */

// The extraction panel has one job that matters more than the rest: never leave
// an enabled download button pointing at bytes that are no longer the answer.
// Every path that changes what is on screen calls resetExtraction().

function extractLive(text, force = false) {
  const node = $('studio-extract-live');
  if (!node) return;
  if (!extractLive._announce) extractLive._announce = makeAnnouncer(node);
  extractLive._announce(text, force);
}

/** Drop any prepared output and return the panel to "nothing selected". */
function resetExtraction(s, reason) {
  s.output.revoke(reason || 'the workspace changed');
  s.selectedEntryId = null;
  s.extracting = false;
  const detail = $('studio-extract-detail');
  const none = $('studio-extract-none');
  if (detail) detail.hidden = true;
  if (none) { none.hidden = false; none.textContent = t('extract.none'); }
  // Only the containers this code FILLS are emptied. The progress element and
  // its label are static markup that lives in the HTML, so clearing their parent
  // would delete them for the rest of the session — which is exactly what it did
  // until the browser gate caught it.
  for (const id of ['studio-extract-result', 'studio-extract-error', 'studio-extract-reasons']) {
    const n = $(id);
    if (n) { n.hidden = true; clear(n); }
  }
  const progress = $('studio-extract-progress');
  if (progress) progress.hidden = true;
  const bar = $('studio-extract-bar');
  if (bar) bar.value = 0;
  const stage = $('studio-extract-stage');
  if (stage) stage.textContent = '';
  const runBtn = $('studio-extract-run');
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = t('extract.ready'); }
  const cancelBtn = $('studio-extract-cancel');
  if (cancelBtn) cancelBtn.hidden = true;
}

function selectEntry(s, entryId) {
  if (s.extracting) return;                        // a running task owns the panel
  s.output.revoke('a different entry was selected');
  s.selectedEntryId = entryId;
  renderExtractionPanel(s);
}

/** Show what the evidence allows for the selected entry, before anything runs. */
function renderExtractionPanel(s) {
  const host = $('studio-extract');
  if (!host || !s.project) return;
  const none = $('studio-extract-none');
  const detail = $('studio-extract-detail');
  const facts = $('studio-extract-facts');
  const reasonsBox = $('studio-extract-reasons');
  const runBtn = $('studio-extract-run');
  const resultBox = $('studio-extract-result');
  const errBox = $('studio-extract-error');
  if (!detail || !facts || !runBtn) return;

  const entry = s.project.entries.find((e) => e.entryId === s.selectedEntryId);
  if (!entry) { resetExtraction(s, 'no entry is selected'); return; }

  if (resultBox) { resultBox.hidden = true; clear(resultBox); }
  if (errBox) { errBox.hidden = true; clear(errBox); }
  none.hidden = true;
  detail.hidden = false;

  const gate = evaluateExtractionEligibility(s.project, entry, s.caps, s.policy, {
    activeExtraction: s.extracting,
  });

  clear(facts);
  const rows = [
    ['Archive path', entry.name],
    ['Saved as', gate.outputName || '—'],
    ['Evidence status', t('status.' + entry.status)],
    ['Compression', entry.methodName],
    ['Compressed size', fmtBytes(entry.compressedSize)],
    ['Expected output size', fmtBytes(entry.uncompressedSize)],
    ['Expected CRC-32', entry.declaredCrc32 === null ? '—' : crcHex(entry.declaredCrc32)],
    ['Extraction policy', gate.policyVersion],
  ];
  if (gate.filenameModified) {
    rows.push(['Why the name changed', gate.filenameReasons.join('; ') || 'normalised for this system']);
  }
  for (const [k, v] of rows) { facts.appendChild(el('dt', { text: k })); facts.appendChild(el('dd', { text: v })); }

  // Reasons and warnings are text, never colour alone, and they are inside a
  // role="status" region so a screen reader hears why a control is disabled.
  clear(reasonsBox);
  const notes = [];
  for (const r of gate.reasons) notes.push(`Cannot extract: ${r.message}`);
  for (const w of gate.warnings) notes.push(w);
  if (notes.length) {
    reasonsBox.hidden = false;
    reasonsBox.className = gate.eligible ? 'callout info' : 'callout warn';
    for (const nline of notes) reasonsBox.appendChild(el('p', { text: nline }));
  } else {
    reasonsBox.hidden = true;
  }

  runBtn.disabled = !gate.eligible || s.extracting;
  runBtn.textContent = gate.eligible ? t('extract.ready') : t('extract.unavailable');
  runBtn.setAttribute('aria-describedby', 'studio-extract-reasons');

  if (!runBtn.dataset.wired) {
    runBtn.dataset.wired = '1';
    runBtn.addEventListener('click', () => runExtraction(s));
  }
  const cancelBtn = $('studio-extract-cancel');
  if (cancelBtn && !cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = '1';
    cancelBtn.addEventListener('click', () => {
      if (!s.extracting) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = t('extract.cancelling');
      s.supervisor.cancel();
      extractLive('Cancelling the extraction.', true);
    });
  }
}

async function runExtraction(s) {
  const entry = s.project && s.project.entries.find((e) => e.entryId === s.selectedEntryId);
  if (!entry || s.extracting) return;

  const runBtn = $('studio-extract-run');
  const cancelBtn = $('studio-extract-cancel');
  const progress = $('studio-extract-progress');
  const bar = $('studio-extract-bar');
  const stage = $('studio-extract-stage');
  const resultBox = $('studio-extract-result');
  const errBox = $('studio-extract-error');

  // A prepared output from a previous run stops being the answer the moment a
  // new run starts.
  s.output.revoke('a new extraction started');
  s.extracting = true;
  runBtn.disabled = true;
  runBtn.textContent = t('extract.running');
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  cancelBtn.textContent = t('extract.cancel');
  progress.hidden = false;
  bar.value = 0;
  stage.textContent = EXTRACT_PHASE_LABEL.eligibility;
  resultBox.hidden = true; clear(resultBox);
  errBox.hidden = true; clear(errBox);
  extractLive(t('extract.started', { name: entry.name }), true);

  const startedAt = new Date().toISOString();
  let announcedHalf = false;

  try {
    const result = await s.supervisor.extractVerifiedEntry(
      s.file, entry.entryId,
      { project: s.project, projectId: s.project.id, plan: { entryId: entry.entryId } },
      (p) => {
        if (stage) stage.textContent = EXTRACT_PHASE_LABEL[p.phase] || p.phase || 'Working';
        if (bar && Number.isFinite(p.percent)) bar.value = Math.max(0, Math.min(100, p.percent));
        // One mid-point announcement, not one per chunk: a live region that
        // fires every 80 ms is unusable with a screen reader.
        if (!announcedHalf && Number.isFinite(p.percent) && p.percent >= 50) {
          announcedHalf = true;
          extractLive(t('extract.half'));
        }
      },
      () => { /* accepted: the panel already shows these facts */ }
    );

    s.output.adopt(result.blob, {
      filename: result.outputFilename,
      entryId: result.entryId,
      taskId: result.taskId,
      projectId: s.project.id,
      sourceKey: sourceKeyOf(s.file),
    });

    entry.operationStatus = OP_STATUS.EXTRACTED_VERIFIED;
    recordOperation(s.project, {
      entryId: result.entryId, entryName: result.entryName,
      evidenceStatusAtStart: result.evidenceStatus,
      operationStatus: OP_STATUS.EXTRACTED_VERIFIED,
      startedAt, finishedAt: new Date().toISOString(),
      engineVersion: result.engineVersion, policyVersion: result.policyVersion,
      sourceFingerprintMatch: 'exact',
      compressionMethod: result.compressionMethod,
      expectedSize: result.expectedOutputBytes, actualSize: result.outputBytesProduced,
      crcExpected: result.crcExpected, crcActual: result.crcActual, crcMatch: true,
      outputFilename: result.outputFilename, filenameModified: result.filenameModified,
      durationMs: result.durationMs, warnings: result.warnings, errorCode: '',
    });

    renderExtractionSuccess(s, result);
    extractLive(`Extraction verified. ${result.outputBytesProduced} bytes, checksum ${result.crcActualHex} matches. Ready to download.`, true);
  } catch (e) {
    const se = toStudioError(e, ERR.INTERNAL_EXTRACTION_ERROR);
    entry.operationStatus = se.code === ERR.CANCELLED ? OP_STATUS.CANCELLED : OP_STATUS.FAILED;
    recordOperation(s.project, {
      entryId: entry.entryId, entryName: entry.name,
      evidenceStatusAtStart: entry.status,
      operationStatus: entry.operationStatus,
      startedAt, finishedAt: new Date().toISOString(),
      engineVersion: '1.0.0', policyVersion: s.policy.policyVersion,
      compressionMethod: entry.method,
      expectedSize: entry.uncompressedSize, actualSize: null,
      crcExpected: entry.declaredCrc32, crcActual: null, crcMatch: false,
      outputFilename: '', filenameModified: false,
      durationMs: null, warnings: [], errorCode: se.code,
    });
    renderExtractionFailure(s, se);
    extractLive(se.code === ERR.CANCELLED
      ? 'Extraction cancelled. Nothing was produced.'
      : `Extraction failed. ${se.userMessage}`, true);
  } finally {
    s.extracting = false;
    progress.hidden = true;
    cancelBtn.hidden = true;
    // The evidence status is untouched by all of the above; only the operation
    // status moved. Re-render so the button reflects the new operation state.
    const stillEligible = evaluateExtractionEligibility(s.project, entry, s.caps, s.policy, {});
    runBtn.disabled = !stillEligible.eligible;
    runBtn.textContent = s.output.hasOutput ? t('extract.again') : t('extract.ready');
  }
}

function renderExtractionSuccess(s, result) {
  const box = $('studio-extract-result');
  if (!box) return;
  clear(box);
  box.hidden = false;
  box.appendChild(el('p', {}, [
    el('strong', { text: 'Extracted and verified. ' }),
    `The output is ${result.outputBytesProduced} bytes and its recomputed CRC-32 is `,
    el('span', { class: 'mono', text: result.crcActualHex }),
    ', which matches the ',
    el('span', { class: 'mono', text: result.crcExpectedHex }),
    ' recorded in the archive.',
  ]));
  const dl = el('dl', { class: 'zc-dl' });
  for (const [k, v] of [
    ['Download name', result.outputFilename],
    ['Archive path', result.entryName],
    ['Evidence status', `${result.evidenceStatus} (unchanged by this operation)`],
    ['Operation status', result.operationStatus],
    ['Size', `${result.outputBytesProduced} bytes (expected ${result.expectedOutputBytes})`],
    ['CRC-32 expected', result.crcExpectedHex],
    ['CRC-32 recomputed', result.crcActualHex],
    ['Elapsed', `${result.durationMs} ms`],
    ['Engine / policy', `${result.engineVersion} / ${result.policyVersion}`],
  ]) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); }
  box.appendChild(dl);

  const btn = el('button', {
    type: 'button', class: 'btn primary',
    text: `Download verified output (${result.outputFilename})`,
  });
  btn.addEventListener('click', () => {
    if (!s.output.hasOutput) {
      btn.disabled = true;
      btn.textContent = t('extract.expired');
      extractLive(t('extract.expired'), true);
      return;
    }
    if (!s.output.download()) {
      renderExtractionFailure(s, new StudioError(ERR.DOWNLOAD_PREPARATION_FAILED, { entryId: result.entryId }));
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Download started';
    extractLive(`Download of ${result.outputFilename} started.`, true);
  });
  box.appendChild(el('div', { class: 'cta cta-start' }, btn));

  for (const l of result.limitations) box.appendChild(el('p', { class: 'note', text: l }));
}

function renderExtractionFailure(s, se) {
  const box = $('studio-extract-error');
  if (!box) return;
  renderError(box, se);
  box.appendChild(el('p', {
    class: 'note',
    text: se.outputDiscarded
      ? 'Any bytes produced before the failure were discarded. Nothing partial is offered as a download.'
      : 'Nothing was produced, and your archive was not modified.',
  }));
  // Focus the error so a keyboard user is taken to the explanation rather than
  // left on a button whose label just changed underneath them.
  box.setAttribute('tabindex', '-1');
  try { box.focus({ preventScroll: false }); } catch { /* focus is best-effort */ }
}

/* -------------------------------------------------------- project actions */

function wireProjectActions(s) {
  const jsonBtn = $('studio-download-json');
  if (jsonBtn && !jsonBtn.dataset.wired) {
    jsonBtn.dataset.wired = '1';
    jsonBtn.addEventListener('click', () => {
      downloadText(reportName(s.project, 'json'), JSON.stringify(buildJsonReport(s.project), null, 2));
    });
  }
  const exportBtn = $('studio-export-project');
  if (exportBtn && !exportBtn.dataset.wired) {
    exportBtn.dataset.wired = '1';
    exportBtn.addEventListener('click', () => {
      downloadText(projectFileName(s.project), serializeProject(s.project));
    });
  }
  const saveBtn = $('studio-save-project');
  if (saveBtn) {
    const can = s.features.saveProjects.level === LEVEL.SUPPORTED;
    saveBtn.disabled = !can;
    saveBtn.title = can ? '' : s.features.saveProjects.why;
    if (!saveBtn.dataset.wired) {
      saveBtn.dataset.wired = '1';
      saveBtn.addEventListener('click', async () => {
        try {
          const saved = await s.store.saveProject(s.project);
          s.project = saved; s.saved = true;
          setStorageStatus(s, t('storage.durable'));
          saveBtn.textContent = 'Saved on this device';
          saveBtn.disabled = true;
        } catch (e) {
          renderError($('studio-error'), toStudioError(e, ERR.STORAGE_FAILED));
        }
      });
    }
  }
  const htmlBtn = $('studio-download-html');
  if (htmlBtn && !htmlBtn.dataset.wired) {
    htmlBtn.dataset.wired = '1';
    htmlBtn.addEventListener('click', () => {
      downloadText(reportName(s.project, 'html'), buildHtmlReport(s.project), 'text/html');
    });
  }
}

function reportName(p, ext) {
  const base = (p.source.name || 'archive').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return `veraqis-report-${base}.${ext}`;
}

/* ------------------------------------------------------------ report viewer */

function renderReports(s) {
  const input = $('studio-report-file');
  const pick = $('studio-report-pick');
  const out = $('studio-report-output');
  const errBox = $('studio-error');
  if (!input || !pick) return;

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    errBox.hidden = true;
    try {
      const { project, unknownFields } = await s.store.importProject(f);
      clear(out); out.hidden = false;

      const downgraded = project.entries.filter((e) => e.reasons.some((r) => r.startsWith('Downgraded on import'))).length;
      const notes = [];
      notes.push(t('import.untrusted'));
      if (downgraded) notes.push(t('import.downgraded', {}, downgraded));
      if (unknownFields.length) notes.push(t('import.unknownFields', {}, unknownFields.length));
      out.appendChild(el('div', { class: 'callout info' }, notes.map((n) => el('p', { text: n }))));

      const a = project.analysis;
      const c = a.counts || {};
      out.appendChild(el('h2', { text: project.source.name || 'Imported project' }));
      const dl = el('dl', { class: 'zc-dl' });
      for (const [k, v] of [
        ['Generator', `${project.generator} ${project.generatorVersion}`],
        ['Analysed', fmtDate(a.timestamp)],
        ['Engine', a.engine ? `${a.engine.id} ${a.engine.version}` : '—'],
        ['Source size', fmtBytes(project.source.size)],
        ['Verdict', a.verdict ? t('verdict.' + a.verdict) : '—'],
        ['Entries', `${c.total ?? 0} (${c.verified ?? 0} verified, ${c.damaged ?? 0} damaged, ${c.unknown ?? 0} unknown)`],
        ['CRC coverage', `${Math.round((a.crcCoverage || 0) * 100)}%`],
      ]) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); }
      out.appendChild(dl);

      const table = el('table');
      table.appendChild(el('thead', {}, el('tr', {}, [
        el('th', { scope: 'col', text: 'Name' }), el('th', { scope: 'col', text: 'CRC-32' }),
        el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Reason' }),
      ])));
      const tb = el('tbody');
      for (const e of project.entries.slice(0, 500)) {
        tb.appendChild(el('tr', {}, [
          el('td', { class: 'zc-name', text: e.name }),
          el('td', { text: e.crcChecked ? (e.crcOk ? 'matched' : 'mismatch') : 'not verified' }),
          el('td', {}, statusPill(e.status, t('status.' + e.status))),
          el('td', { class: 'zc-reason', text: e.reasons.join('; ') || '—' }),
        ]));
      }
      table.appendChild(tb);
      out.appendChild(el('div', { class: 'table-scroll' }, table));
      if (project.entries.length > 500) {
        out.appendChild(el('p', { class: 'note', text: `Showing the first 500 of ${project.entries.length} entries.` }));
      }
    } catch (e) {
      renderError(errBox, toStudioError(e, ERR.PROJECT_SCHEMA_INVALID));
      out.hidden = true;
    }
  });
}

/* ---------------------------------------------------------------- settings */

function renderSettings(s) {
  const form = $('studio-settings-form');
  if (!form) return;
  const bind = (id, key, type = 'checkbox') => {
    const n = $(id);
    if (!n) return;
    if (type === 'checkbox') n.checked = !!s.settings[key];
    else n.value = String(s.settings[key]);
    n.addEventListener('change', () => {
      s.settings[key] = type === 'checkbox' ? n.checked
        : type === 'number' ? Number(n.value) : n.value;
      saveSettings(s.settings);
      flash();
    });
  };
  bind('set-verify-crc', 'verifyCrc');
  bind('set-autosave', 'autoSaveProjects');
  bind('set-advanced', 'showAdvanced');
  bind('set-fingerprint', 'fingerprintMode', 'select');
  bind('set-per-page', 'entriesPerPage', 'number');
  bind('set-large-mb', 'largeFileConfirmMB', 'number');

  const reset = $('studio-reset-settings');
  if (reset) reset.addEventListener('click', () => {
    s.settings = resetSettings();
    location.reload();
  });

  const usage = $('studio-storage-usage');
  if (usage) {
    s.store.getStorageUsage().then((u) => {
      usage.textContent = `${u.projects} project(s) saved`
        + (u.bytes !== null ? `, about ${fmtBytes(u.bytes)} of metadata` : '')
        + (u.quotaBytes ? `, quota ${fmtBytes(u.quotaBytes)}` : '')
        + ` · backend: ${s.store.kind}`;
    }).catch(() => { usage.textContent = 'Storage usage is unavailable.'; });
  }

  const persistBtn = $('studio-request-persistence');
  if (persistBtn) persistBtn.addEventListener('click', async () => {
    const r = await s.store.requestPersistence();
    const out = $('studio-settings-result');
    clear(out); out.hidden = false;
    out.appendChild(el('p', { text: r.granted ? 'The browser will keep VERAQIS data unless you delete it.' : `Not granted: ${r.reason}` }));
  });

  function flash() {
    const out = $('studio-settings-result');
    if (!out) return;
    clear(out); out.hidden = false;
    out.appendChild(el('p', { text: 'Settings saved on this device.' }));
  }
}

function renderProjectView() {
  // The workspace is reached from an analysis in the same tab. A direct visit
  // has nothing in memory, which is correct: results are never in the URL, so
  // the empty state in the HTML is already the right thing to show.
}

export { buildHtmlReport, buildJsonReport };

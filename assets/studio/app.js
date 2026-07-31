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
  projectFileName, OP_STATUS,
} from './project.js';
import { StudioError, ERR, toStudioError } from './errors.js';
import { STAGE_LABEL } from './protocol.js';
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

  const state = {
    caps, features, sizes, store, settings,
    project: null,        // in-memory project (not persisted unless saved)
    file: null,           // the File the user selected this session
    saved: false,
    supervisor: null,
    page: 0,
    filter: 'ALL',
    query: '',
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
      if (state === 'crashed' && detail) announce(t('worker.crashed'), true);
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
    frag.appendChild(el('tr', {}, [
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

/* -------------------------------------------------------- project actions */

function wireProjectActions(s) {
  const jsonBtn = $('studio-download-json');
  if (jsonBtn && !jsonBtn.dataset.wired) {
    jsonBtn.dataset.wired = '1';
    jsonBtn.addEventListener('click', () => {
      downloadText(reportName(s.project, 'json'), JSON.stringify(s.project.analysisReport || s.project, null, 2));
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

/* ------------------------------------------------------------ HTML report */

// Standalone, no external resources, no scripts. Every user-controlled value is
// escaped here rather than interpolated raw.
function buildHtmlReport(p) {
  const esc = (v) => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const a = p.analysis;
  const c = a.counts || {};
  const rows = p.entries.map((e) => `<tr><td>${esc(e.name)}</td><td>${esc(e.methodName)}</td>`
    + `<td>${esc(e.compressedSize)}</td><td>${esc(e.uncompressedSize)}</td>`
    + `<td>${e.crcChecked ? (e.crcOk ? 'matched' : 'mismatch') : 'not verified'}</td>`
    + `<td>${esc(e.status)}</td><td>${esc(e.reasons.join('; '))}</td></tr>`).join('\n');
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
This report describes an analysis performed entirely in a browser. No file was uploaded.</p>
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
<tbody>${rows}</tbody></table>
<h2>Method and limits</h2>
<ul>${(p.limitations || []).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p class="note">An entry is VERIFIED only when its CRC-32 was recomputed from the archive's bytes and matched.
A matching CRC-32 is evidence against accidental damage; it is not a cryptographic signature.
This report contains no data from inside the analysed files.</p>
</body></html>`;
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

export { buildHtmlReport };
